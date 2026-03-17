const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createClient } = require("redis");

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

const config = {
  bankroll: Number(process.env.BANKROLL || 10000),
  maxPayoutPercent: Number(process.env.MAX_PAYOUT_PERCENT || 0.05),
  maxExposure: Number(process.env.MAX_EXPOSURE || 3000),
  internalApiToken,
  internalRequestSigningKey,
  internalAuthMaxSkewMs: Number(process.env.INTERNAL_AUTH_MAX_SKEW_MS || 30_000),
  internalReplayTtlMs: Number(process.env.INTERNAL_REPLAY_TTL_MS || 45_000),
  redisUrl: process.env.REDIS_URL || "redis://redis:6379"
};

let activeExposure = 0;
let redisClient;

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

function signaturesMatch(received, expected) {
  if (typeof received !== "string" || received.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function logInternalAuthFailure(req, reason) {
  console.warn("internal_auth_denied", JSON.stringify({
    service: "risk-engine",
    reason,
    method: req.method,
    path: req.originalUrl.split("?")[0],
    remoteIp: req.ip,
    timestamp: new Date().toISOString()
  }));
}

async function connectRedisWithRetry() {
  while (!redisClient) {
    try {
      const client = createClient({ url: config.redisUrl });
      client.on("error", (error) => {
        console.error("risk-engine redis client error", error.message);
      });
      await client.connect();
      await client.ping();
      redisClient = client;
      console.log("risk-engine connected to Redis");
    } catch (error) {
      console.error("risk-engine redis connection failed; retrying in 2s", error.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function consumeInternalRequest(requestId) {
  const key = `internal:req:risk:${requestId}`;
  const result = await redisClient.set(key, "1", { NX: true, PX: config.internalReplayTtlMs });
  return result === "OK";
}

async function internalAuth(req, res, next) {
  try {
    const token = req.header("x-internal-token");
    const timestamp = req.header("x-internal-timestamp");
    const requestId = req.header("x-internal-request-id");
    const signature = req.header("x-internal-signature");
    if (!token || token !== config.internalApiToken || !timestamp || !requestId || !signature || !isUuid(requestId)) {
      logInternalAuthFailure(req, "missing_or_invalid_headers");
      return res.status(401).json({ error: "unauthorized" });
    }

    const timestampMs = Number(timestamp);
    if (!Number.isInteger(timestampMs)) {
      logInternalAuthFailure(req, "invalid_timestamp");
      return res.status(401).json({ error: "unauthorized" });
    }
    if (Math.abs(Date.now() - timestampMs) > config.internalAuthMaxSkewMs) {
      logInternalAuthFailure(req, "timestamp_skew");
      return res.status(401).json({ error: "unauthorized" });
    }

    const expectedSignature = signInternalRequest({
      method: req.method,
      path: req.originalUrl.split("?")[0],
      timestamp,
      requestId,
      payload: req.body
    });
    if (!signaturesMatch(signature, expectedSignature)) {
      logInternalAuthFailure(req, "signature_mismatch");
      return res.status(401).json({ error: "unauthorized" });
    }

    const accepted = await consumeInternalRequest(requestId);
    if (!accepted) {
      logInternalAuthFailure(req, "request_replay");
      return res.status(401).json({ error: "unauthorized" });
    }

    return next();
  } catch (error) {
    logInternalAuthFailure(req, "auth_backend_unavailable");
    console.error("risk-engine internal auth unavailable", error.message);
    return res.status(503).json({ error: "internal_auth_unavailable" });
  }
}

function evaluateRisk(requestedPayout) {
  if (config.bankroll <= 0) return { accepted: false, reason: "invalid_bankroll", projectedExposure: activeExposure };

  const maxPayout = config.bankroll * config.maxPayoutPercent;
  if (requestedPayout > maxPayout) {
    return { accepted: false, reason: "max_payout_exceeded", projectedExposure: activeExposure };
  }

  const projectedExposure = activeExposure + requestedPayout;
  if (projectedExposure > config.maxExposure) {
    return { accepted: false, reason: "max_exposure_exceeded", projectedExposure };
  }

  return { accepted: true, projectedExposure };
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "risk-engine",
    activeExposure,
    config: {
      bankroll: config.bankroll,
      maxPayoutPercent: config.maxPayoutPercent,
      maxExposure: config.maxExposure
    },
    infra: {
      redis: Boolean(redisClient?.isReady)
    },
    security: {
      internalAuth: {
        tokenRequired: true,
        signatureRequired: true,
        requestIdRequired: true,
        maxSkewMs: config.internalAuthMaxSkewMs,
        hasDedicatedSigningKey: config.internalRequestSigningKey !== config.internalApiToken
      },
      replayProtection: {
        enabled: true,
        windowMs: config.internalReplayTtlMs,
        storeReady: Boolean(redisClient?.isReady)
      }
    }
  });
});

app.use("/v1", internalAuth);

app.post("/v1/evaluate", (req, res) => {
  const requestedPayout = Number(req.body.requestedPayout || 0);
  const commit = Boolean(req.body.commit);
  const decision = evaluateRisk(requestedPayout);

  if (decision.accepted && commit) {
    activeExposure = decision.projectedExposure;
  }

  res.status(200).json(decision);
});

app.post("/v1/release", (req, res) => {
  const amount = Number(req.body.amount || 0);
  activeExposure = Math.max(0, activeExposure - amount);
  res.status(200).json({ activeExposure });
});

async function bootstrap() {
  await connectRedisWithRetry();
  const port = Number(process.env.PORT || 4002);
  app.listen(port, () => {
    console.log(`risk-engine listening on ${port}`);
  });
}

bootstrap().catch((error) => {
  console.error("risk-engine bootstrap failed", error);
  process.exit(1);
});
