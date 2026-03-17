import { describe, expect, it } from "vitest";
import { calculateMaxBet, evaluateBet } from "../src/index.js";

describe("risk-engine", () => {
  const cfg = { bankroll: 1000, maxExposure: 200 };

  it("calculates max bet using bankroll, risk factor and multiplier", () => {
    expect(calculateMaxBet(1000, 2)).toBe(2.5);
    expect(calculateMaxBet(1000, 5, 0.01)).toBe(2);
  });

  it("accepts valid bets and tracks projected exposure", () => {
    const out = evaluateBet(cfg, { currentExposure: 25, betAmount: 2, multiplier: 2 });
    expect(out.accepted).toBe(true);
    expect(out.projectedExposure).toBe(29);
    expect(out.maxBet).toBe(2.5);
    expect(out.maxPayout).toBe(5);
  });

  it("rejects bets when emergency stop is enabled", () => {
    const out = evaluateBet(
      { bankroll: 1000, emergencyStop: true, maxExposure: 200 },
      { currentExposure: 0, betAmount: 2, multiplier: 2 },
    );
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("emergency_stop");
  });

  it("rejects when dynamic max bet is exceeded", () => {
    const out = evaluateBet(cfg, { currentExposure: 0, betAmount: 3, multiplier: 2 });
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("max_bet_exceeded");
  });

  it("rejects when max payout is exceeded", () => {
    const out = evaluateBet(
      { bankroll: 1000, maxPayout: 4, maxExposure: 200 },
      { currentExposure: 0, betAmount: 2.1, multiplier: 2 },
    );

    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("max_payout_exceeded");
  });

  it("rejects when projected exposure is exceeded", () => {
    const out = evaluateBet(cfg, { currentExposure: 198, betAmount: 2, multiplier: 2 });
    expect(out.accepted).toBe(false);
    expect(out.reason).toBe("max_exposure_exceeded");
  });
});
