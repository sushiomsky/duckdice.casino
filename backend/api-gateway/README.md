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
- `GET /v1/admin/stats?lookbackMinutes=60&includeRateLimitDetails=true&includeTimeoutDiagnostics=true&includeSelfEndpoint=true&minAlertLevel=warning&topN=10&comparePreviousWindow=true&fields=summary,triage,slo,rateLimit,alerts,alertsSummary,requestVolumes` (admin telemetry: rate-limit saturation, optional sampled top rate-limit keys for abuse triage (`sampledKeys`, `truncated`, `top`), admin action volume, internal call latency/error rollups with p50/p95 + bucket sample counts + `errorByType` plus optional timeout-budget diagnostics (`timeoutBudget`), endpoint request volume rollups, failed-bet reason breakdowns, event publish rates, optional current-vs-previous-window deltas (including `comparison.slo` trend deltas), `alerts` hints for rapid ops triage including SLO breach signals with optional severity filtering via `minAlertLevel` and `alertsSummary`, bot-friendly compact `summary`, high-signal `triage` hotspots/recommended actions (self `GET /v1/admin/stats` traffic excluded by default unless `includeSelfEndpoint=true`), objective-based `slo` status/breaches with burn rates and projected budget exhaustion, and optional top-level field filtering)
