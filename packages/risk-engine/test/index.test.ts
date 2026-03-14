import { describe, expect, it } from "vitest";
import { evaluateBet } from "../src/index.js";

describe("risk-engine", () => {
  const cfg = { bankroll: 1000, maxPayoutPercent: 0.1, maxExposure: 150 };

  it("accepts valid bets", () => {
    const out = evaluateBet(cfg, 25, 50);
    expect(out.accepted).toBe(true);
    expect(out.projectedExposure).toBe(75);
  });

  it("rejects max payout", () => {
    const out = evaluateBet(cfg, 0, 200);
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("max_payout_exceeded");
  });

  it("rejects max exposure", () => {
    const out = evaluateBet(cfg, 130, 30);
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("max_exposure_exceeded");
  });
});
