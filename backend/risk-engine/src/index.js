const express = require("express");

const app = express();
app.use(express.json());

const config = {
  bankroll: Number(process.env.BANKROLL || 10000),
  maxPayoutPercent: Number(process.env.MAX_PAYOUT_PERCENT || 0.05),
  maxExposure: Number(process.env.MAX_EXPOSURE || 3000),
  internalApiToken: process.env.INTERNAL_API_TOKEN || "duckdice-internal-token"
};

let activeExposure = 0;

function internalAuth(req, res, next) {
  const token = req.header("x-internal-token");
  if (!token || token !== config.internalApiToken) {
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
