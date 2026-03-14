# DuckDice Production Architecture

## Domains
- **Dice Engine (`packages/dice-engine`)**: deterministic, auditable RNG from server/client seeds + nonce.
- **Risk Engine (`packages/risk-engine`)**: exposure guardrails, max payout, bankroll safety checks.
- **API (`services/api`)**: stateless HTTP service that validates bets, calculates outcomes, and exposes health/proof endpoints.
- **Contracts (`contracts`)**: bankroll vault + settlement primitives for on-chain integration.
- **SDK (`packages/sdk`)**: typed integration client for apps and trading bots.
- **Bots (`packages/bots`)**: autonomous clients that run strategies against the API.

## Production Characteristics
- Shared TypeScript baseline and strict typing.
- Test coverage for business-critical paths (fairness, risk checks, API behavior, SDK and bot logic, smart contracts).
- Deterministic outcomes and reproducible proofs.
- Workspace structure for CI/CD and independent package releases.

## Service Interaction
1. Client submits bet through API or SDK.
2. API asks Risk Engine to validate exposure.
3. API resolves outcome with Dice Engine.
4. API emits settlement intent for contract execution.
5. Bots consume SDK and automate strategy loops.
