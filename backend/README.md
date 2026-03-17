# DuckDice Backend Microservices

## Services
- **api-gateway**: Public REST API for bet creation and exposure lifecycle.
- **dice-engine**: Deterministic roll + payout settlement service.
- **risk-engine**: Real-time risk checks and exposure tracking.
- **websocket**: Streams bet events to connected clients.

## Communication Pattern
1. `api-gateway` receives bet requests via REST (`POST /v1/bets`).
2. `api-gateway` calls `dice-engine` via REST for settlement preview.
3. `api-gateway` calls `risk-engine` via REST for acceptance and exposure commit.
4. `api-gateway` publishes `bet.accepted`, `bet.rejected`, or `bet.error` to RabbitMQ topic exchange.
5. `websocket` consumes `bet.*` events and broadcasts them to browser/mobile clients.

This split allows horizontal scaling for latency-sensitive paths (`dice-engine`) and independent scaling for stateful workloads (`risk-engine`, websocket fan-out).

## Data Layer
- `api-gateway` persists each processed bet to PostgreSQL (`bets` table).
- `api-gateway` caches bet lookups in Redis for fast read-through access.
- `api-gateway` protects `/v1/*` routes with scoped `x-api-key` auth (backend/admin) and Redis-backed rate limiting.
- `dice-engine` and `risk-engine` protect `/v1/*` routes with `x-internal-token` plus HMAC-signed request headers and timestamp skew checks for service-to-service access.
- Backend secrets can be injected via env vars or file-based variants (`*_FILE`) for container secret managers.
- `api-gateway` supports runtime API key rotation through an admin-only endpoint.
- `api-gateway` stores admin operation audit records in PostgreSQL (`admin_actions`) with hashed key fingerprints.
- `api-gateway` persists rotated key state in Redis (`auth:keys`) to survive service restarts.
- Additional REST support:
  - `GET /v1/bets/:betId` resolves from Redis first, then PostgreSQL.
  - `GET /v1/bets?limit=20` returns recent persisted bets.
