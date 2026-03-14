# DuckDice Casino Protocol

Scalable monorepo for a provably-fair crypto dice casino.

## New microservice architecture

### Backend services (`backend/*`)
- `backend/api-gateway`: external REST entrypoint, bet orchestration, publishes events.
- `backend/dice-engine`: deterministic RNG + payout settlement.
- `backend/risk-engine`: bankroll guardrails + exposure accounting.
- `backend/websocket`: websocket fan-out for real-time bet events.

### Smart contract (`contracts/bankroll`)
- `BankrollVault.sol`: liquidity custody + privileged settlement flow.

### SDKs (`sdk/*`)
- `sdk/js`: JavaScript client for gateway REST endpoints.
- `sdk/python`: Python package for gateway REST endpoints.

## Service communication
- REST calls: `api-gateway -> dice-engine`, `api-gateway -> risk-engine`.
- Message queue: `api-gateway -> RabbitMQ topic exchange -> websocket`.

## Run with Docker
```bash
docker compose up --build
```

- API Gateway: `http://localhost:4000`
- Dice Engine: `http://localhost:4001`
- Risk Engine: `http://localhost:4002`
- Websocket: `ws://localhost:4010`
- RabbitMQ UI: `http://localhost:15672` (guest/guest)
