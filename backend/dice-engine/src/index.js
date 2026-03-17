const crypto = require("node:crypto");
const express = require("express");
const fs = require("node:fs");

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
  internalAuthMaxSkewMs: Number(process.env.INTERNAL_AUTH_MAX_SKEW_MS || 30_000)
};

function hashInternalPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
}

function signInternalRequest({ method, path, timestamp, payload }) {
  const canonical = [
    method.toUpperCase(),
    path,
    timestamp,
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

function internalAuth(req, res, next) {
  const token = req.header("x-internal-token");
  const timestamp = req.header("x-internal-timestamp");
  const signature = req.header("x-internal-signature");
  if (!token || token !== config.internalApiToken || !timestamp || !signature) {
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
    payload: req.body
  });
  if (!signaturesMatch(signature, expectedSignature)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  return next();
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

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`dice-engine listening on ${port}`);
});
