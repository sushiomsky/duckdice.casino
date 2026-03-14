import express from "express";
import { settleBet } from "@duckdice/dice-engine";
import { evaluateBet, type RiskConfig } from "@duckdice/risk-engine";

export interface ApiState {
  exposure: number;
  risk: RiskConfig;
}

export function createApp(state: ApiState) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", exposure: state.exposure });
  });

  app.post("/v1/bets", (req, res) => {
    const { serverSeed, clientSeed, nonce, amount, target } = req.body;
    try {
      const preview = settleBet({ serverSeed, clientSeed, nonce, amount, target });
      const risk = evaluateBet(state.risk, state.exposure, preview.payout);
      if (!risk.accepted) return res.status(422).json({ error: risk.reason });

      state.exposure = risk.projectedExposure;
      return res.status(201).json(preview);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp({
    exposure: 0,
    risk: { bankroll: 10_000, maxExposure: 3_000, maxPayoutPercent: 0.05 },
  });

  app.listen(port, () => {
    console.log(`DuckDice API running on :${port}`);
  });
}
