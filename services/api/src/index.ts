import express, { type NextFunction, type Request, type Response } from "express";
import { NonceTracker, settleBet } from "@duckdice/dice-engine";
import { evaluateBet, type RiskConfig } from "@duckdice/risk-engine";

export interface BetRequest {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  amount: number;
  chance?: number;
  target?: number;
  rollOver?: boolean;
  houseEdgeBps?: number;
}

export interface RollRecord {
  id: number;
  timestamp: string;
  amount: number;
  chance: number;
  rollOver: boolean;
  target: number;
  roll: number;
  won: boolean;
  payout: number;
  proof: string;
}

export interface ApiState {
  exposure: number;
  risk: RiskConfig;
  apiKey: string;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  rolls: RollRecord[];
}

interface ApiStats {
  totalBets: number;
  totalWagered: number;
  totalPayout: number;
  wins: number;
  losses: number;
  winRate: number;
  houseProfit: number;
}

function createDefaultState(): ApiState {
  return {
    exposure: 0,
    risk: { bankroll: 10_000, riskFactor: 0.05, maxExposure: 3_000, maxPayout: 500, emergencyStop: false },
    apiKey: process.env.API_KEY ?? "duckdice-dev-key",
    rateLimit: {
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
      maxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 60),
    },
    rolls: [],
  };
}

function apiKeyAuth(expectedApiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.header("x-api-key");
    if (!apiKey || apiKey !== expectedApiKey) {
      return res.status(401).json({ error: "unauthorized" });
    }

    return next();
  };
}

function rateLimitMiddleware(windowMs: number, maxRequests: number) {
  const requests = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}:${req.header("x-api-key") ?? ""}`;
    const now = Date.now();
    const existing = requests.get(key);

    if (!existing || now >= existing.resetAt) {
      requests.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (existing.count >= maxRequests) {
      return res.status(429).json({ error: "rate_limit_exceeded", retryAfterMs: existing.resetAt - now });
    }

    existing.count += 1;
    return next();
  };
}

function calculateStats(rolls: RollRecord[]): ApiStats {
  const wins = rolls.filter((roll) => roll.won).length;
  const totalWagered = rolls.reduce((sum, roll) => sum + roll.amount, 0);
  const totalPayout = rolls.reduce((sum, roll) => sum + roll.payout, 0);
  const totalBets = rolls.length;
  const losses = totalBets - wins;

  return {
    totalBets,
    totalWagered: Number(totalWagered.toFixed(8)),
    totalPayout: Number(totalPayout.toFixed(8)),
    wins,
    losses,
    winRate: totalBets === 0 ? 0 : Number(((wins / totalBets) * 100).toFixed(2)),
    houseProfit: Number((totalWagered - totalPayout).toFixed(8)),
  };
}

export function createApp(partialState?: Partial<ApiState>) {
  const base = createDefaultState();
  const state: ApiState = {
    ...base,
    ...partialState,
    risk: partialState?.risk ?? base.risk,
    rateLimit: partialState?.rateLimit ?? base.rateLimit,
    rolls: partialState?.rolls ?? base.rolls,
  };

  const app = express();
  const nonceTracker = new NonceTracker();
  app.use(express.json());
  app.use(rateLimitMiddleware(state.rateLimit.windowMs, state.rateLimit.maxRequests));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", exposure: state.exposure, emergencyStop: state.risk.emergencyStop ?? false });
  });

  app.use(apiKeyAuth(state.apiKey));

  const emergencyStopHandler = (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled?: unknown };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean" });
    }

    state.risk = {
      ...state.risk,
      emergencyStop: enabled,
    };

    return res.json({ emergencyStop: state.risk.emergencyStop });
  };

  app.post("/admin/emergency-stop", emergencyStopHandler);
  app.post("/v1/admin/emergency-stop", emergencyStopHandler);

  const createBetHandler = (req: Request, res: Response) => {
    const { serverSeed, clientSeed, nonce, amount, chance: rawChance, target, rollOver, houseEdgeBps } = req.body as BetRequest;
    try {
      const chance = rawChance ?? target;
      if (chance === undefined) {
        throw new Error("chance is required");
      }
      nonceTracker.track(serverSeed, clientSeed, nonce);
      const normalizedRollOver = rollOver ?? false;
      const edgeBps = houseEdgeBps ?? 100;
      const preview = settleBet({
        serverSeed,
        clientSeed,
        nonce,
        amount,
        chance,
        rollOver: normalizedRollOver,
        houseEdgeBps: edgeBps,
      });
      const multiplier = (100 / chance) * (1 - edgeBps / 10_000);
      const risk = evaluateBet(state.risk, {
        betAmount: amount,
        multiplier,
        currentExposure: state.exposure,
      });

      if (!risk.accepted) return res.status(422).json({ error: risk.reason, risk });

      state.exposure = risk.projectedExposure;
      const roll: RollRecord = {
        id: state.rolls.length + 1,
        timestamp: new Date().toISOString(),
        amount,
        chance,
        rollOver: normalizedRollOver,
        target: chance,
        ...preview,
      };

      state.rolls.push(roll);
      return res.status(201).json({ bet: roll, exposure: state.exposure });
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  };

  app.post("/bet", createBetHandler);
  app.post("/v1/bets", createBetHandler);

  const rollsHandler = (_req: Request, res: Response) => {
    return res.json({ rolls: state.rolls });
  };

  app.get("/rolls", rollsHandler);
  app.get("/v1/rolls", rollsHandler);

  const bankrollHandler = (_req: Request, res: Response) => {
    const available = Number((state.risk.bankroll - state.exposure).toFixed(8));
    const riskFactor = state.risk.riskFactor ?? 0.005;
    const maxPayout = state.risk.maxPayout ?? state.risk.bankroll * riskFactor;
    return res.json({
      bankroll: state.risk.bankroll,
      exposure: Number(state.exposure.toFixed(8)),
      available,
      maxExposure: state.risk.maxExposure,
      maxPayout: Number(maxPayout.toFixed(8)),
      emergencyStop: state.risk.emergencyStop ?? false,
    });
  };

  app.get("/bankroll", bankrollHandler);
  app.get("/v1/bankroll", bankrollHandler);

  app.get("/stats", (_req, res) => {
    return res.json({ stats: calculateStats(state.rolls) });
  });

  app.use((_req, res) => {
    return res.status(404).json({ error: "not_found" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp();

  app.listen(port, () => {
    console.log(`DuckDice API running on :${port}`);
  });
}
