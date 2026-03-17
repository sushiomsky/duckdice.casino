const express = require("express");
const crypto = require("node:crypto");
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
  bankroll: Number(process.env.BANKROLL || 10000),
  maxPayoutPercent: Number(process.env.MAX_PAYOUT_PERCENT || 0.05),
  maxExposure: Number(process.env.MAX_EXPOSURE || 3000),
  internalApiToken,
  internalRequestSigningKey,
  internalAuthMaxSkewMs: Number(process.env.INTERNAL_AUTH_MAX_SKEW_MS || 30_000)
};

let activeExposure = 0;

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

const port = Number(process.env.PORT || 4002);
app.listen(port, () => {
  console.log(`risk-engine listening on ${port}`);
});
