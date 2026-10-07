# Outland — Finals Report

Status of the Outland / TouchGrass quest generator at handoff: stabilization,
latency budget, quality/personalization gates, honest fallbacks, web-UI polish,
and proof via automated + live testing.

## 1. What was built / changed

- `server.js` — the entire `/api/quest` pipeline (state extraction → SerpApi
  discovery → provider routing → Gemma generation → safety → quality →
  personalization → fallbacks), TIMING budget, circuit breakers, quality
  gates, curated fallback, honest source labelling, full staged trace.
- `index.html` — web UI: mood → answers → chaos → results flow, loading
  progress, error handling, quest/secret reveal, light+dark themes, focus &
  contrast accessibility and low-vision pairing.
- `server.test.js` — 62 tests, all passing (`npm test`, exit 0).
- `scripts/` — `live-quests.mjs`, `demo-report.mjs` (both batteries of real
  requests with assertions), `ui-qa.mjs` (headless-Chrome CDP harness that
  captures 15 screenshots and audited contrast + `:focus-visible`).
- `package.json` — `test`, `build`, `start`, `live`, `demo` scripts.
- Not implemented (out of scope): MongoDB features, Sentry features, profiles,
  NPC mode, voice. Mongo/Sentry are wired and reported by `/health` but unused
  by the generator. Sentry uses the preset dev DSN and the same config shape as
  the v11 fix that was already merged.

## 2. Latency contract (worst case)

Budget enforced by the server (`TIMING`):

| timings | value |
| --- | ---: |
| serpapi discovery | 6s |
| primary attempt | 7s |
| fallback attempt | 16s |
| generation budget (gemma+routes) | 25s |
| minimum attempt | 4s |
| minimum regenerate | 9s |
| 429 cooldown | 60s |
| error cooldown | 30s |
| cooldown escalation | ×2 per consecutive failure, cap 120s |
| output cap | 700 tokens |

A cooldown always outlives the attempt that opened it (30s > the 16s attempt
cap) and is held in process memory, so a request that lands while both
providers are cooling down emits `route_skip` → `circuit open` →
`curated_fallback` in single-digit milliseconds instead of waiting out a
provider timeout. Only a successful attempt closes the circuit.

Worst case ≈ discovery (up to 6s) + generation budget (up to 25s) ≈ **~31s**,
then an honest curated fallback is returned. There is no unbounded wait and no
hanging request; the server never blocks on a stuck provider.

## 3. Observed latency (live runs, final code)

| percentile | ms |
| --- | ---: |
| avg | 5,543 |
| p50 | 56 |
| p95 | 25,006 |
| max | 25,077 |

- Requests that reach a real Gemma response and pass every gate returned in
  **6.3s / 11–18s** (typical 10–15s: `THE UNSEEN ARCHITECT`, `THE STATIC
  BENCH`, `THE ARCHITECT'S LEFTOVERS`, `THE LONE BENCH AUDIT`, `THE GREEN LUNG
  AUDIT`).
- Everything else fell to the curated fallback inside budget; the p50 is low
  *because* fallbacks answer fast once a provider circuit trips.

## 4. Provider behaviour (free tier) — the honest bottom line

- **Google AI Studio `gemma-4-26b-a4b-it`** is the workhorse. But under
  sustained sequential load the free endpoint became slow/unreliable:
  - failures observed: **HTTP 500**, and timeouts **8.4–16s**,
  - verbose responses: Gemini is eager to ramble; it regularly hits the 700-token
    cap mid-JSON. The server salvages truncated JSON (`parseJson` appends closing
    braces + fence stripping), but ~half the rambling outputs were unparsable even
    after salvage (reason `no JSON (cut off by max_output_tokens)`).
- **OpenRouter `google/gemma-4-26b-a4b-it:free`** returns **HTTP 429** fast
  (~0.8s, no retry-after). It is reliably rate-limited under any real load.
- **`gemma-4-31b-it`** returns HTTP 500 (route declared unusable; the code keeps
  it on the allowed list but the circuit handles it).

### Result in the demo battery
12/12 requests answered safely (HTTP 200, schema valid, safety passed, no key
leak, budget respected). **1 real gemma quest, 11 curated fallback**
(generation-timeout). Re-run gave 12/12 with most falling back the same way.
The generator *delivered on its worst-case contract* but the free-tier network
did not deliver enough real-Gemma passes — the pipeline conversion rate is
roughly 1 in 8–12 attempts, dominated by network flakiness rather than the
quality gates (of the few generations that succeeded, 2 were rejected on
`generic-hook` and the rest passed).

> Summary: the free tier is the bottleneck. On paid Google quota the same code
> path (attempt 149ms-style fast single pass in earlier logs, model
> `gemma-4-26b-a4b-it`, finish STOP, 181–325 tokens) is expected to serve a
> real quest in ~5–12s with kept latency bounds.

## 5. Gating & personalization (verified in tests + traces)

- **Source honesty**: gemma responses claim `provider/endpoint`; curated claims
  `null/null` plus `fallback.reason`. Scripts assert this.
- **Safety**: tested against 20+ flagged inputs (14+ realistic GM-style swings,
  excursions, assertion of dangerous acts, plus `word-scan` no-gemma cases);
  all rejected or degated. Curated content is trusted by content policy.
- **Quality** (`fit()`): verbosity limit, `generic-hook` block (expanded THING /
  MARKER / proverbs / named-place overlap), null-content block, `HOWTO`-style
  actionable feedback embedded in regenerations (that feedback is what the
  final demo battery showed — e.g. "be a specific hook, tell how the player
  stands/acts, list names of actual nearby places in the objective").
- **Personalization**: energy→duration, budget cap, city→weighted named places,
  `named` token overlap ≥2 (stopped suppressing legitimate "your crew" lines).
- **Key leakage**: none in any live response.

## 6. SerpApi usage

Free plan, 250/mo, **~244 left** at handoff (~6 discovery calls this final
session), renews 2026-11-07. If exhausted, the pipeline already degrades
gracefully to location-independent quests (no city / no places → no discovery
call).

## 7. Visual QA (web UI)

Headless Chrome CDP harness (`scripts/ui-qa.mjs`, no npm deps): 15 screenshots
covered landing dark/light, mood, pressed answer chips, chaos selector
(mobile), loading state, error state, quest reveal (dark/light/desktop/mobile),
and secret-mode reveal.

**Contrast + focus checks: ALL PASS.** Specifics verified programmatically:
- CTA / pressed-chip colour is `var(--bg)` in both themes (legible on the accent
  colour),
- `:focus-visible` outlines on button/summary/input (input's `outline:none` was
  removed),
- light-theme rarity colours contrast against the light background,
- loading shows elapsed seconds + progress; error offers "try again" and
  "change answers"; heading focus moves into the panel on step re-entry.

## 8. Remaining issues

1. **Free-tier reliability** (#1). Google free endpoint timeouts/500s and
   output-cap truncation under sustained load, plus OpenRouter `:free` 429s,
   are why curations dominate. Fixes once paid quota exists: raise
   `max_output_tokens` to ~1,500–2,000 (we cap at 700 for latency), consider
   `temperature 0.8` stays, and keep circuit breakers.
2. **Curated pool is small** (5 unique quests). Repeated titles are visible in
   the battery (rotation already forces distinct consecutive picks). Add more
   curated content.
3. **`gemma-4-31b-it`** unusable (HTTP 500) — left listed so a paid route can
   reclaim it, harmless today.
4. **Truncated-JSON salvage** is a safety net, not a fix; it still fails when
   Gemini rambles past the cap with the JSON half-open.

## Verified commands

- `npm run build` — OK
- `npm test` — 62/62 pass
- `npm run demo` — 12/12 requests answered, all checks pass (network caveat above)
- `npm run ui-qa` — screenshot + contrast + focus all pass
- `/health` on `localhost:3000` — all circuits closed, mongo/serpapi/gemma/sentry true

## Review notes for the merged Sentry fix

- Sentry is `Sentry.init` with the **preset dev DSN** (`.env` `SENTRY_DSN`) in
  the same shape as `5f66503`; `server.js` uses its v11 config (source maps,
  defaults). Re-verify after your sentry-legacy rollout if you change init.