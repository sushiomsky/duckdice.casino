const crypto = require("node:crypto");
const express = require("express");
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
  internalApiToken,
  internalRequestSigningKey,
  internalAuthMaxSkewMs: Number(process.env.INTERNAL_AUTH_MAX_SKEW_MS || 30_000),
  internalReplayTtlMs: Number(process.env.INTERNAL_REPLAY_TTL_MS || 45_000),
  redisUrl: process.env.REDIS_URL || "redis://redis:6379"
};

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

async function connectRedisWithRetry() {
  while (!redisClient) {
    try {
      const client = createClient({ url: config.redisUrl });
      client.on("error", (error) => {
        console.error("dice-engine redis client error", error.message);
      });
      await client.connect();
      await client.ping();
      redisClient = client;
      console.log("dice-engine connected to Redis");
    } catch (error) {
      console.error("dice-engine redis connection failed; retrying in 2s", error.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function consumeInternalRequest(requestId) {
  const key = `internal:req:dice:${requestId}`;
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
      return res.status(401).json({ error: "unauthorized" });
    }

    const timestampMs = Number(timestamp);
    if (!Number.isInteger(timestampMs)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (Math.abs(Date.now() - timestampMs) > config.internalAuthMaxSkewMs) {
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
      return res.status(401).json({ error: "unauthorized" });
    }

    const accepted = await consumeInternalRequest(requestId);
    if (!accepted) {
      return res.status(401).json({ error: "unauthorized" });
    }

    return next();
  } catch (error) {
    console.error("dice-engine internal auth unavailable", error.message);
    return res.status(503).json({ error: "internal_auth_unavailable" });
  }
}

function rollDice({ serverSeed, clientSeed, nonce }) {
  const payload = `${serverSeed}:${clientSeed}:${nonce}`;
  const proof = crypto.createHash("sha256").update(payload).digest("hex");
  const bucket = Number.parseInt(proof.slice(0, 13), 16);
  const max = 0x1fffffffffffff;
  const roll = Math.floor((bucket / max) * 10000) / 100;

  return { roll: Number(roll.toFixed(2)), proof };
}

function settleBet({ serverSeed, clientSeed, nonce, amount, target, houseEdgeBps = 100 }) {
  if (amount <= 0) throw new Error("amount must be positive");
  if (target < 1 || target > 99) throw new Error("target must be between 1 and 99");

  const { roll, proof } = rollDice({ serverSeed, clientSeed, nonce });
  const won = roll < target;
  const multiplier = (100 - houseEdgeBps / 100) / target;
  const payout = won ? Number((amount * multiplier).toFixed(8)) : 0;

  return { roll, won, payout, proof };
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "dice-engine" }));
app.use("/v1", internalAuth);

app.post("/v1/settle", (req, res) => {
  try {
    const result = settleBet(req.body);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

async function bootstrap() {
  await connectRedisWithRetry();
  const port = Number(process.env.PORT || 4001);
  app.listen(port, () => {
    console.log(`dice-engine listening on ${port}`);
  });
}

bootstrap().catch((error) => {
  console.error("dice-engine bootstrap failed", error);
  process.exit(1);
});
