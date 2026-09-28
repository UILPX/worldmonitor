# Relay Parameters (Railway + Vercel)

This document covers all environment variables used by the AIS/OpenSky relay path:

- Railway relay process: `scripts/ais-relay.cjs`
- Vercel relay proxy endpoints: `api/opensky.js`, `api/ais-snapshot.js`, `api/polymarket.js`, `api/rss-proxy.js`
- Server relay callers: `server/worldmonitor/*` handlers
- Optional browser local fallback callers in `src/services/*`

## 1) Minimum Production Setup

Set these before enabling strict relay auth.

### Railway (relay)

| Variable | Required | Example | Notes |
| --- | --- | --- | --- |
| `AISSTREAM_API_KEY` | Yes | `ais_...` | Required for AIS upstream WebSocket feed. |
| `RELAY_SHARED_SECRET` | Yes | `wm_relay_prod_...` | Must exactly match Vercel value. |
| `RELAY_AUTH_HEADER` | Recommended | `x-relay-key` | Must match Vercel if changed from default. |

### Vercel (proxy + server functions)

| Variable | Required | Example | Notes |
| --- | --- | --- | --- |
| `WS_RELAY_URL` | Yes | `https://<railway-app>.up.railway.app` | HTTPS relay base URL used by server-side proxy calls. |
| `RELAY_SHARED_SECRET` | Yes | `wm_relay_prod_...` | Must exactly match Railway value. |
| `RELAY_AUTH_HEADER` | Recommended | `x-relay-key` | Header name used to forward relay secret. |

## 2) Full Parameter Reference

## Core Relay/Auth

| Variable | Set On | Default | Required | Purpose |
| --- | --- | --- | --- | --- |
| `AISSTREAM_API_KEY` | Railway | none | Yes | Auth for AIS upstream stream source. |
| `VITE_AISSTREAM_API_KEY` | Local dev only | none | No | Local fallback if `AISSTREAM_API_KEY` is missing. Not recommended for production. |
| `PORT` | Railway/local | `3004` | No | HTTP server listen port for relay process. |
| `WS_RELAY_URL` | Vercel + server handlers | none | Yes (for relay-backed features) | Base URL used by Vercel/server to reach Railway relay. |
| `VITE_WS_RELAY_URL` | Browser (local dev) | none | No | Localhost fallback path for direct browser calls in development only. |
| `RELAY_SHARED_SECRET` | Railway + Vercel | empty | Yes in production | Shared secret for non-public relay routes. |
| `RELAY_AUTH_HEADER` | Railway + Vercel | `x-relay-key` | No (but recommended explicit) | Header name carrying relay secret. |
| `ALLOW_UNAUTHENTICATED_RELAY` | Railway | `false` | No | Emergency override. If `true`, production can start without secret. Keep `false`. |
| `ALLOW_VERCEL_PREVIEW_ORIGINS` | Railway | `false` | No | If `true`, allows `*.vercel.app` origins in relay CORS checks. |

## Relay-Adjacent Feature Flags

| Variable | Set On | Default | Required | Purpose |
| --- | --- | --- | --- | --- |
| `VITE_ENABLE_AIS` | Browser/client build env | enabled (unless `false`) | No | Client-side feature gate for AIS UI/polling. |
| `LOCAL_API_MODE` | Local/server runtime | none | No | If contains `sidecar`, some server handlers bypass relay and call OpenSky directly. |
| `WINGBITS_API_KEY` | Vercel/server | none | No | Military enrichment/fallback source used by server handlers; not required for relay core. |

## OpenSky Upstream Auth

| Variable | Set On | Default | Required | Purpose |
| --- | --- | --- | --- | --- |
| `OPENSKY_CLIENT_ID` | Railway | none | No (recommended) | OAuth client ID for higher OpenSky reliability/rate limits. |
| `OPENSKY_CLIENT_SECRET` | Railway | none | No (recommended) | OAuth client secret paired with client ID. |

## OpenSky Cache/Cardinality Controls

| Variable | Set On | Default | Required | Purpose |
| --- | --- | --- | --- | --- |
| `OPENSKY_CACHE_TTL_MS` | Railway/local relay | `900000` | No | Positive cache TTL for OpenSky responses (default 15 min). |
| `OPENSKY_NEGATIVE_CACHE_TTL_MS` | Railway/local relay | `600000` | No | Negative cache TTL for OpenSky `429/5xx` (default 10 min). |
| `OPENSKY_CACHE_MAX_ENTRIES` | Railway | `128` | No | Max positive cache keys retained in memory. |
| `OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES` | Railway | `256` | No | Max negative cache keys (`429/5xx`) retained in memory. |
| `OPENSKY_BBOX_QUANT_STEP` | Railway | `0.01` | No | Coordinate quantization step for bbox cache key reuse. `0` disables quantization. |
| `OPENSKY_REQUEST_SPACING_MS` | Railway/local relay | `12000` | No | Minimum spacing between upstream OpenSky requests (global serialized gate). |
| `OPENSKY_429_COOLDOWN_MS` | Railway/local relay | `600000` | No | Global cooldown after a single upstream OpenSky `429`. |

## Local Disk Cache Persistence

Useful for local deployments: keeps expensive API cache warm across relay restarts.

| Variable | Set On | Default | Required | Purpose |
| --- | --- | --- | --- | --- |
| `RELAY_DISK_CACHE_ENABLED` | Local relay | `true` | No | Enable disk-backed cache snapshots. |
| `RELAY_DISK_CACHE_DIR` | Local relay | `./tmp/relay-cache` | No | Directory for cache snapshot files. |
| `RELAY_DISK_CACHE_FLUSH_INTERVAL_MS` | Local relay | `300000` | No | Periodic snapshot flush interval. |
| `RELAY_DISK_CACHE_MAX_FILE_BYTES` | Local relay | `12582912` | No | Max bytes per snapshot file (write is skipped if exceeded). |
| `RELAY_DISK_CACHE_MAX_ENTRY_BYTES` | Local relay | `1048576` | No | Max bytes per cached entry saved to disk. |
| `RELAY_DISK_CACHE_OPENSKY` | Local relay | `true` | No | Persist OpenSky positive + negative cache maps. |
| `RELAY_DISK_CACHE_OPENSKY_MAX_ENTRIES` | Local relay | `24` | No | Max OpenSky keys persisted to disk. |
| `RELAY_DISK_CACHE_OPENSKY_MAX_AGE_MS` | Local relay | `3600000` | No | Max age of OpenSky entries restored from disk. |
| `RELAY_DISK_CACHE_UCDP` | Local relay | `true` | No | Persist UCDP aggregated payload. |
| `RELAY_DISK_CACHE_UCDP_MAX_AGE_MS` | Local relay | `172800000` | No | Max age of UCDP snapshot restored from disk. |
| `RELAY_DISK_CACHE_WORLDBANK` | Local relay | `true` | No | Persist World Bank proxy cache. |
| `RELAY_DISK_CACHE_WORLDBANK_MAX_ENTRIES` | Local relay | `80` | No | Max World Bank keys persisted to disk. |
| `RELAY_DISK_CACHE_WORLDBANK_MAX_AGE_MS` | Local relay | `86400000` | No | Max age of World Bank entries restored from disk. |
| `RELAY_DISK_CACHE_POLYMARKET` | Local relay | `true` | No | Persist Polymarket proxy cache. |
| `RELAY_DISK_CACHE_POLYMARKET_MAX_ENTRIES` | Local relay | `40` | No | Max Polymarket keys persisted to disk. |
| `RELAY_DISK_CACHE_POLYMARKET_MAX_AGE_MS` | Local relay | `21600000` | No | Max age of Polymarket entries restored from disk. |
| `RELAY_DISK_CACHE_NOTAM` | Local relay | `true` | No | Persist NOTAM relay cache. |
| `RELAY_DISK_CACHE_NOTAM_MAX_AGE_MS` | Local relay | `86400000` | No | Max age of NOTAM cache restored from disk. |

## AIS Pipeline Tuning

| Variable | Set On | Default | Required | Purpose |
| --- | --- | --- | --- | --- |
| `AIS_SNAPSHOT_INTERVAL_MS` | Railway | `5000` (min `2000`) | No | Interval for rebuilding snapshot payloads. |
| `AIS_UPSTREAM_QUEUE_HIGH_WATER` | Railway | `4000` (min `500`) | No | Pause upstream socket when queue reaches this. |
| `AIS_UPSTREAM_QUEUE_LOW_WATER` | Railway | `1000` (clamped `< HIGH_WATER`) | No | Resume upstream socket when queue drops below this. |
| `AIS_UPSTREAM_QUEUE_HARD_CAP` | Railway | `8000` (must be `> HIGH_WATER`) | No | Max queue size before dropping incoming upstream messages. |
| `AIS_UPSTREAM_DRAIN_BATCH` | Railway | `250` (min `1`) | No | Max messages drained per cycle. |
| `AIS_UPSTREAM_DRAIN_BUDGET_MS` | Railway | `20` (min `2`) | No | Max CPU time budget per drain cycle. |

## Rate Limit / Logging / Metrics

| Variable | Set On | Default | Required | Purpose |
| --- | --- | --- | --- | --- |
| `RELAY_RATE_LIMIT_WINDOW_MS` | Railway | `60000` | No | Global rate-limit window. |
| `RELAY_RATE_LIMIT_MAX` | Railway | `1200` | No | Default max requests per IP per window. |
| `RELAY_OPENSKY_RATE_LIMIT_MAX` | Railway | `600` | No | OpenSky route max requests per IP per window. |
| `RELAY_RSS_RATE_LIMIT_MAX` | Railway | `300` | No | RSS route max requests per IP per window. |
| `RELAY_LOG_THROTTLE_MS` | Railway | `10000` | No | Minimum interval between repeated log events per key. |
| `RELAY_METRICS_WINDOW_SECONDS` | Railway | `60` (min `10`) | No | Rolling window used by `/metrics`. |

## Platform-Managed Variables (Do Not Manually Set)

These are used only for production detection and are usually injected by platform/runtime.

| Variable | Who sets it | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Runtime/platform | Used to detect production mode. |
| `RAILWAY_ENVIRONMENT` | Railway | Used to detect production relay environment. |
| `RAILWAY_PROJECT_ID` | Railway | Used to detect production relay environment. |
| `RAILWAY_STATIC_URL` | Railway | Used to detect production relay environment. |

## 3) Recommended Starting Values (High Traffic Baseline)

These are safe starting points for a busy relay:

```bash
# Auth + routing
RELAY_SHARED_SECRET=<strong-random-secret>
RELAY_AUTH_HEADER=x-relay-key
WS_RELAY_URL=https://<your-railway-relay>.up.railway.app
ALLOW_UNAUTHENTICATED_RELAY=false

# OpenSky cache/cardinality
OPENSKY_CACHE_MAX_ENTRIES=256
OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES=512
OPENSKY_BBOX_QUANT_STEP=0.01
OPENSKY_CACHE_TTL_MS=900000
OPENSKY_NEGATIVE_CACHE_TTL_MS=600000
OPENSKY_REQUEST_SPACING_MS=12000
OPENSKY_429_COOLDOWN_MS=600000

# AIS pipeline
AIS_SNAPSHOT_INTERVAL_MS=3000
AIS_UPSTREAM_QUEUE_HIGH_WATER=5000
AIS_UPSTREAM_QUEUE_LOW_WATER=1500
AIS_UPSTREAM_QUEUE_HARD_CAP=10000
AIS_UPSTREAM_DRAIN_BATCH=300
AIS_UPSTREAM_DRAIN_BUDGET_MS=20

# Rate limits + metrics
RELAY_RATE_LIMIT_WINDOW_MS=60000
RELAY_RATE_LIMIT_MAX=1200
RELAY_OPENSKY_RATE_LIMIT_MAX=600
RELAY_RSS_RATE_LIMIT_MAX=300
RELAY_LOG_THROTTLE_MS=10000
RELAY_METRICS_WINDOW_SECONDS=60

# Local disk persistence (optional but recommended for strict quotas)
RELAY_DISK_CACHE_ENABLED=true
RELAY_DISK_CACHE_DIR=./tmp/relay-cache
RELAY_DISK_CACHE_FLUSH_INTERVAL_MS=300000
RELAY_DISK_CACHE_OPENSKY=true
RELAY_DISK_CACHE_UCDP=true
RELAY_DISK_CACHE_WORLDBANK=true
RELAY_DISK_CACHE_POLYMARKET=true
RELAY_DISK_CACHE_NOTAM=true
```

## 4) How to Verify Configuration

Health:

```bash
curl -sS https://<relay>/health
```

Metrics (requires relay auth):

```bash
curl -sS https://<relay>/metrics \
  -H "x-relay-key: $RELAY_SHARED_SECRET"
```

or:

```bash
curl -sS https://<relay>/metrics \
  -H "Authorization: Bearer $RELAY_SHARED_SECRET"
```

Expected checks:

- `auth.sharedSecretEnabled` is `true` in `/health`.
- `/metrics.opensky.hitRatio` is stable and high under load.
- `/metrics.ais.dropsPerSec` stays at `0` in normal operation.
- `/metrics.ais.queueMax` is comfortably below `AIS_UPSTREAM_QUEUE_HARD_CAP`.
