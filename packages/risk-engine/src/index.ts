export interface RiskConfig {
  bankroll: number;
  maxPayoutPercent: number;
  maxExposure: number;
}

export interface RiskDecision {
  accepted: boolean;
  reason?: string;
  projectedExposure: number;
}

export function evaluateBet(
  config: RiskConfig,
  activeExposure: number,
  requestedPayout: number,
): RiskDecision {
  if (config.bankroll <= 0) {
    return { accepted: false, reason: "invalid_bankroll", projectedExposure: activeExposure };
  }

  const maxPayout = config.bankroll * config.maxPayoutPercent;
  if (requestedPayout > maxPayout) {
    return {
      accepted: false,
      reason: "max_payout_exceeded",
      projectedExposure: activeExposure,
    };
  }

  const projectedExposure = activeExposure + requestedPayout;
  if (projectedExposure > config.maxExposure) {
    return {
      accepted: false,
      reason: "max_exposure_exceeded",
      projectedExposure,
    };
  }

  return { accepted: true, projectedExposure };
}
