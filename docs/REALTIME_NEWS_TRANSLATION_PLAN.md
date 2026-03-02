# Real-Time Chinese Translation Plan (Alerts + News Headlines)

## Goal

Translate incoming news headlines to Chinese with low latency and high stability, including alert surfaces.

Key constraints:
- Keep alert latency low.
- Avoid unnecessary LLM cost.
- Preserve critical entities (people, places, tickers, organizations).
- Handle provider failures gracefully.

## Recommended Architecture

Use a hybrid pipeline:

1. Primary path: dedicated translation API
- Fast, predictable latency, lower cost.
- Good fit for short headline translation at scale.

2. Fallback path: LLM translation
- Used only when translation API fails or quality is insufficient.
- Prompt constrained to translation-only behavior.

Result: best balance of speed, cost, and quality.

## End-to-End Flow

1. Headline arrives from feed.
2. Detect language.
3. If already Chinese, skip translation.
4. Check translation cache by normalized key.
5. If cache miss:
- Try translation API first.
- If failed, try LLM fallback.
6. Save translated result to cache.
7. Update UI:
- News cards: async replace title with Chinese.
- Alerts: either
  - fast mode: push original immediately, patch Chinese when ready, or
  - strict-cn mode: wait up to 500-1000ms, fallback to original on timeout.

## Cache Strategy

Cache key input:
- normalized title text
- source id
- target language (zh-CN)

Suggested key shape:
- `news:translate:v1:{sha256(source|lang|title)}`

TTL:
- 24h to 72h for headline translation.

Negative cache:
- short TTL (e.g., 60-120s) for repeated provider errors.

## Translation Quality Rules

Post-processing checks:
- Keep abbreviations (NATO, EU, ETF, CPI, GDP) as-is.
- Keep stock/crypto tickers as-is (AAPL, BTC, ETH).
- Preserve person and place names when uncertain.
- Reject outputs that are too long or include explanations.

Fallback behavior:
- If both providers fail, return original title and mark `translation_status=failed`.

## API and LLM Provider Policy

Provider order:
1. Translation API (primary)
2. LLM (fallback)

Timeouts:
- Translation API timeout: ~1200-2000ms
- LLM fallback timeout: ~2500-5000ms (for short headline prompt)

Retries:
- At most 1 retry per provider for transient network errors.

Rate limit:
- Global and per-visitor limits for interactive translation endpoints.

## Observability

Add logs and metrics:
- request sent (provider, model, endpoint, latency)
- cache hit/miss ratio
- success/failure counts by provider
- fallback rate (translation API -> LLM)
- timeout rate

Alerting:
- Trigger warning if primary translation API failure rate exceeds threshold.

## Data Model Additions (Minimal)

For each headline item:
- `title_original`
- `title_zh` (optional)
- `translation_status` (`pending` | `ok` | `failed` | `skipped`)
- `translation_provider`
- `translated_at` (unix ms)

## Rollout Plan

Phase 1:
- Build server translation endpoint for headline text.
- Add cache and fallback chain.
- Add logs/metrics.

Phase 2:
- Integrate with news cards (async swap to Chinese).
- Integrate with alert pipeline (fast mode default).

Phase 3:
- Add quality guardrail improvements (entity-preservation checks).
- Add admin toggles:
  - `translation_enabled`
  - `alerts_strict_cn`
  - `translation_provider_priority`

## Implementation Notes for This Repo

Likely touchpoints:
- server-side request handlers that already do AI summarization/LLM calls
- recent events and timeline surfaces where translated text can be rendered
- alert push/update flow for immediate notices

Do not block ingestion on translation. Translation should be asynchronous and failure-tolerant.

