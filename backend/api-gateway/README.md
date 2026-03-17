# DuckDice Backend API Gateway

## Purpose
Public backend gateway that orchestrates bet settlement with:
- `dice-engine` (`POST /v1/settle`)
- `risk-engine` (`POST /v1/evaluate`, `POST /v1/release`)
- RabbitMQ events (`bet.accepted`, `bet.rejected`, `bet.error`)
- PostgreSQL persistence + Redis read-through cache

## Security
- `GET /health` is public.
- All `/v1/*` endpoints require `x-api-key` matching `BACKEND_API_KEY`.
- In-memory rate limiting is applied to `/v1/*` requests.
- Gateway-to-engine calls include `x-internal-token` and require matching `INTERNAL_API_TOKEN` on internal services.

## Endpoints
- `POST /v1/bets`
- `POST /v1/exposure/release`
- `GET /v1/bets/:betId`
- `GET /v1/bets?limit=20`
