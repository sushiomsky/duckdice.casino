# DuckDice Casino Protocol

Production-ready monorepo baseline for a provably-fair dice protocol.

## Packages
- `packages/dice-engine`: deterministic dice RNG + settlement.
- `packages/risk-engine`: bankroll and exposure controls.
- `services/api`: HTTP API for bet submission and resolution.
- `contracts`: EVM bankroll settlement contract.
- `packages/sdk`: typed API client.
- `packages/bots`: autonomous strategy bot implementations.

## Quickstart
```bash
npm install
npm test
```

## Autonomer Development Loop
1. Issue created
2. Codex analyzes repo
3. Codex writes code
4. Codex writes tests
5. Codex creates PR
6. Review + merge
