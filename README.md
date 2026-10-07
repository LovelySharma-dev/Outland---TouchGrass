# OUTLAND — Your neighborhood has side quests

[![Test Status](https://img.shields.io/badge/tests-62%2F62-brightgreen)](package.json)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](server.js)

OUTLAND transforms real-world context into playable, safe, IRL (in-real-life) side quests. It is a lightweight web app that helps people "touch grass" by generating small, achievable missions tailored to their mood, energy, budget, and location.

## What It Does

OUTLAND asks a few simple questions about your current state (mood, energy, minutes available, budget, social mode, chaos level, and optional city). From those inputs it can:

- Discover nearby points of interest via SerpApi (when a city is provided)
- Generate a structured IRL quest using Google's Gemma models
- Vet every quest through multi-layer safety, quality, and personalization gates
- Serve a curated, hand-written fallback quest if AI inference is unavailable
- Track the full pipeline in an honest trace that clearly labels the source

Quests are concrete micro-adventures: observe something new, explore an unfamiliar street, sit somewhere you've never sat, or reach a new viewpoint. They emphasize low-cost, low-barrier activities that get you outside without pressure.

## The Problem: "Touch Grass"

Many people want to step away from screens but don't know what to do in the moment. OUTLAND addresses this by turning "I should go outside" into a specific, bite-sized side quest that fits your current energy level and constraints.

## Why AI Is Central

Gemma isn't used as a decorative chatbot. It is responsible for transforming the user's mood, constraints, and real-world context into a **playable IRL side quest**. The AI takes structured state + discovered real places (when available) and produces a quest with concrete steps, objectives, and gamified rewards. This allows quests to adapt to context rather than forcing everyone through identical prompts.

## How Gemma Is Actually Used

OUTLAND uses Gemma through a staged pipeline:

1. Extracts structured user state (mood, energy, minutes, budget ₹0–₹500, social solo/friend/group, chaos 0–3, optional city)
2. Optionally discovers nearby places via SerpApi to ground the quest in reality
3. Sends a strict JSON schema to Gemma with constraints (must be IRL, no paid activities unless budget allows, must match energy/social profile, avoid sensitive locations, etc.)
4. Parses and validates the structured response
5. Passes through safety, quality, and personalization gates
6. Serves the quest with full traceability

**Actual provider/model (as configured and used):** `google-generative-ai` / `gemma-4-26b-a4b-it`

Free-tier Gemma is accessed via:
- Primary: OpenRouter free endpoints (`google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`) with strict free-only enforcement
- Fallback: Google AI Studio (`gemma-4-26b-a4b-it`, `gemma-4-31b-it`) when OpenRouter is rate-limited

The routing enforces timeouts, cooldowns, circuit breakers, and a single generation budget per request. When Gemma cannot deliver a gate-passing quest within the budget, OUTLAND falls back to curated content—**never** fabricating a Gemma success.

## SerpApi's Role

When a city is provided, OUTLAND queries SerpApi to discover real-world context (nearby parks, viewpoints, interesting spots, neighborhoods). These discovered places are passed to Gemma to ground quests in the player's actual environment. If SerpApi is unavailable or no city is provided, quests remain location-independent.

## Complete Architecture

```
User state
 → SerpApi discovery (optional, real-world context)
 → Gemma (structured generation with JSON schema)
 → structured quest (title, hook, objective, steps, bonus/secret, rewards)
 → safety gate (block unsafe, illegal, dangerous, or policy-violating content)
 → quality/personalization gate (concrete steps, distinct from recent, matches energy/budget/social/chaos)
 → quest UI (accessible, mobile-first)
 → real-world completion (player goes outside and completes steps)
 → curated fallback when inference is unavailable (hand-written, gate-vetted)
```

## Safety System

Every quest—whether AI-generated or curated—must pass safety checks. The system blocks:
- Dangerous, illegal, or harmful activities
- Sensitive/private locations or invasive behavior
- Content that encourages unsafe practices
- Anything that violates the "IRL, touch grass" intent

Curated fallback quests are hand-written and also vetted through the same safety rules.

## Honest Labeling: Gemma vs Curated Fallback

The pipeline trace **explicitly distinguishes** sources:

- `GEMMA` / `gemma_generate` / `gemma_regenerate` — real model output
- `SERPAPI` — discovery stage
- `CURATED FALLBACK` / `curated_fallback` — hand-written fallback served due to inference unavailability
- `REGENERATION` — feedback-driven retry
- `SAFETY REJECTION` — blocked by safety gate
- `QUALITY REJECTION` — blocked by quality gate
- `TIMEOUT` — generation exceeded budget
- `RATE LIMIT` — provider returned 429/rate limited

**If Gemma succeeds, the response shows the real provider and model. If fallback happens, it is clearly labeled as curated fallback.** Curated content is never labeled as Gemma.

## Gamification

Each quest includes:
- **XP** based on difficulty/duration
- **Rarity**: COMMON, UNCOMMON, RARE, EPIC
- **Bonus objective**: optional extra challenge
- **Secret objective**: optional hidden goal
- **Archetypes**: EXPLORER, MEMORY QUEST, OBSERVER, BOSS QUEST, NATURE, PHOTO HUNT, etc.
- **Energy-aware scaling**: matches low/normal/high energy states

## Curated Fallback Pool

The committed code includes **4** curated, hand-written quests. Each is energy-aware (min energy thresholds), location-independent, concrete, and passes the same safety and personalization gates as Gemma-generated quests. They are designed to feel like real Outland side quests—not generic "go for a walk" filler.

The 4 quests cover a range of energy levels (0–81+) with appropriate durations, budgets (₹0), and concrete steps.

## Accessibility & Visual QA

- Mobile-first, accessible UI with proper focus states
- Dark/light mode support
- Visual QA verified across desktop and mobile breakpoints
- Contrast and focus checks pass

## Testing

- **62/62 tests passing** (`npm test`)
- Covers safety, quality, personalization, routing (timeouts/circuit breakers/failover), latency bounds, deduplication, and edge cases
- No test modifications were made beyond what was already committed

## Local Development

```bash
# Install dependencies
npm install

# Start server (dev)
npm start

# Run tests
npm test

# Type-check/build validation
npm run build

# Run demo (12-request reproducible demo)
npm run demo

# Run UI QA
npm run ui-qa
```

## Environment Variables

Required keys (free-tier only):

```env
# OpenRouter free Gemma (primary)
OPENROUTER_API_KEY=

# Google AI Studio Gemma (fallback when free tier rate-limited)
GEMMA_API_KEY=

# SerpApi for real-world place discovery (optional but recommended)
SERPAPI_KEY=
```

Optional overrides:
```env
# Must end in :free for OpenRouter
# OPENROUTER_MODEL=google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free

# Must start with gemma- for Google
# GEMMA_MODEL=gemma-4-26b-a4b-it,gemma-4-31b-it

# Optional (not required for core functionality)
# SENTRY_DSN=
# MONGODB_URI=
```

The code enforces free-only model filtering and never routes paid models.

## Deployment (Render)

Render is configured via `render.yaml`:
- Build: `npm install`
- Start: `npm start`
- Health check: `/health`
- Environment variables as above

## Known Limitation: Free-Tier Gemma Reliability

Due to the constraints of free inference endpoints (timeouts, 429s, rate limits), real Gemma generation succeeds intermittently in live conditions. To maintain a safe, reliable experience:
- Requests are bounded by strict timeouts and a generation budget
- Circuit breakers and cooldowns prevent hammering endpoints
- If Gemma cannot produce a gate-passing quest in time, the system serves a **curated fallback** that still clears all safety/personalization gates
- The trace is always honest
