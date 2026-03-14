export interface RiskConfig {
  bankroll: number;
  /**
   * Fraction of bankroll that can be risked per bet before multiplier scaling.
   * Defaults to 0.5%.
   */
  riskFactor?: number;
  /**
   * Optional hard cap for total open exposure. If not provided, bankroll is used.
   */
  maxExposure?: number;
  /**
   * Optional hard cap for any single payout. If not provided, bankroll * riskFactor is used.
   */
  maxPayout?: number;
}

export interface BetRiskInput {
  betAmount: number;
  multiplier: number;
  currentExposure: number;
}

export interface RiskDecision {
  accepted: boolean;
  reason?: "invalid_bankroll" | "invalid_bet" | "invalid_multiplier" | "max_bet_exceeded" | "max_payout_exceeded" | "max_exposure_exceeded";
  riskFactor: number;
  maxBet: number;
  maxPayout: number;
  maxExposure: number;
  requestedPayout: number;
  projectedExposure: number;
}

const DEFAULT_RISK_FACTOR = 0.005;

export function calculateMaxBet(bankroll: number, multiplier: number, riskFactor = DEFAULT_RISK_FACTOR): number {
  if (bankroll <= 0 || multiplier <= 0 || riskFactor <= 0) return 0;
  return bankroll * riskFactor / multiplier;
}

export function evaluateBet(config: RiskConfig, input: BetRiskInput): RiskDecision {
  const riskFactor = config.riskFactor ?? DEFAULT_RISK_FACTOR;
  const maxExposure = config.maxExposure ?? config.bankroll;
  const dynamicMaxPayout = config.maxPayout ?? (config.bankroll * riskFactor);

  const fail = (reason: RiskDecision["reason"], maxBet = 0, requestedPayout = 0): RiskDecision => ({
    accepted: false,
    reason,
    riskFactor,
    maxBet,
    maxPayout: dynamicMaxPayout,
    maxExposure,
    requestedPayout,
    projectedExposure: input.currentExposure,
  });

  if (config.bankroll <= 0) return fail("invalid_bankroll");
  if (input.betAmount <= 0) return fail("invalid_bet");
  if (input.multiplier <= 0) return fail("invalid_multiplier");

  const maxBet = calculateMaxBet(config.bankroll, input.multiplier, riskFactor);
  const requestedPayout = input.betAmount * input.multiplier;

  if (input.betAmount > maxBet) {
    return fail("max_bet_exceeded", maxBet, requestedPayout);
  }

  if (requestedPayout > dynamicMaxPayout) {
    return fail("max_payout_exceeded", maxBet, requestedPayout);
  }

  const projectedExposure = input.currentExposure + requestedPayout;
  if (projectedExposure > maxExposure) {
    return {
      accepted: false,
      reason: "max_exposure_exceeded",
      riskFactor,
      maxBet,
      maxPayout: dynamicMaxPayout,
      maxExposure,
      requestedPayout,
      projectedExposure,
    };
  }

  return {
    accepted: true,
    riskFactor,
    maxBet,
    maxPayout: dynamicMaxPayout,
    maxExposure,
    requestedPayout,
    projectedExposure,
  };
}
