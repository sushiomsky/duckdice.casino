const express = require("express");
const axios = require("axios");
const amqplib = require("amqplib");
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

const config = {
  port: Number(process.env.PORT || 4000),
  backendApiKey: getSecret("BACKEND_API_KEY", "duckdice-backend-key"),
  adminApiKey: getSecret("ADMIN_API_KEY", "duckdice-admin-key"),
  internalApiToken: getSecret("INTERNAL_API_TOKEN", "duckdice-internal-token"),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120),
  diceEngineUrl: process.env.DICE_ENGINE_URL || "http://dice-engine:4001",
  riskEngineUrl: process.env.RISK_ENGINE_URL || "http://risk-engine:4002",
  rabbitUrl: process.env.RABBITMQ_URL || "amqp://rabbitmq:5672",
  eventsExchange: process.env.EVENTS_EXCHANGE || "duckdice.events",
  postgresUrl: process.env.POSTGRES_URL || "postgres://duckdice:duckdice@postgres:5432/duckdice",
  redisUrl: process.env.REDIS_URL || "redis://redis:6379",
  cacheTtlSec: Number(process.env.BET_CACHE_TTL_SEC || 300)
};

const authState = {
  backendApiKey: config.backendApiKey,
  adminApiKey: config.adminApiKey
};

let rabbitChannel;
let pgPool;
let redisClient;

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

function internalRequestConfig() {
  return {
    timeout: 2000,
    headers: {
      "x-internal-token": config.internalApiToken
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

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "api-gateway",
    infra: {
      rabbitmq: Boolean(rabbitChannel),
      postgres: Boolean(pgPool),
      redis: Boolean(redisClient?.isReady)
    }
  });
});

app.use("/v1", requireApiKey("backend"), rateLimitMiddleware(config.rateLimitWindowMs, config.rateLimitMaxRequests));

app.post("/v1/admin/keys/rotate", requireApiKey("admin"), (req, res) => {
  const { target, newKey } = req.body;
  if (target !== "backend" && target !== "admin") {
    return res.status(400).json({ error: "invalid_target" });
  }
  if (typeof newKey !== "string" || newKey.trim().length < 16) {
    return res.status(400).json({ error: "invalid_new_key" });
  }

  const value = newKey.trim();
  if (target === "backend") {
    authState.backendApiKey = value;
  } else {
    authState.adminApiKey = value;
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
    const settleResponse = await axios.post(
      `${config.diceEngineUrl}/v1/settle`,
      req.body,
      internalRequestConfig()
    );
    const settlement = settleResponse.data;

    const riskResponse = await axios.post(
      `${config.riskEngineUrl}/v1/evaluate`,
      {
        requestedPayout: settlement.payout,
        commit: true
      },
      internalRequestConfig()
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
    const response = await axios.post(
      `${config.riskEngineUrl}/v1/release`,
      req.body,
      internalRequestConfig()
    );
    return res.status(200).json(response.data);
  } catch (error) {
    const detail = error.response?.data || { message: error.message };
    return res.status(400).json({ error: "release_failed", detail });
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

  app.listen(config.port, () => {
    console.log(`api-gateway listening on ${config.port}`);
  });
}

bootstrap().catch((err) => {
  console.error("api-gateway bootstrap failed", err);
  process.exit(1);
});
