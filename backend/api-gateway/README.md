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
- Gateway-to-engine calls include `x-internal-token` and require matching `INTERNAL_API_TOKEN` on internal services.
- Sensitive tokens support file-based loading via `BACKEND_API_KEY_FILE`, `ADMIN_API_KEY_FILE`, and `INTERNAL_API_TOKEN_FILE`.

## Endpoints
- `POST /v1/bets`
- `POST /v1/exposure/release`
- `GET /v1/bets/:betId`
- `GET /v1/bets?limit=20`
- `POST /v1/admin/keys/rotate`
