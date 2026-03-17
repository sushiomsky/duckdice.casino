# DuckDice Backend API Gateway

## Purpose
Public backend gateway that orchestrates bet settlement with:
- `dice-engine` (`POST /v1/settle`)
- `risk-engine` (`POST /v1/evaluate`, `POST /v1/release`)
- RabbitMQ events (`bet.accepted`, `bet.rejected`, `bet.error`)
- PostgreSQL persistence + Redis read-through cache

## Security
- `GET /health` is public.
- `/v1/*` endpoints require `x-api-key` with backend or admin scope.
- Admin-only operations require `x-api-key` matching `ADMIN_API_KEY`.
- Redis-backed rate limiting is applied to `/v1/*` requests using `ip + api key` buckets.
- Gateway-to-engine calls include `x-internal-token` plus signed headers (`x-internal-timestamp`, `x-internal-request-id`, `x-internal-signature`) using `INTERNAL_REQUEST_SIGNING_KEY`.
- Internal request IDs are unique per call (UUIDv4) and are deduplicated by internal services using Redis `NX` windows to block short-window replay.
- Internal services emit structured `internal_auth_denied` logs for rejected internal requests.
- Sensitive tokens support file-based loading via `BACKEND_API_KEY_FILE`, `ADMIN_API_KEY_FILE`, `INTERNAL_API_TOKEN_FILE`, and `INTERNAL_REQUEST_SIGNING_KEY_FILE`.
- Admin actions are written to PostgreSQL `admin_actions` with hashed actor key fingerprints.
- Runtime key state is persisted in Redis (`auth:keys`) so rotations survive gateway restarts.

## Endpoints
- `GET /` (service status landing response)
- `GET /health` (infra + security readiness diagnostics)
- `POST /v1/bets`
- `POST /v1/exposure/release`
- `GET /v1/bets/:betId`
- `GET /v1/bets?limit=20`
- `POST /v1/admin/keys/rotate`
- `GET /v1/admin/actions?limit=20`
- `GET /v1/admin/stats?lookbackMinutes=60` (admin telemetry: rate-limit saturation, admin action volume, internal call latency/error rollups, failed-bet reason breakdowns, and event publish rates)
