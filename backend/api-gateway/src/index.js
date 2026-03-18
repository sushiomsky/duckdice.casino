const express = require("express");
const axios = require("axios");
const amqplib = require("amqplib");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { Pool } = require("pg");
const { createClient } = require("redis");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());

function getSecret(envName, fallback) {
  const filePath = process.env[`${envName}_FILE`];
  if (filePath) {
    return fs.readFileSync(filePath, "utf8").trim();
  }
  return process.env[envName] || fallback;
}

const internalApiToken = getSecret("INTERNAL_API_TOKEN", "duckdice-internal-token");
const internalRequestSigningKey = getSecret("INTERNAL_REQUEST_SIGNING_KEY", internalApiToken);
const internalCallTimeoutMs = Number(process.env.INTERNAL_CALL_TIMEOUT_MS || 2000);
const internalCallTimeoutWarningMs = Number(
  process.env.INTERNAL_CALL_TIMEOUT_WARNING_MS || Math.floor(internalCallTimeoutMs * 0.8)
);

const config = {
  port: Number(process.env.PORT || 4000),
  backendApiKey: getSecret("BACKEND_API_KEY", "duckdice-backend-key"),
  adminApiKey: getSecret("ADMIN_API_KEY", "duckdice-admin-key"),
  internalApiToken,
  internalRequestSigningKey,
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120),
  diceEngineUrl: process.env.DICE_ENGINE_URL || "http://dice-engine:4001",
  riskEngineUrl: process.env.RISK_ENGINE_URL || "http://risk-engine:4002",
  rabbitUrl: process.env.RABBITMQ_URL || "amqp://rabbitmq:5672",
  eventsExchange: process.env.EVENTS_EXCHANGE || "duckdice.events",
  postgresUrl: process.env.POSTGRES_URL || "postgres://duckdice:duckdice@postgres:5432/duckdice",
  redisUrl: process.env.REDIS_URL || "redis://redis:6379",
  cacheTtlSec: Number(process.env.BET_CACHE_TTL_SEC || 300),
  metricsRetentionMinutes: Number(process.env.METRICS_RETENTION_MINUTES || 2880),
  rateDiagnosticsScanLimit: Number(process.env.RATE_DIAGNOSTICS_SCAN_LIMIT || 1000),
  rateDiagnosticsMaxScanIterations: Number(process.env.RATE_DIAGNOSTICS_MAX_SCAN_ITERATIONS || 20),
  internalCallTimeoutMs,
  internalCallTimeoutWarningMs
};

const authState = {
  backendApiKey: config.backendApiKey,
  adminApiKey: config.adminApiKey
};
const AUTH_STATE_KEY = "auth:keys";
const METRIC_PREFIX = "metrics";
const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000];
const TIMEOUT_ERROR_LABELS = new Set(["econnaborted", "etimedout", "timeout"]);
const ENDPOINT_METRIC_LABELS = {
  post_bets: "POST /v1/bets",
  post_exposure_release: "POST /v1/exposure/release",
  post_admin_keys_rotate: "POST /v1/admin/keys/rotate",
  get_admin_actions: "GET /v1/admin/actions",
  get_admin_stats: "GET /v1/admin/stats",
  get_bets: "GET /v1/bets",
  get_bet_by_id: "GET /v1/bets/:betId",
  other: "other"
};

let rabbitChannel;
let pgPool;
let redisClient;
let authStateLoaded = false;

async function connectRabbitWithRetry() {
  while (!rabbitChannel) {
    try {
      const conn = await amqplib.connect(config.rabbitUrl);
      rabbitChannel = await conn.createChannel();
      await rabbitChannel.assertExchange(config.eventsExchange, "topic", { durable: true });
      console.log("api-gateway connected to RabbitMQ");
    } catch (err) {
      console.error("api-gateway rabbit connection failed; retrying in 2s", err.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function connectPostgresWithRetry() {
  while (!pgPool) {
    try {
      const pool = new Pool({
        connectionString: config.postgresUrl
      });
      await pool.query("SELECT 1");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bets (
          bet_id UUID PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL,
          request_payload JSONB NOT NULL,
          settlement JSONB,
          risk JSONB,
          error_detail JSONB
        );
      `);
      await pool.query("CREATE INDEX IF NOT EXISTS bets_created_at_idx ON bets (created_at DESC)");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_actions (
          action_id UUID PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL,
          actor_key_hash TEXT NOT NULL,
          action TEXT NOT NULL,
          details JSONB NOT NULL
        );
      `);
      await pool.query("CREATE INDEX IF NOT EXISTS admin_actions_created_at_idx ON admin_actions (created_at DESC)");
      pgPool = pool;
      console.log("api-gateway connected to PostgreSQL");
    } catch (err) {
      console.error("api-gateway postgres connection failed; retrying in 2s", err.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function connectRedisWithRetry() {
  while (!redisClient) {
    try {
      const client = createClient({ url: config.redisUrl });
      client.on("error", (error) => {
        console.error("api-gateway redis client error", error.message);
      });
      await client.connect();
      await client.ping();
      redisClient = client;
      console.log("api-gateway connected to Redis");
    } catch (err) {
      console.error("api-gateway redis connection failed; retrying in 2s", err.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function publishEvent(routingKey, payload) {
  if (!rabbitChannel) return;
  rabbitChannel.publish(config.eventsExchange, routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    persistent: true
  });
  incrementMetric(`event_published:${routingKey}`).catch((error) => {
    console.error("event metric increment failed", error.message);
  });
}

function toDetail(error) {
  return error.response?.data || { message: error.message };
}

function dbRowToBet(row) {
  return {
    betId: row.bet_id,
    createdAt: row.created_at,
    status: row.status,
    request: row.request_payload,
    settlement: row.settlement,
    risk: row.risk,
    error: row.error_detail
  };
}

function adminRowToAction(row) {
  return {
    actionId: row.action_id,
    createdAt: row.created_at,
    actorKeyHash: row.actor_key_hash,
    action: row.action,
    details: row.details
  };
}

function minuteBucket(timestampMs) {
  return Math.floor(timestampMs / 60_000);
}

function metricKey(name, bucket) {
  return `${METRIC_PREFIX}:${name}:${bucket}`;
}

function latencyBucketLabel(latencyMs) {
  for (const bound of LATENCY_BUCKETS_MS) {
    if (latencyMs <= bound) {
      return `le_${bound}`;
    }
  }
  return "gt_5000";
}

async function incrementMetric(name, timestampMs = Date.now()) {
  const bucket = minuteBucket(timestampMs);
  const key = metricKey(name, bucket);
  const count = await redisClient.incr(key);
  if (count === 1) {
    await redisClient.expire(key, config.metricsRetentionMinutes * 60);
  }
}

async function incrementMetricBy(name, amount, timestampMs = Date.now()) {
  const bucket = minuteBucket(timestampMs);
  const key = metricKey(name, bucket);
  const count = await redisClient.incrBy(key, amount);
  if (count === amount) {
    await redisClient.expire(key, config.metricsRetentionMinutes * 60);
  }
}

async function sumMetric(name, lookbackMinutes, timestampMs = Date.now()) {
  const bounded = Math.max(1, Math.min(lookbackMinutes, config.metricsRetentionMinutes));
  const latestBucket = minuteBucket(timestampMs);
  const keys = [];
  for (let i = 0; i < bounded; i += 1) {
    keys.push(metricKey(name, latestBucket - i));
  }

  const values = await redisClient.mGet(keys);
  return values.reduce((sum, value) => sum + Number.parseInt(value || "0", 10), 0);
}

function perMinuteRate(count, lookbackMinutes) {
  return Number((count / lookbackMinutes).toFixed(4));
}

function metricComparison(current, previous) {
  const delta = current - previous;
  return {
    current,
    previous,
    delta,
    deltaPct: previous > 0 ? Number((delta / previous).toFixed(4)) : null
  };
}

function mapMetricComparisons(currentMap, previousMap) {
  const keys = new Set([...Object.keys(currentMap), ...Object.keys(previousMap)]);
  return Object.fromEntries(
    [...keys]
      .sort()
      .map((key) => [
        key,
        metricComparison(currentMap[key] || 0, previousMap[key] || 0)
      ])
  );
}

function endpointMetricKey(method, path) {
  const normalizedPath = path.startsWith("/v1")
    ? path
    : `/v1${path.startsWith("/") ? path : `/${path}`}`;
  const upperMethod = method.toUpperCase();
  if (upperMethod === "POST" && normalizedPath === "/v1/bets") return "post_bets";
  if (upperMethod === "POST" && normalizedPath === "/v1/exposure/release") return "post_exposure_release";
  if (upperMethod === "POST" && normalizedPath === "/v1/admin/keys/rotate") return "post_admin_keys_rotate";
  if (upperMethod === "GET" && normalizedPath === "/v1/admin/actions") return "get_admin_actions";
  if (upperMethod === "GET" && normalizedPath === "/v1/admin/stats") return "get_admin_stats";
  if (upperMethod === "GET" && normalizedPath === "/v1/bets") return "get_bets";
  if (upperMethod === "GET" && isUuid(normalizedPath.replace("/v1/bets/", "")) && normalizedPath.startsWith("/v1/bets/")) {
    return "get_bet_by_id";
  }
  return "other";
}

function statusClass(statusCode) {
  return `${Math.floor(statusCode / 100)}xx`;
}

function toComparableEndpointCounts(byKey) {
  return Object.fromEntries(
    Object.entries(byKey).map(([key, count]) => [ENDPOINT_METRIC_LABELS[key] || key, count])
  );
}

function buildStatsAlerts({ lookbackMinutes, rateLimitExceeded, failedByReason, internalCalls, eventsPublished }) {
  const alerts = [];

  if (rateLimitExceeded > 0) {
    alerts.push({
      level: "warning",
      code: "rate_limit_exceeded_activity",
      message: `${rateLimitExceeded} rate-limit exceedances in the last ${lookbackMinutes} minutes.`
    });
  }

  const failedBetTotal = Object.values(failedByReason).reduce((sum, count) => sum + count, 0);
  if (failedBetTotal > 0) {
    const [topReason, topCount] = Object.entries(failedByReason)[0] || ["unknown", failedBetTotal];
    alerts.push({
      level: "warning",
      code: "failed_bets_detected",
      message: `${failedBetTotal} failed bets in the last ${lookbackMinutes} minutes.`,
      details: {
        topReason,
        count: topCount
      }
    });
  }

  for (const [name, metrics] of Object.entries(internalCalls)) {
    if (metrics.errors > 0 && metrics.errorRate >= 0.01) {
      alerts.push({
        level: "warning",
        code: "internal_call_error_rate_high",
        message: `${name} error rate is ${(metrics.errorRate * 100).toFixed(2)}% over last ${lookbackMinutes} minutes.`,
        details: {
          calls: metrics.calls,
          errors: metrics.errors
        }
      });
    }
  }

  if (eventsPublished.error > 0) {
    alerts.push({
      level: "warning",
      code: "error_events_published",
      message: `${eventsPublished.error} bet.error events published in the last ${lookbackMinutes} minutes.`
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      level: "info",
      code: "no_alerts",
      message: `No elevated operational signals in the last ${lookbackMinutes} minutes.`
    });
  }

  return alerts;
}

function buildStatsSummary({ lookbackMinutes, alerts, betByStatus, requestVolumes, internalCalls, eventsPublished }) {
  const accepted = betByStatus.accepted || 0;
  const rejected = betByStatus.rejected || 0;
  const errored = betByStatus.error || 0;
  const totalBets = Object.values(betByStatus).reduce((sum, count) => sum + count, 0);

  const internalCallEntries = Object.entries(internalCalls);
  const internalTotalCalls = internalCallEntries.reduce((sum, [, metrics]) => sum + metrics.calls, 0);
  const internalTotalErrors = internalCallEntries.reduce((sum, [, metrics]) => sum + metrics.errors, 0);
  const internalTimeoutErrors = internalCallEntries.reduce(
    (sum, [, metrics]) => sum + countTimeoutErrors(metrics.errorByType || {}),
    0
  );
  const noisiestInternalCall = internalCallEntries
    .map(([name, metrics]) => ({
      name,
      errorRate: metrics.errorRate,
      calls: metrics.calls,
      errors: metrics.errors
    }))
    .sort((a, b) => b.errorRate - a.errorRate)[0] || null;

  const warningAlerts = alerts.filter((alert) => alert.level === "warning");
  const totalEvents = eventsPublished.total || 0;

  return {
    health: warningAlerts.length > 0 ? "warning" : "ok",
    alertCodes: alerts.map((alert) => alert.code),
    lookbackMinutes,
    requests: {
      total: requestVolumes.total,
      ratePerMinute: perMinuteRate(requestVolumes.total, lookbackMinutes)
    },
    bets: {
      total: totalBets,
      accepted,
      rejected,
      error: errored,
      acceptanceRate: totalBets > 0 ? Number((accepted / totalBets).toFixed(4)) : null
    },
    events: {
      totalPublished: totalEvents,
      ratePerMinute: perMinuteRate(totalEvents, lookbackMinutes)
    },
    internalCalls: {
      total: internalTotalCalls,
      errors: internalTotalErrors,
      errorRate: internalTotalCalls > 0 ? Number((internalTotalErrors / internalTotalCalls).toFixed(4)) : 0,
      timeoutErrors: internalTimeoutErrors,
      timeoutErrorRate: internalTotalCalls > 0 ? Number((internalTimeoutErrors / internalTotalCalls).toFixed(4)) : 0,
      noisiestEndpoint: noisiestInternalCall
    }
  };
}

function buildStatsTriage({ lookbackMinutes, requestVolumes, failedByReason, internalCalls, topN }) {
  const triageTopN = Math.max(1, Math.min(topN, 10));
  const totalRequests = requestVolumes.total || 0;
  const totalFailed = Object.values(failedByReason).reduce((sum, count) => sum + count, 0);

  const requestHotspots = Object.entries(requestVolumes.byEndpoint || {})
    .map(([endpoint, metrics]) => {
      const total = Number(metrics?.total || 0);
      const s4 = Number(metrics?.status?.["4xx"] || 0);
      const s5 = Number(metrics?.status?.["5xx"] || 0);
      return {
        endpoint,
        total,
        shareOfRequests: totalRequests > 0 ? Number((total / totalRequests).toFixed(4)) : 0,
        status4xxRate: total > 0 ? Number((s4 / total).toFixed(4)) : 0,
        status5xxRate: total > 0 ? Number((s5 / total).toFixed(4)) : 0
      };
    })
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, triageTopN);

  const internalHotspots = Object.entries(internalCalls)
    .map(([endpoint, metrics]) => {
      const timeoutErrors = countTimeoutErrors(metrics.errorByType || {});
      const nearTimeoutRate = Number(metrics?.timeoutBudget?.nearTimeoutRate || 0);
      const timeoutErrorRate = metrics.calls > 0 ? Number((timeoutErrors / metrics.calls).toFixed(4)) : 0;
      const riskScore = Number(((metrics.errorRate * 5) + (timeoutErrorRate * 3) + (nearTimeoutRate * 2)).toFixed(4));
      return {
        endpoint,
        calls: metrics.calls,
        errors: metrics.errors,
        errorRate: metrics.errorRate,
        timeoutErrors,
        timeoutErrorRate,
        nearTimeoutRate,
        p95LatencyMs: metrics.p95LatencyMs,
        riskScore
      };
    })
    .filter((entry) => entry.calls > 0 || entry.errors > 0 || entry.timeoutErrors > 0 || entry.nearTimeoutRate > 0)
    .sort((a, b) => (b.riskScore - a.riskScore) || (b.calls - a.calls))
    .slice(0, triageTopN);

  const failedReasonHotspots = Object.entries(failedByReason)
    .map(([reason, count]) => ({
      reason,
      code: normalizeErrorTypeLabel(reason),
      count,
      shareOfFailed: totalFailed > 0 ? Number((count / totalFailed).toFixed(4)) : 0
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, triageTopN);

  const recommendedActions = [];
  const high5xxRequest = requestHotspots.find((entry) => entry.status5xxRate > 0);
  if (high5xxRequest) {
    recommendedActions.push({
      code: "check_gateway_dependency_errors",
      message: `Investigate ${high5xxRequest.endpoint}; observed ${Math.round(high5xxRequest.status5xxRate * 100)}% 5xx responses in the last ${lookbackMinutes} minutes.`
    });
  }

  const timeoutRisk = internalHotspots.find((entry) => entry.timeoutErrorRate > 0 || entry.nearTimeoutRate >= 0.01);
  if (timeoutRisk) {
    recommendedActions.push({
      code: "check_internal_timeout_budget",
      message: `Review ${timeoutRisk.endpoint}; timeout/near-timeout pressure detected over the last ${lookbackMinutes} minutes.`
    });
  }

  const errorRateRisk = internalHotspots.find((entry) => entry.errorRate >= 0.01);
  if (errorRateRisk) {
    recommendedActions.push({
      code: "check_internal_service_health",
      message: `Review ${errorRateRisk.endpoint}; error rate is ${(errorRateRisk.errorRate * 100).toFixed(2)}% in the last ${lookbackMinutes} minutes.`
    });
  }

  if (failedReasonHotspots.length > 0) {
    recommendedActions.push({
      code: `review_failed_reason_${failedReasonHotspots[0].code}`,
      message: `Top failure reason is "${failedReasonHotspots[0].reason}" with ${failedReasonHotspots[0].count} occurrences in the last ${lookbackMinutes} minutes.`
    });
  }

  if (recommendedActions.length === 0) {
    recommendedActions.push({
      code: "no_immediate_action",
      message: `No high-signal triage actions detected in the last ${lookbackMinutes} minutes.`
    });
  }

  return {
    requestHotspots,
    internalHotspots,
    failedReasonHotspots,
    recommendedActions
  };
}

function parseRateLimitKey(key) {
  if (!key.startsWith("rate:")) {
    return null;
  }

  const remainder = key.slice("rate:".length);
  const splitIndex = remainder.lastIndexOf(":");
  if (splitIndex < 0) {
    return null;
  }

  const ip = remainder.slice(0, splitIndex) || "unknown";
  const apiKey = remainder.slice(splitIndex + 1);
  return {
    ip,
    apiKeyHashPrefix: apiKey ? hashApiKey(apiKey).slice(0, 12) : null
  };
}

function normalizeErrorTypeLabel(rawLabel) {
  if (typeof rawLabel !== "string" || rawLabel.trim() === "") {
    return "unknown";
  }

  const normalized = rawLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "unknown";
  }

  return normalized.slice(0, 48);
}

function classifyInternalCallError(error) {
  const direct = error?.response?.data?.error;
  if (typeof direct === "string" && direct.trim() !== "") {
    return normalizeErrorTypeLabel(direct);
  }

  const detailReason = error?.response?.data?.detail?.reason;
  if (typeof detailReason === "string" && detailReason.trim() !== "") {
    return normalizeErrorTypeLabel(detailReason);
  }

  const detailError = error?.response?.data?.detail?.error;
  if (typeof detailError === "string" && detailError.trim() !== "") {
    return normalizeErrorTypeLabel(detailError);
  }

  if (typeof error?.code === "string" && error.code.trim() !== "") {
    return normalizeErrorTypeLabel(error.code);
  }

  return normalizeErrorTypeLabel(error?.message);
}

function latencyPercentileFromBuckets(buckets, percentile) {
  const total = Object.values(buckets).reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return null;
  }

  const target = Math.ceil(total * percentile);
  let seen = 0;
  for (const bound of LATENCY_BUCKETS_MS) {
    seen += buckets[`le_${bound}`] || 0;
    if (seen >= target) {
      return bound;
    }
  }
  return 5000;
}

async function persistBet(record) {
  await pgPool.query(
    `
      INSERT INTO bets (bet_id, created_at, status, request_payload, settlement, risk, error_detail)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
    `,
    [
      record.betId,
      record.createdAt,
      record.status,
      JSON.stringify(record.request),
      JSON.stringify(record.settlement ?? null),
      JSON.stringify(record.risk ?? null),
      JSON.stringify(record.error ?? null)
    ]
  );
}

async function cacheBet(record) {
  await redisClient.set(`bet:${record.betId}`, JSON.stringify(record), { EX: config.cacheTtlSec });
}

async function persistAuthStateToRedis() {
  await redisClient.set(AUTH_STATE_KEY, JSON.stringify({
    backendApiKey: authState.backendApiKey,
    adminApiKey: authState.adminApiKey,
    updatedAt: new Date().toISOString()
  }));
}

async function loadAuthStateFromRedis() {
  const raw = await redisClient.get(AUTH_STATE_KEY);
  if (!raw) {
    await persistAuthStateToRedis();
    authStateLoaded = true;
    return;
  }

  const parsed = JSON.parse(raw);
  if (
    !parsed
    || typeof parsed.backendApiKey !== "string"
    || typeof parsed.adminApiKey !== "string"
    || parsed.backendApiKey.length < 16
    || parsed.adminApiKey.length < 16
  ) {
    throw new Error("invalid auth state in redis");
  }

  authState.backendApiKey = parsed.backendApiKey;
  authState.adminApiKey = parsed.adminApiKey;
  authStateLoaded = true;
}

function hashApiKey(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashInternalPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
}

function signInternalRequest({ method, path, timestamp, requestId, payload }) {
  const canonical = [
    method.toUpperCase(),
    path,
    timestamp,
    requestId,
    hashInternalPayload(payload)
  ].join("\n");
  return crypto.createHmac("sha256", config.internalRequestSigningKey).update(canonical).digest("hex");
}

async function recordAdminAction(action, actorApiKey, details) {
  await pgPool.query(
    `
      INSERT INTO admin_actions (action_id, created_at, actor_key_hash, action, details)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [uuidv4(), new Date().toISOString(), hashApiKey(actorApiKey), action, JSON.stringify(details)]
  );
  try {
    await incrementMetric(`admin_action:${action}`);
  } catch (error) {
    console.error("admin action metric increment failed", error.message);
  }
}

async function recordInternalCallMetrics(name, startedAtMs, success, errorType) {
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const bucketLabel = latencyBucketLabel(elapsedMs);
  const errorTypeKey = errorType ? `internal_call:${name}:error_type:${errorType}` : null;
  const errorTypeIndexKey = `metric_index:internal_call:${name}:error_types`;
  try {
    const actions = [
      incrementMetric(`internal_call:${name}:count`),
      incrementMetricBy(`internal_call:${name}:latency_ms_sum`, elapsedMs),
      incrementMetric(`internal_call:${name}:latency_bucket:${bucketLabel}`),
      success ? Promise.resolve() : incrementMetric(`internal_call:${name}:error`)
    ];
    if (elapsedMs >= config.internalCallTimeoutWarningMs) {
      actions.push(incrementMetric(`internal_call:${name}:near_timeout`));
    }

    if (!success && errorTypeKey) {
      actions.push(incrementMetric(errorTypeKey));
      actions.push(redisClient.sAdd(errorTypeIndexKey, errorType));
      actions.push(redisClient.expire(errorTypeIndexKey, config.metricsRetentionMinutes * 60));
    }

    await Promise.all(actions);
  } catch (error) {
    console.error("internal call metric increment failed", error.message);
  }
}

async function postInternalService(name, url, payload, path) {
  const startedAtMs = Date.now();
  try {
    const response = await axios.post(
      url,
      payload,
      internalRequestConfig({
        method: "POST",
        path,
        payload
      })
    );
    await recordInternalCallMetrics(name, startedAtMs, true, null);
    return response;
  } catch (error) {
    await recordInternalCallMetrics(name, startedAtMs, false, classifyInternalCallError(error));
    throw error;
  }
}

async function readInternalCallErrorBreakdown(name, lookbackMinutes, topN = 5) {
  const indexKey = `metric_index:internal_call:${name}:error_types`;
  const labels = await redisClient.sMembers(indexKey);
  if (!labels || labels.length === 0) {
    return {};
  }

  const counts = await Promise.all(
    labels.map((label) => sumMetric(`internal_call:${name}:error_type:${label}`, lookbackMinutes))
  );
  return Object.fromEntries(
    labels
      .map((label, index) => [label, counts[index]])
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
  );
}

async function recordEndpointRequestMetrics(metricKey, statusCode) {
  try {
    await Promise.all([
      incrementMetric(`endpoint_request:${metricKey}:count`),
      incrementMetric(`endpoint_request:${metricKey}:status:${statusClass(statusCode)}`)
    ]);
  } catch (error) {
    console.error("endpoint request metric increment failed", error.message);
  }
}

function countTimeoutErrors(errorByType) {
  return Object.entries(errorByType)
    .filter(([type]) => TIMEOUT_ERROR_LABELS.has(type))
    .reduce((sum, [, count]) => sum + count, 0);
}

async function readInternalCallTelemetry(name, lookbackMinutes, includeTimeoutDiagnostics = false) {
  const [calls, errors, latencyMsSum, errorByType, nearTimeoutCalls, ...bucketValues] = await Promise.all([
    sumMetric(`internal_call:${name}:count`, lookbackMinutes),
    sumMetric(`internal_call:${name}:error`, lookbackMinutes),
    sumMetric(`internal_call:${name}:latency_ms_sum`, lookbackMinutes),
    readInternalCallErrorBreakdown(name, lookbackMinutes),
    sumMetric(`internal_call:${name}:near_timeout`, lookbackMinutes),
    ...LATENCY_BUCKETS_MS.map((bound) => sumMetric(`internal_call:${name}:latency_bucket:le_${bound}`, lookbackMinutes)),
    sumMetric(`internal_call:${name}:latency_bucket:gt_5000`, lookbackMinutes)
  ]);

  const buckets = Object.fromEntries([
    ...LATENCY_BUCKETS_MS.map((bound, index) => [`le_${bound}`, bucketValues[index]]),
    ["gt_5000", bucketValues[bucketValues.length - 1]]
  ]);
  const latencySampleCount = Object.values(buckets).reduce((sum, count) => sum + count, 0);

  const avgLatencyMs = calls > 0 ? Number((latencyMsSum / calls).toFixed(2)) : 0;
  const errorRate = calls > 0 ? Number((errors / calls).toFixed(4)) : 0;
  const timeoutErrors = countTimeoutErrors(errorByType);
  const timeoutBudget = includeTimeoutDiagnostics
    ? {
      budgetMs: config.internalCallTimeoutMs,
      warningThresholdMs: config.internalCallTimeoutWarningMs,
      nearTimeoutCalls,
      nearTimeoutRate: calls > 0 ? Number((nearTimeoutCalls / calls).toFixed(4)) : 0,
      timeoutErrors,
      timeoutErrorRate: calls > 0 ? Number((timeoutErrors / calls).toFixed(4)) : 0
    }
    : undefined;

  return {
    calls,
    errors,
    errorRate,
    avgLatencyMs,
    latencySampleCount,
    errorByType,
    p50LatencyMs: latencyPercentileFromBuckets(buckets, 0.5),
    p95LatencyMs: latencyPercentileFromBuckets(buckets, 0.95),
    latencyBuckets: buckets,
    timeoutBudget
  };
}

async function readEndpointRequestTelemetry(lookbackMinutes, timestampMs = Date.now()) {
  const entries = await Promise.all(
    Object.entries(ENDPOINT_METRIC_LABELS).map(async ([key, label]) => {
      const [total, s2, s4, s5] = await Promise.all([
        sumMetric(`endpoint_request:${key}:count`, lookbackMinutes, timestampMs),
        sumMetric(`endpoint_request:${key}:status:2xx`, lookbackMinutes, timestampMs),
        sumMetric(`endpoint_request:${key}:status:4xx`, lookbackMinutes, timestampMs),
        sumMetric(`endpoint_request:${key}:status:5xx`, lookbackMinutes, timestampMs)
      ]);
      return {
        key,
        label,
        total,
        status: {
          "2xx": s2,
          "4xx": s4,
          "5xx": s5
        }
      };
    })
  );

  const active = entries.filter((entry) => entry.total > 0);
  const byEndpoint = Object.fromEntries(
    active.map((entry) => [entry.label, { total: entry.total, status: entry.status }])
  );
  const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry.total]));
  const total = entries.reduce((sum, entry) => sum + entry.total, 0);
  return {
    total,
    byEndpoint,
    byKey
  };
}

async function readRateLimitDiagnostics(topN) {
  let cursor = "0";
  const keySet = new Set();
  let scanIterations = 0;
  do {
    scanIterations += 1;
    const scanResult = await redisClient.scan(cursor, {
      MATCH: "rate:*",
      COUNT: 100
    });
    cursor = scanResult.cursor;
    for (const key of scanResult.keys) {
      keySet.add(key);
      if (keySet.size >= config.rateDiagnosticsScanLimit) {
        break;
      }
    }
    if (keySet.size >= config.rateDiagnosticsScanLimit) {
      break;
    }
    if (scanIterations >= config.rateDiagnosticsMaxScanIterations) {
      break;
    }
  } while (cursor !== "0");

  const sampledKeys = Array.from(keySet).slice(0, config.rateDiagnosticsScanLimit);
  if (sampledKeys.length === 0) {
    return {
      sampledKeys: 0,
      truncated: cursor !== "0",
      top: []
    };
  }

  const counts = await redisClient.mGet(sampledKeys);
  const entries = sampledKeys
    .map((key, index) => {
      const count = Number.parseInt(counts[index] || "0", 10);
      if (!Number.isFinite(count) || count <= 0) {
        return null;
      }
      const parsed = parseRateLimitKey(key);
      if (!parsed) {
        return null;
      }
      return {
        redisKey: key,
        ip: parsed.ip,
        apiKeyHashPrefix: parsed.apiKeyHashPrefix,
        count
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count);

  const top = entries.slice(0, topN);
  const ttlValues = await Promise.all(top.map((entry) => redisClient.pTTL(entry.redisKey)));

  return {
    sampledKeys: sampledKeys.length,
    truncated: cursor !== "0",
    top: top.map((entry, index) => ({
      ip: entry.ip,
      apiKeyHashPrefix: entry.apiKeyHashPrefix,
      count: entry.count,
      ttlMs: ttlValues[index]
    }))
  };
}

function internalRequestConfig({ method, path, payload }) {
  const timestamp = Date.now().toString();
  const requestId = uuidv4();
  return {
    timeout: config.internalCallTimeoutMs,
    headers: {
      "x-internal-token": config.internalApiToken,
      "x-internal-timestamp": timestamp,
      "x-internal-request-id": requestId,
      "x-internal-signature": signInternalRequest({
        method,
        path,
        timestamp,
        requestId,
        payload
      })
    }
  };
}

function requireApiKey(scope) {
  return (req, res, next) => {
    const apiKey = req.header("x-api-key");
    if (!apiKey) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const isAdmin = apiKey === authState.adminApiKey;
    const isBackend = apiKey === authState.backendApiKey;
    const allowed = scope === "admin" ? isAdmin : (isAdmin || isBackend);
    if (!allowed) {
      return res.status(401).json({ error: "unauthorized" });
    }

    req.auth = {
      isAdmin,
      isBackend,
      apiKey
    };
    return next();
  };
}

function rateLimitMiddleware(windowMs, maxRequests) {
  return async (req, res, next) => {
    const key = `rate:${req.ip}:${req.header("x-api-key") || ""}`;

    try {
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.pExpire(key, windowMs);
      }

      const ttlMs = await redisClient.pTTL(key);
      if (count > maxRequests) {
        try {
          await incrementMetric("rate_limit_exceeded");
        } catch (metricError) {
          console.error("rate limit metric increment failed", metricError.message);
        }
        return res.status(429).json({
          error: "rate_limit_exceeded",
          retryAfterMs: ttlMs > 0 ? ttlMs : windowMs
        });
      }

      return next();
    } catch (error) {
      console.error("rate limit backend unavailable", error.message);
      return res.status(503).json({ error: "rate_limit_unavailable" });
    }
  };
}

function validateBetPayload(payload) {
  if (!payload || typeof payload !== "object") return "invalid_payload";
  if (typeof payload.serverSeed !== "string" || payload.serverSeed.trim() === "") return "invalid_server_seed";
  if (typeof payload.clientSeed !== "string" || payload.clientSeed.trim() === "") return "invalid_client_seed";
  if (!Number.isInteger(payload.nonce) || payload.nonce < 0) return "invalid_nonce";
  if (typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0) return "invalid_amount";
  if (typeof payload.target !== "number" || !Number.isFinite(payload.target) || payload.target < 1 || payload.target > 99) {
    return "invalid_target";
  }
  return null;
}

function validateReleasePayload(payload) {
  if (!payload || typeof payload !== "object") return "invalid_payload";
  if (typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0) return "invalid_amount";
  return null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

app.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "duckdice-api-gateway",
    message: "DuckDice backend is running.",
    endpoints: {
      health: "/health",
      bets: "/v1/bets"
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "api-gateway",
    infra: {
      rabbitmq: Boolean(rabbitChannel),
      postgres: Boolean(pgPool),
      redis: Boolean(redisClient?.isReady)
    },
    security: {
      apiKeyScopes: {
        backend: true,
        admin: true
      },
      internalAuth: {
        tokenRequired: true,
        signatureRequired: true,
        requestIdRequired: true,
        hasDedicatedSigningKey: config.internalRequestSigningKey !== config.internalApiToken
      },
      keyState: {
        redisBacked: true,
        loaded: authStateLoaded
      }
    }
  });
});

app.use("/v1", requireApiKey("backend"), rateLimitMiddleware(config.rateLimitWindowMs, config.rateLimitMaxRequests));
app.use("/v1", (req, res, next) => {
  const metricKey = endpointMetricKey(req.method, req.path);
  res.on("finish", () => {
    recordEndpointRequestMetrics(metricKey, res.statusCode);
  });
  next();
});

app.post("/v1/admin/keys/rotate", requireApiKey("admin"), async (req, res) => {
  const { target, newKey } = req.body;
  if (target !== "backend" && target !== "admin") {
    return res.status(400).json({ error: "invalid_target" });
  }
  if (typeof newKey !== "string" || newKey.trim().length < 16) {
    return res.status(400).json({ error: "invalid_new_key" });
  }

  const value = newKey.trim();
  const previousState = { ...authState };
  const previousHash = target === "backend" ? hashApiKey(authState.backendApiKey) : hashApiKey(authState.adminApiKey);
  if (target === "backend") {
    authState.backendApiKey = value;
  } else {
    authState.adminApiKey = value;
  }

  try {
    await persistAuthStateToRedis();
    await recordAdminAction("key_rotate", req.auth.apiKey, {
      target,
      previousHash,
      newHash: hashApiKey(value)
    });
  } catch (error) {
    authState.backendApiKey = previousState.backendApiKey;
    authState.adminApiKey = previousState.adminApiKey;
    try {
      await persistAuthStateToRedis();
    } catch (rollbackError) {
      console.error("auth state rollback failed", rollbackError.message);
    }
    return res.status(500).json({ error: "key_rotation_failed", detail: toDetail(error) });
  }

  return res.status(200).json({ rotated: target, updatedAt: new Date().toISOString() });
});

app.post("/v1/bets", async (req, res) => {
  const validationError = validateBetPayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const betId = uuidv4();
  const createdAt = new Date().toISOString();
  const requestPayload = { ...req.body };

  try {
    const settleResponse = await postInternalService(
      "dice_settle",
      `${config.diceEngineUrl}/v1/settle`,
      req.body,
      "/v1/settle"
    );
    const settlement = settleResponse.data;

    const riskPayload = {
      requestedPayout: settlement.payout,
      commit: true
    };
    const riskResponse = await postInternalService(
      "risk_evaluate",
      `${config.riskEngineUrl}/v1/evaluate`,
      riskPayload,
      "/v1/evaluate"
    );
    const risk = riskResponse.data;
    const betRecord = {
      betId,
      createdAt,
      request: requestPayload,
      settlement,
      risk
    };

    if (!risk.accepted) {
      const rejectedRecord = { ...betRecord, status: "rejected", error: { reason: risk.reason } };
      await persistBet(rejectedRecord);
      await cacheBet(rejectedRecord);
      publishEvent("bet.rejected", { ...requestPayload, betId, createdAt, settlement, risk });
      return res.status(422).json({ betId, error: risk.reason, risk });
    }

    const acceptedRecord = { ...betRecord, status: "accepted", error: null };
    await persistBet(acceptedRecord);
    await cacheBet(acceptedRecord);
    publishEvent("bet.accepted", { ...requestPayload, betId, createdAt, settlement, risk });
    return res.status(201).json({ betId, settlement, risk });
  } catch (error) {
    const detail = toDetail(error);
    const errorRecord = {
      betId,
      createdAt,
      status: "error",
      request: requestPayload,
      settlement: null,
      risk: null,
      error: detail
    };
    await persistBet(errorRecord);
    await cacheBet(errorRecord);
    publishEvent("bet.error", { ...requestPayload, betId, createdAt, detail });
    return res.status(400).json({ error: "bet_processing_failed", detail });
  }
});

app.post("/v1/exposure/release", requireApiKey("admin"), async (req, res) => {
  const validationError = validateReleasePayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const response = await postInternalService(
      "risk_release",
      `${config.riskEngineUrl}/v1/release`,
      req.body,
      "/v1/release"
    );
    try {
      await recordAdminAction("exposure_release", req.auth.apiKey, { amount: req.body.amount });
    } catch (error) {
      return res.status(500).json({ error: "audit_log_failed", detail: toDetail(error) });
    }
    return res.status(200).json(response.data);
  } catch (error) {
    const detail = error.response?.data || { message: error.message };
    return res.status(400).json({ error: "release_failed", detail });
  }
});

app.get("/v1/admin/actions", requireApiKey("admin"), async (req, res) => {
  const rawLimit = req.query.limit;
  const parsed = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
    return res.status(400).json({ error: "invalid_limit" });
  }

  try {
    const query = await pgPool.query(
      {
        text: `
          SELECT action_id, created_at, actor_key_hash, action, details
          FROM admin_actions
          ORDER BY created_at DESC
          LIMIT $1
        `,
        values: [parsed]
      },
    );
    return res.status(200).json({ actions: query.rows.map(adminRowToAction) });
  } catch (error) {
    return res.status(500).json({ error: "admin_actions_failed", detail: toDetail(error) });
  }
});

app.get("/v1/admin/stats", requireApiKey("admin"), async (req, res) => {
  const rawLookbackMinutes = req.query.lookbackMinutes;
  const rawIncludeRateLimitDetails = req.query.includeRateLimitDetails;
  const rawComparePreviousWindow = req.query.comparePreviousWindow;
  const rawIncludeTimeoutDiagnostics = req.query.includeTimeoutDiagnostics;
  const rawTopN = req.query.topN;
  const rawFields = req.query.fields;
  const lookbackMinutes = rawLookbackMinutes === undefined ? 60 : Number(rawLookbackMinutes);
  if (!Number.isInteger(lookbackMinutes) || lookbackMinutes <= 0 || lookbackMinutes > config.metricsRetentionMinutes) {
    return res.status(400).json({ error: "invalid_lookback_minutes" });
  }
  let includeRateLimitDetails = false;
  if (rawIncludeRateLimitDetails !== undefined) {
    if (rawIncludeRateLimitDetails === "true" || rawIncludeRateLimitDetails === "1") {
      includeRateLimitDetails = true;
    } else if (rawIncludeRateLimitDetails === "false" || rawIncludeRateLimitDetails === "0") {
      includeRateLimitDetails = false;
    } else {
      return res.status(400).json({ error: "invalid_include_rate_limit_details" });
    }
  }
  let comparePreviousWindow = false;
  if (rawComparePreviousWindow !== undefined) {
    if (rawComparePreviousWindow === "true" || rawComparePreviousWindow === "1") {
      comparePreviousWindow = true;
    } else if (rawComparePreviousWindow === "false" || rawComparePreviousWindow === "0") {
      comparePreviousWindow = false;
    } else {
      return res.status(400).json({ error: "invalid_compare_previous_window" });
    }
  }
  let includeTimeoutDiagnostics = false;
  if (rawIncludeTimeoutDiagnostics !== undefined) {
    if (rawIncludeTimeoutDiagnostics === "true" || rawIncludeTimeoutDiagnostics === "1") {
      includeTimeoutDiagnostics = true;
    } else if (rawIncludeTimeoutDiagnostics === "false" || rawIncludeTimeoutDiagnostics === "0") {
      includeTimeoutDiagnostics = false;
    } else {
      return res.status(400).json({ error: "invalid_include_timeout_diagnostics" });
    }
  }
  const topN = rawTopN === undefined ? 10 : Number(rawTopN);
  if (!Number.isInteger(topN) || topN <= 0 || topN > 50) {
    return res.status(400).json({ error: "invalid_top_n" });
  }
  const allowedFields = new Set(["rateLimit", "adminActions", "internalCalls", "bets", "events", "alerts", "comparison", "requestVolumes", "summary", "triage"]);
  let fieldsFilter = null;
  if (rawFields !== undefined) {
    const requested = String(rawFields)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (requested.length === 0 || requested.some((field) => !allowedFields.has(field))) {
      return res.status(400).json({ error: "invalid_fields" });
    }
    fieldsFilter = requested;
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const since = new Date(nowMs - lookbackMinutes * 60_000).toISOString();
  const previousSince = new Date(nowMs - (lookbackMinutes * 2) * 60_000).toISOString();
  try {
    const [
      rateLimitExceeded,
      rateLimitDiagnostics,
      adminTotalQuery,
      previousAdminTotalQuery,
      adminByActionQuery,
      betByStatusQuery,
      previousBetByStatusQuery,
      failedByReasonQuery,
      diceSettleMetrics,
      riskEvaluateMetrics,
      riskReleaseMetrics,
      requestVolumes,
      previousRequestVolumes,
      acceptedEvents,
      rejectedEvents,
      errorEvents,
      previousRateLimitExceeded,
      previousAcceptedEvents,
      previousRejectedEvents,
      previousErrorEvents
    ] = await Promise.all([
      sumMetric("rate_limit_exceeded", lookbackMinutes),
      includeRateLimitDetails ? readRateLimitDiagnostics(topN) : null,
      pgPool.query("SELECT COUNT(*)::int AS count FROM admin_actions WHERE created_at >= $1", [since]),
      comparePreviousWindow
        ? pgPool.query(
          "SELECT COUNT(*)::int AS count FROM admin_actions WHERE created_at >= $1 AND created_at < $2",
          [previousSince, since]
        )
        : null,
      pgPool.query(
        `
          SELECT action, COUNT(*)::int AS count
          FROM admin_actions
          WHERE created_at >= $1
          GROUP BY action
          ORDER BY action
        `,
        [since]
      ),
      pgPool.query(
        `
          SELECT status, COUNT(*)::int AS count
          FROM bets
          WHERE created_at >= $1
          GROUP BY status
          ORDER BY status
        `,
        [since]
      ),
      comparePreviousWindow
        ? pgPool.query(
          `
            SELECT status, COUNT(*)::int AS count
            FROM bets
            WHERE created_at >= $1
              AND created_at < $2
            GROUP BY status
            ORDER BY status
          `,
          [previousSince, since]
        )
        : null,
      pgPool.query(
        `
          SELECT
            COALESCE(
              error_detail->>'reason',
              error_detail->>'error',
              error_detail->'detail'->>'reason',
              error_detail->'detail'->>'error',
              error_detail->'detail'->>'message',
              error_detail->>'message',
              'unknown'
            ) AS reason,
            COUNT(*)::int AS count
          FROM bets
          WHERE created_at >= $1
            AND status IN ('rejected', 'error')
          GROUP BY reason
          ORDER BY count DESC, reason
        `,
        [since]
      ),
      readInternalCallTelemetry("dice_settle", lookbackMinutes, includeTimeoutDiagnostics),
      readInternalCallTelemetry("risk_evaluate", lookbackMinutes, includeTimeoutDiagnostics),
      readInternalCallTelemetry("risk_release", lookbackMinutes, includeTimeoutDiagnostics),
      readEndpointRequestTelemetry(lookbackMinutes),
      comparePreviousWindow
        ? readEndpointRequestTelemetry(lookbackMinutes, nowMs - lookbackMinutes * 60_000)
        : null,
      sumMetric("event_published:bet.accepted", lookbackMinutes),
      sumMetric("event_published:bet.rejected", lookbackMinutes),
      sumMetric("event_published:bet.error", lookbackMinutes),
      comparePreviousWindow
        ? sumMetric("rate_limit_exceeded", lookbackMinutes, nowMs - lookbackMinutes * 60_000)
        : null,
      comparePreviousWindow
        ? sumMetric("event_published:bet.accepted", lookbackMinutes, nowMs - lookbackMinutes * 60_000)
        : null,
      comparePreviousWindow
        ? sumMetric("event_published:bet.rejected", lookbackMinutes, nowMs - lookbackMinutes * 60_000)
        : null,
      comparePreviousWindow
        ? sumMetric("event_published:bet.error", lookbackMinutes, nowMs - lookbackMinutes * 60_000)
        : null
    ]);

    const adminByAction = Object.fromEntries(
      adminByActionQuery.rows.map((row) => [row.action, Number(row.count)])
    );
    const betByStatus = Object.fromEntries(
      betByStatusQuery.rows.map((row) => [row.status, Number(row.count)])
    );
    const failedByReason = Object.fromEntries(
      failedByReasonQuery.rows.map((row) => [row.reason, Number(row.count)])
    );
    const internalCalls = {
      diceSettle: diceSettleMetrics,
      riskEvaluate: riskEvaluateMetrics,
      riskRelease: riskReleaseMetrics
    };
    const totalEvents = acceptedEvents + rejectedEvents + errorEvents;
    const eventsPublished = {
      accepted: acceptedEvents,
      rejected: rejectedEvents,
      error: errorEvents,
      total: totalEvents
    };
    const alerts = buildStatsAlerts({
      lookbackMinutes,
      rateLimitExceeded,
      failedByReason,
      internalCalls,
      eventsPublished
    });
    const summary = buildStatsSummary({
      lookbackMinutes,
      alerts,
      betByStatus,
      requestVolumes,
      internalCalls,
      eventsPublished
    });
    const triage = buildStatsTriage({
      lookbackMinutes,
      requestVolumes,
      failedByReason,
      internalCalls,
      topN
    });
    const comparison = comparePreviousWindow
      ? (() => {
        const previousBetByStatus = Object.fromEntries(
          previousBetByStatusQuery.rows.map((row) => [row.status, Number(row.count)])
        );
        const previousEventsTotal = previousAcceptedEvents + previousRejectedEvents + previousErrorEvents;
        return {
          window: {
            current: {
              from: since,
              to: nowIso
            },
            previous: {
              from: previousSince,
              to: since
            }
          },
          rateLimitExceeded: metricComparison(rateLimitExceeded, previousRateLimitExceeded),
          adminActionsTotal: metricComparison(
            Number(adminTotalQuery.rows[0]?.count || 0),
            Number(previousAdminTotalQuery.rows[0]?.count || 0)
          ),
          eventsPublished: {
            accepted: metricComparison(acceptedEvents, previousAcceptedEvents),
            rejected: metricComparison(rejectedEvents, previousRejectedEvents),
            error: metricComparison(errorEvents, previousErrorEvents),
            total: metricComparison(totalEvents, previousEventsTotal)
          },
          betsByStatus: mapMetricComparisons(betByStatus, previousBetByStatus),
          requestVolumesByEndpoint: mapMetricComparisons(
            toComparableEndpointCounts(requestVolumes.byKey),
            toComparableEndpointCounts(previousRequestVolumes.byKey)
          )
        };
      })()
      : undefined;

    const responsePayload = {
      generatedAt: nowIso,
      lookbackMinutes,
      rateLimit: {
        windowMs: config.rateLimitWindowMs,
        maxRequests: config.rateLimitMaxRequests,
        exceeded: rateLimitExceeded,
        diagnostics: includeRateLimitDetails ? rateLimitDiagnostics : undefined
      },
      adminActions: {
        total: Number(adminTotalQuery.rows[0]?.count || 0),
        byAction: adminByAction
      },
      internalCalls,
      requestVolumes: {
        total: requestVolumes.total,
        byEndpoint: requestVolumes.byEndpoint
      },
      bets: {
        byStatus: betByStatus,
        failedByReason
      },
      events: {
        published: eventsPublished,
        ratePerMinute: {
          accepted: perMinuteRate(acceptedEvents, lookbackMinutes),
          rejected: perMinuteRate(rejectedEvents, lookbackMinutes),
          error: perMinuteRate(errorEvents, lookbackMinutes),
          total: perMinuteRate(totalEvents, lookbackMinutes)
        }
      },
      alerts,
      summary,
      triage,
      comparison
    };
    if (!fieldsFilter) {
      return res.status(200).json(responsePayload);
    }

    const filteredPayload = {
      generatedAt: responsePayload.generatedAt,
      lookbackMinutes: responsePayload.lookbackMinutes
    };
    for (const field of fieldsFilter) {
      filteredPayload[field] = responsePayload[field];
    }
    return res.status(200).json(filteredPayload);
  } catch (error) {
    return res.status(500).json({ error: "admin_stats_failed", detail: toDetail(error) });
  }
});

app.get("/v1/bets/:betId", async (req, res) => {
  const { betId } = req.params;
  if (!isUuid(betId)) {
    return res.status(400).json({ error: "invalid_bet_id" });
  }

  try {
    const cached = await redisClient.get(`bet:${betId}`);
    if (cached) {
      return res.status(200).json({ source: "redis", bet: JSON.parse(cached) });
    }

    const query = await pgPool.query(
      `
        SELECT bet_id, created_at, status, request_payload, settlement, risk, error_detail
        FROM bets
        WHERE bet_id = $1
      `,
      [betId]
    );

    if (query.rowCount === 0) {
      return res.status(404).json({ error: "bet_not_found" });
    }

    const bet = dbRowToBet(query.rows[0]);
    await cacheBet(bet);
    return res.status(200).json({ source: "postgres", bet });
  } catch (error) {
    return res.status(500).json({ error: "bet_lookup_failed", detail: toDetail(error) });
  }
});

app.get("/v1/bets", async (req, res) => {
  const rawLimit = req.query.limit;
  const parsed = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
    return res.status(400).json({ error: "invalid_limit" });
  }
  const limit = parsed;

  try {
    const query = await pgPool.query(
      `
        SELECT bet_id, created_at, status, request_payload, settlement, risk, error_detail
        FROM bets
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );
    return res.status(200).json({
      bets: query.rows.map(dbRowToBet)
    });
  } catch (error) {
    return res.status(500).json({ error: "bet_list_failed", detail: toDetail(error) });
  }
});

async function bootstrap() {
  await Promise.all([
    connectRabbitWithRetry(),
    connectPostgresWithRetry(),
    connectRedisWithRetry()
  ]);
  await loadAuthStateFromRedis();

  app.listen(config.port, () => {
    console.log(`api-gateway listening on ${config.port}`);
  });
}

bootstrap().catch((err) => {
  console.error("api-gateway bootstrap failed", err);
  process.exit(1);
});
