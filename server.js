import "dotenv/config";
import * as Sentry from "@sentry/node";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

// A real Sentry DSN is a URL; placeholder values in .env are ignored.
const SENTRY_ON = /^https?:\/\//.test(process.env.SENTRY_DSN || "");
if (SENTRY_ON) Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || "development", tracesSampleRate: 0.2, release: "outland@0.1.0" });

const app = express();
const DIR = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(DIR, "public")));
app.get("/", (_q, s) => s.sendFile(path.join(DIR, "index.html")));

// ---------------------------------------------------------------------------
// AI routes. Outland runs on GEMMA only, FREE tiers only:
//   route 1 - OpenRouter free gemma models (":free" ids are enforced below)
//   route 2 - Google AI Studio gemma models on the free GEMMA_API_KEY
// Gemini models are refused by the filters, so a stray env value cannot
// silently turn this back into a Gemini app. Paid model ids never run.
// ---------------------------------------------------------------------------
const OPENROUTER_HOST = "openrouter.ai";
const GOOGLE_HOST = "generativelanguage.googleapis.com";
const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.OpenRouter_API || process.env.OPENROUTER_API || "";
const googleKey = process.env.GEMMA_API_KEY || "";
const orRequested = (process.env.OPENROUTER_MODEL || "").split(",").map((m) => m.trim()).filter(Boolean);
const googleRequested = (process.env.GEMMA_MODEL || "").split(",").map((m) => m.trim()).filter(Boolean);
// Free-only filters. A paid id is dropped, never called, so a stray env value
// cannot turn this into a billed app.
export const freeOpenRouterModels = (list) => list.filter((m) => m.endsWith(":free"));
export const freeGoogleModels = (list) => list.filter((m) => /^gemma-/i.test(m));
const freeOrModels = freeOpenRouterModels(orRequested);
const gemmaGoogleModels = freeGoogleModels(googleRequested);

const ROUTES = [
  openRouterKey && {
    kind: "openrouter", provider: "openrouter", host: OPENROUTER_HOST, key: openRouterKey,
    models: freeOrModels.length ? freeOrModels : ["google/gemma-4-26b-a4b-it:free", "google/gemma-4-31b-it:free"],
  },
  googleKey && {
    kind: "google", provider: "google-generative-ai", host: GOOGLE_HOST, key: googleKey,
    models: gemmaGoogleModels.length ? gemmaGoogleModels : ["gemma-4-26b-a4b-it", "gemma-4-31b-it"],
  },
].filter(Boolean);

// Latency contract. Every value is a hard ceiling, never a target, and it is
// surfaced in the pipeline trace instead of being hidden:
//   discovery (parallel)  <= 6s
//   generation            <= 25s  (OpenRouter attempt <=7s, Google <=16s)
//   worst case request    <= ~31s, then a curated fallback quest is returned.
// Bounded output is what actually keeps gemma fast: without maxOutputTokens
// the model rambles for 40-75s; capped it answers the real prompt in ~6s.
// 700 (not 900): generation time tracks output length, and a 900-token
// rambling answer overran the 16s attempt cap on a slow attempt.
export const TIMING = {
  discovery_ms: 6000,
  primary_attempt_ms: 7000,
  fallback_attempt_ms: 16000,
  gen_budget_ms: 25000,
  min_attempt_ms: 4000,
  min_regenerate_ms: 9000,
  cooldown_429_ms: 60000,
  // A cooldown must outlive the attempt that produced it, otherwise the next
  // request re-probes a provider that is still broken and pays the full
  // 16s timeout again. 30s > the 16s attempt cap, and consecutive failures
  // double it (see openCircuit) up to cooldown_max_ms.
  cooldown_error_ms: 30000,
  cooldown_max_ms: 120000,
  max_output_tokens: 700,
};

// Circuit breaker per route, held for the life of the process so it survives
// across requests. A route that fails is skipped for its whole cooldown
// instead of being re-probed: a 429 costs ~1s on the first request and ~0ms
// on every request during the next 60s, a timeout costs 16s once and then
// nothing until the cooldown expires. Consecutive failures escalate the
// cooldown (base, 2x, 4x ... capped at cooldown_max_ms) and only a successful
// attempt clears it, so a provider that keeps hanging is skipped for longer
// and longer instead of being retried every few seconds.
const routeHealth = new Map();
const routeKey = (r) => `${r.provider}:${r.host}`;
export function resetRouteHealth() { routeHealth.clear(); }
export function routeState(route, now = Date.now()) {
  const h = routeHealth.get(routeKey(route));
  return h && h.until > now ? { ...h, retry_in_ms: h.until - now } : null;
}

const STATES = ["rotting","scrolling","leave-room","tabs","low-battery","side-quest","new-sight","disappear","dunno","main-character","surprise"];
const STATE_TEXT = {
  rotting: "rotting in bed", scrolling: "stuck doomscrolling", "leave-room": "desperate to leave the room",
  tabs: "brain has 47 tabs open", "low-battery": "running on low battery", "side-quest": "craving a side quest",
  "new-sight": "wants to see something never seen", disappear: "needs to disappear for a bit",
  dunno: "doesn't know what they want, just get them out", "main-character": "main character moment",
  surprise: "wants to be surprised",
};
const BUDGET_MAX = 500;
const SOCIAL = ["solo", "yapper", "group", "dog", "meet-humans", "secret"];
const SOCIAL_TEXT = {
  solo: "alone, zero interaction with people", secret: "alone and nobody may know where they went",
  dog: "with their dog, still no interaction with strangers", yapper: "with one close friend",
  group: "with a group of friends", "meet-humans": "open to brief interaction with people they do not know",
};
const ENERGY_TIME = { 10: 15, 30: 40, 50: 60, 80: 90, 100: 120 };
const RARITIES = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"];
const RARITY_XP = { COMMON: [30, 45], UNCOMMON: [50, 70], RARE: [75, 100], EPIC: [105, 140], LEGENDARY: [150, 200] };
const DIFFICULTIES = ["easy", "medium", "hard"];

export function validate(b) {
  const ok = b && STATES.includes(b.state) && [10, 30, 50, 80, 100].includes(b.energy) &&
    Number.isInteger(b.budget) && b.budget >= 0 && b.budget <= BUDGET_MAX &&
    SOCIAL.includes(b.social) && Number.isInteger(b.chaos) && b.chaos >= 1 && b.chaos <= 5;
  if (!ok) return null;
  return {
    ...b,
    city: typeof b.city === "string" ? b.city.slice(0, 60) : "",
    excuse: typeof b.excuse === "string" ? b.excuse.slice(0, 200) : "",
    minutes: Number.isFinite(b.minutes) && b.minutes >= 5 && b.minutes <= 240 ? Math.round(b.minutes) : 0,
  };
}

export const maxMinutes = (c) => c.minutes || ENERGY_TIME[c.energy] || 60;

// Strip anything that could leak a credential from an error before it is traced.
export function redact(e) {
  return String((e && e.message) || e)
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1REDACTED")
    .replace(/\b(?:api[_-]?key|key)=[A-Za-z0-9_-]{8,}/gi, "key=REDACTED")
    .replace(/Bearer\s+\S+/gi, "Bearer REDACTED");
}

// ---------------------------------------------------------------------------
// STAGE 4: safety gate.
// Scans everything the model may render except the `safety` notes, which
// legitimately warn about dangers ("never talk to strangers").
// ---------------------------------------------------------------------------
const NEGATE = /\b(never|no|not|n't|don'?t|do not|avoid|without|skip|stay|keep|refrain|away|zero|from a distance|leave it alone)\b/i;

// [pattern, label] - negation-aware: "never climb" passes, "climb the fence" fails.
const ALWAYS_UNSAFE = [
  [/trespass/gi, "trespassing"],
  [/private propert/gi, "private-property"],
  [/restricted area/gi, "restricted-area"],
  [/\bno[\s-]entry\b/gi, "restricted-area"],
  [/\bclimb(?:ing)?\b/gi, "climbing"],
  [/\b(?:hop|scale|vault|swing over)\s+(?:the\s+|a\s+)?(?:fence|wall|gate|railing|barrier)\b/gi, "climbing"],
  [/\broof(?:top|scape)?\b/gi, "roof"],
  [/\bcross(?:ing)?\s+(?:the\s+)?(?:road|street|highway|traffic|freeway|motorway|junction|carriageway)\b/gi, "road-crossing"],
  [/\b(?:jaywalk|run)\s+across\s+(?:the\s+)?(?:road|street|traffic)\b/gi, "road-crossing"],
  [/\brun(?:ning)?\s+(?:into|through)\s+(?:the\s+)?(?:traffic|road|street)\b/gi, "road-crossing"],
  [/\belectric(?:al)?[\s-]?(?:box|panel|meter|unit|socket|cab(?:inet)?|point)\b/gi, "electrical-infrastructure"],
  [/utility[\s-]?(?:box|cabinet|pole|cover|hole|manhole|pipe)/gi, "utility-infrastructure"],
  [/\bpower[\s-]?(?:box|line|grid|transformer|station|socket|supply)/gi, "electrical-infrastructure"],
  [/\btransformer\b/gi, "electrical-infrastructure"],
  [/\bsubstation\b/gi, "electrical-infrastructure"],
  [/\blive wire\b/gi, "electrical-infrastructure"],
  [/\babandoned\b/gi, "restricted-area"],
  [/\bafter dark\b/gi, "after-dark"],
  [/\bmidnight\b/gi, "after-dark"],
  [/\b(?:swim|diving?)\b/gi, "water-hazard"],
  [/\b(?:weapon|knife|gun|rifle)\b/gi, "weapon"],
  [/\bblindfold/gi, "blindfold"],
  [/\b(?:medicine|medication|prescription|alcohol|drugs?)\b/gi, "substances"],
  [/\bconstruction site\b/gi, "construction-site"],
  [/\bdemolition\b/gi, "demolition"],
  [/\b(?:train|railway|metro)\s+tracks?\b/gi, "rail-tracks"],
  [/\bsewer\b/gi, "sewer"],
  [/\b(?:vandalis|spray[\s-]?paint|carve into|scratch)\b/gi, "property-damage"],
  [/\bdamage\s+(?:the\s+|a\s+)?(?:public|private)?\s*(?:property|monument|statue|sign|plant)\b/gi, "property-damage"],
  [/\bpick(?:ing)?\s+up\s+(?:the\s+|an?\s+)?(?:unknown|suspicious|unmarked|stray)\b/gi, "unknown-object"],
  [/\bfeed(?:ing)?\s+(?:the\s+|an?\s+)?(?:stray|dog|puppy|cat|animal|monkey|squirrel|duck|pigeon)s?\b/gi, "dangerous-animal"],
  [/\blight\s+(?:a|the)\s+fire\b/gi, "fire"],
  [/\bstart\s+(?:a|the)\s+fire\b/gi, "fire"],
  [/\bplay(?:ing)?\s+with\s+(?:a\s+|the\s+)?fire\b/gi, "fire"],
  [/\bopen\s+(?:the\s+|an?\s+)?(?:unknown|unmarked|suspicious)\s+(?:package|box|container|object|bag)\b/gi, "unknown-object"],
];

// Interaction with people, blocked unless the player chose a social mode for it.
const STRANGER_REQ = /\b(?:talk|speak|chat|ask|interact|converse|say hi|wave|greet|approach)\w*\s+(?:to|with)\s+(?:the\s+|a\s+|an\s+)?(?:stranger|strangers|people|someone|somebody|local|vendor|passerby|pedestrian|resident|tourist)s?\b/gi;
const PEOPLE_OK = ["yapper", "group", "meet-humans"];

// Verb + object proximity, catches phrasings like "place the leaf on the electric box"
// even when neither word is banned on its own.
const RISK_VERBS = /\b(?:touch(?:es|ed|ing)?|grab|pick(?:s|ed)?\s+up|move|moving|pry|poke|handle|feed|pat|pet|enter|entering|approach|cross(?:ing)?|climb|crawl|dig|unplug|unwrap|wander into| sneak into|open up)\b/gi;
const RISK_NOUNS = /\b(?:wire|cable|junction box|drain|sewer|stray|unknown (?:object|package|substance|item)|animal|dog|traffic|rail|tracks|generator|meter|manhole|chemical|powder|syringe|needle|private (?:gate|premises)|restricted)\b/gi;

function findUnsafe(text, c) {
  for (const [re, label] of ALWAYS_UNSAFE) {
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      if (!NEGATE.test(before)) return label;
    }
  }
  if (!PEOPLE_OK.includes(c.social)) {
    for (const m of text.matchAll(STRANGER_REQ)) {
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      if (!NEGATE.test(before)) return "stranger-interaction";
    }
  }
  const verbs = [...text.matchAll(RISK_VERBS)];
  const nouns = [...text.matchAll(RISK_NOUNS)];
  for (const v of verbs) {
    for (const n of nouns) {
      if (Math.abs(v.index - n.index) > 48) continue;
      const start = Math.min(v.index, n.index);
      if (!NEGATE.test(text.slice(Math.max(0, start - 30), start))) return `risky-action:${v[0].trim()}`;
    }
  }
  return null;
}

const normRarity = (r, c) => {
  const up = String(r || "").toUpperCase().trim();
  if (RARITIES.includes(up)) return up;
  if (c.energy >= 80 || c.chaos >= 5) return "RARE";
  if (c.chaos >= 3) return "UNCOMMON";
  return "COMMON";
};

// Stage 4: structural schema + content safety + normalisation.
export function safety(q, c) {
  if (!q || typeof q.title !== "string" || q.title.trim().length < 2) return { ok: false, reason: "schema:title" };
  if (!Array.isArray(q.steps) || q.steps.length < 2 || q.steps.length > 5) return { ok: false, reason: "schema:steps" };
  if (typeof q.objective !== "string" || q.objective.trim().length < 15) return { ok: false, reason: "schema:objective" };
  const done = q.done_when || q.completion_condition;
  if (typeof done !== "string" || done.trim().length < 12) return { ok: false, reason: "schema:done_when" };
  const scan = JSON.stringify({
    title: q.title, hook: q.hook, objective: q.objective, steps: q.steps,
    bonus_objective: q.bonus_objective, secret_objective: q.secret_objective,
    category: q.category, done_when: done,
  });
  const hit = findUnsafe(scan, c);
  if (hit) return { ok: false, reason: `unsafe:${hit}` };

  const rarity = normRarity(q.rarity, c);
  const band = RARITY_XP[rarity];
  let xp = Number(q.xp);
  if (!Number.isFinite(xp)) xp = Math.round((band[0] + band[1]) / 2);
  xp = Math.min(Math.max(Math.round(xp), band[0]), band[1]);
  const difficulty = DIFFICULTIES.includes(String(q.difficulty || "").toLowerCase())
    ? String(q.difficulty).toLowerCase()
    : c.energy <= 30 ? "easy" : c.energy >= 80 ? "hard" : "medium";

  return {
    ok: true,
    quest: {
      title: q.title.trim().slice(0, 80),
      hook: String(q.hook || "").trim().slice(0, 180),
      objective: q.objective.trim().slice(0, 240),
      steps: q.steps.map((s) => String(s).trim().slice(0, 240)),
      duration_minutes: Math.round(Number(q.duration_minutes) || 20),
      budget: Math.max(0, Math.round(Number(q.budget) || 0)),
      difficulty,
      xp,
      category: String(q.category || "").trim().slice(0, 40),
      done_when: done.trim().slice(0, 240),
      rarity,
      bonus_objective: String(q.bonus_objective || "").trim().slice(0, 200),
      secret_objective: String(q.secret_objective || "").trim().slice(0, 200),
      safety: [...(Array.isArray(q.safety) ? q.safety.map((s) => String(s).trim()).filter(Boolean) : []),
        "Stay in public, well-lit places. Skip any step that feels unsafe."],
    },
  };
}

// ---------------------------------------------------------------------------
// STAGE 5: quality gate. Rejected quests are regenerated, never returned.
// ---------------------------------------------------------------------------
const GENERIC = /^(?:take a walk|go for a walk|go outside|get some fresh air|explore your (?:neighborhood|area|surroundings)|take a stroll|walk around(?: town)?|step outside and breathe)/i;
const WALKY = /\b(?:go for a walk|take a walk|walk around|get some fresh air|explore the area|enjoy the outdoors)\b/i;
const ARBITRARY = /\bexactly\s+\d+\s+(?:steps|metres|meters)\b|\bwalk\s+exactly\b|\bafter\s+exactly\s+\d+\b|\b\d+\s+steps\s+(?:exactly|precisely|no more, no less)\b/i;
const EQUIPMENT = /\b(?:bring|carry|use|rent|need)\s+(?:a\s+|an\s+|your\s+)?(?:drone|laptop|tripod|bicycle|bike|skateboard|roller skates|binoculars|tent)\b/i;
const OUTDOOR = /outside|street|road|path|sidewalk|pavement|park|tree|sky|bench|corner|shop|store|market|bridge|river|lake|gate|block|door|walk|route|building|statue|cafe|library|station|garden|plaza|square|lane|sun|cloud|bird|plant|flower|fountain|stair|hill|view|sign|mural|bus|train|pond|shore|field|court|alley|steps|porch|balcony|neighbourhood|neighborhood/i;
const EXHAUSTED = /brain|fried|tired|exhausted|drained|burnt|burned out|sleep|low battery|can'?t think|cant think|spent|wiped|dead/i;

// AI poetry: cinematic or motivational phrasing that sounds like a trailer
// and tells the player nothing about the activity they are about to do.
const HYPE = /\b(?:your party stands|make (?:it|your entrance) count|destiny|fate|prophecy|glory|glorious|champion|vanquish|embark(?:s|ing)? on|odyssey|epic (?:journey|quest|saga|tale|battle)|unleash|seize the (?:day|moment)|answer the call|the adventure (?:begins|awaits)|are you ready|rise and grind|legend awaits|your legend|greatness|hero'?s? (?:arrival|journey|call|path|destiny)|prove (?:you|you'?re|you are) (?:worthy|ready)|show (?:them|the world)|time to shine|the world (?:awaits|is waiting))\b/i;
// A hook earns its place by naming a real thing AND something specific about
// it. "Accept this contract from the Park Keeper" names a thing but says
// nothing specific, so it fails the MARKER half. Body/state nouns count too:
// the prompt's own example hook is about a brain running 47 tabs.
const THING = /\b(?:door|doorway|window|wall|bench|tree|leaf|leaves|branch|flower|bird|cloud|shadow|light|lamp|sign|plaque|mural|stair|stairs|bridge|gate|fence|street|road|path|lane|corner|shop|store|market|cafe|café|library|station|garden|park|pond|river|lake|fountain|statue|brick|stone|graffiti|number|letter|shape|colour|color|sound|smell|wind|sun|sky|view|balcony|poster|sticker|grate|pole|cat|dog|squirrel|bee|moss|rust|crack|peeling|pattern|reflection|texture|alley|clock|tower|field|track|queue|awning|shutter|mailbox|bicycle|boat|hill|roof|steps|city|town|house|home|building|architecture|facade|apartment|storefront|neighborhood|neighbourhood|route|sidewalk|pavement|crossing|traffic|bus|train|tram|metro|plant|bush|grass|root|bark|glass|metal|wood|chair|table|mat|mug|plate|blanket|frame|photo|radio|cable|pencil|paper|diary|calendar|ticket|coin|note|map|bag|hat|boot|watch|bottle|can|room|corridor|elevator|lift|tunnel|pool|shore|pier|creek|meadow|trail|playground|stadium|church|temple|school|college|diner|bakery|cinema|warehouse|garage|brain|tabs?|battery|phone|pocket|couch|bed|ceiling|mirror|book|cup|kettle|shoe|keys|notebook|hand)\b/i;
// A two-word capitalised phrase is a proper noun: "Swarna Jayanti Park", the
// name of a real place discovery handed to the model.
const PROPER = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+\b/;
const MARKER = /\d|\b(?:never|ever|oldest|newest|weirdest|strangest|oddest|hidden|forgotten|unseen|unnoticed|unexplored|only|single|first|last|missing|wrong|odd|unusual|rare|strange|weird|bizarre|unexpected|unexplained|incorrectly|interrupted|unfinished|half-built|overgrown|abandoned|faded|crooked|tilted|sealed|locked|unread|untouched|leftover|overlooked|ignored|specific|particular|barely|seldom|rarely|most people|tiny|huge|cracked|peeling|rusty|hand-painted|misplaced|out of place|no one|nobody|left behind|gone|vanishing|disappearing)\b/i;
// Real-world acts of discovery. Two steps must contain one, or the "quest" is
// a walk with extra adjectives.
const DISCOVERY = /\b(?:find|finds|found|spot|spots|spotted|notice|notices|noticing|discover|discovers|observe|observes|observed|photograph|photographs|sketch|sketches|listen|listens|identify|identifies|compare|compares|count|counts|watch|watches|hunt|hunts|trace|traces|track|tracks|map|maps|read|reads|log|logs|record|records|document|documents|locate|locates|note|notes|search|searches|look|looks|peek|glance|smell|smells|hear|hears|weigh|weighs|test|tests|match|matches)\b/i;

const tokens = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
// Shared quest vocabulary ("find", "photograph", "your street") is worthless
// for telling two quests apart, so it is dropped before comparing.
const STOP = new Set(`the and that this with from your will then when where what than them they have been into over most more very just like also each near back home only once after before about which while their there here down take make find look walk thing things quest something anything never always every onto under upon outside about stand stop see`.split(/\s+/));
const contentTokens = (s) => tokens(s).filter((w) => !STOP.has(w));
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
// Negation-aware regex hit: "do not pay anything" is not a paid activity.
// matchAll() throws on a non-global pattern, so one is forced here rather
// than relying on every caller to remember the g flag.
function hit(text, re) {
  const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  for (const m of String(text).matchAll(global)) {
    const before = String(text).slice(Math.max(0, m.index - 30), m.index);
    if (!NEGATE.test(before)) return m[0].trim();
  }
  return null;
}

// What the model must change when a quality gate rejects it. Regeneration is
// only worth its ~8s if the retry is told something actionable.
const HOWTO = {
  "generic-hook": "the hook must name one real object or place AND one marker that pins it down (a number, oldest, nobody, never, only)",
  "ai-poetry": "no trailer voice - drop destiny/epic/answer the call and describe the actual thing the player will look at",
  "no-discovery-action": "at least two steps must ask the player to find, notice, photograph, count or listen for something real",
  "too-generic": "the title, objective and steps must be about this specific place, not about going for a walk",
  "weak-hook": "write a hook of at least 12 characters that names a real thing",
  "duplicate-quest": "you have already written this quest - change the place, the object and the activity, not just the title",
  "near-duplicate-objective": "the objective repeats a recent one almost word for word - make it a different activity",
  "near-duplicate-activity": "the steps repeat a recent quest almost word for word - invent a new activity",
  "repeat-category": "the last two quests were the same archetype - switch to a different kind of outing",
};
const gateFeedback = (bad) => `quality gate rejected it: ${bad}. ${HOWTO[bad] || "fix the reason above"}`;

// history: [{title, category, objective, steps}] newest first - drives
// anti-repetition and near-duplicate detection.
export function quality(q, c, history = [], places = []) {
  const t = q.title.trim();
  if (t.length < 8 || t.length > 70) return "weak-title";
  if (!q.hook || q.hook.trim().length < 12) return "weak-hook";
  if (!q.category) return "no-category";
  if (q.steps.some((s) => s.trim().length < 12)) return "weak-step";
  if (GENERIC.test(t) || GENERIC.test(q.objective) || q.steps.filter((s) => WALKY.test(s)).length >= 2) return "too-generic";
  if (q.steps.some((s) => ARBITRARY.test(s))) return "arbitrary-instruction";
  if (EQUIPMENT.test(q.steps.join(" "))) return "needs-unavailable-equipment";
  const max = maxMinutes(c);
  if (q.duration_minutes < 5) return "too-short";
  if (q.duration_minutes > max) return `over-time:${q.duration_minutes}>${max}`;
  if (q.budget > c.budget) return `over-budget:${q.budget}>${c.budget}`;
  if (c.energy >= 50 && !q.steps.some((s) => OUTDOOR.test(s))) return "not-outdoors";
  if (c.energy <= 30 && q.difficulty === "hard") return "mood-mismatch-energy";
  if (EXHAUSTED.test(c.excuse || "") && (q.difficulty === "hard" || q.duration_minutes > 45)) return "mood-mismatch-excuse";

  // Quest quality: an interesting real thing, not a dramatic paragraph.
  const scan = `${t} ${q.hook} ${q.objective}`;
  if (HYPE.test(scan)) return "ai-poetry";
  // A specific hook names a concrete thing (or a real place discovery handed
  // to the model) AND a marker that pins it down: a number, "oldest",
  // "nobody notices". Either half alone is a slogan.
  const placeTokens = (name) => String(name).toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 3 && !["ghaziabad", "city", "park-name", "road", "street", "nagar", "area", "colony"].includes(w));
  const named = places.some((p) => {
    const words = placeTokens(p.name);
    return words.length && words.filter((w) => q.hook.toLowerCase().includes(w)).length >= 2;
  });
  if (!MARKER.test(q.hook) || !(THING.test(q.hook) || PROPER.test(q.hook) || named)) return "generic-hook";
  if (q.steps.filter((s) => DISCOVERY.test(s)).length < 2) return "no-discovery-action";

  // Distinctiveness: same experience with a new title is still a repeat.
  if (history.some((h) => h.title === t || jaccard(tokens(h.title), tokens(t)) >= 0.6)) return "duplicate-quest";
  if (history.slice(0, 2).filter((h) => h.category === q.category).length >= 2) return "repeat-category";
  for (const h of history) {
    if (h.objective && jaccard(contentTokens(q.objective), contentTokens(h.objective)) >= 0.5) return "near-duplicate-objective";
    if (Array.isArray(h.steps) && jaccard(contentTokens(q.steps.join(" ")), contentTokens(h.steps.join(" "))) >= 0.45) return "near-duplicate-activity";
  }
  return null;
}

// ---------------------------------------------------------------------------
// STAGE 5b: personalization gate. The quest must fit the player who asked:
// company, energy, budget, chaos, secrecy and their own stated excuse.
// ---------------------------------------------------------------------------
// Personalization patterns. hit() forces the g flag when one is missing and
// never mutates lastIndex (matchAll iterates over a clone), so reusing these
// across requests is safe.
const PARTY = /\b(?:your party|the party|your crew|your squad|your team|your friends|with friends|your mates|gather (?:your|the) (?:crew|squad|friends))\b/gi;
const PAID = /\b(?:pay|pays|paid|buy|buys|buying|purchase|purchases|order (?:a |the |some )?(?:food|drinks?|coffee|meal|snack|tickets?)|book (?:a |an )?(?:ticket|table|slot)|entry fee|cover charge|spend (?:₹|money|rs\b)|ticket to|movie ticket)\b/gi;
const HIGH_ENERGY = /\b(?:sprint|sprints|jog|jogs|hustle|hustles|dash|dashes|racing|charge up|climb (?:a |the )?(?:flights?|stairs?|hill)|power walk|speed walk)\b/gi;
const WILD = /\b(?:unhinged|chaotic|mayhem|anarchy|illegal|reckless|break the rules|no rules)\b/gi;
const SOLO_WORDS = /\b(?:by yourself|on your own|all alone)\b/gi;
const GEOPOST = /\b(?:post (?:it|them|this)|posting|instagram|insta story|your story|tiktok|snapchat|geotag|check in on)\b/gi;
const INDOOR_DOG = /\b(?:enter|step inside|go into|walk into)\b[^\n.]{0,50}\b(?:library|museum|cafe|café|shop|store|mall|cinema)\b/gi;

// Fields are matched one at a time. A negation in one field ("never talk to
// strangers") must not cancel a violation in the next field, and a word like
// "never" in the hook must not excuse party language in the objective.
function scanHit(list, re) {
  for (const field of list) {
    const m = hit(field, re);
    if (m) return m;
  }
  return null;
}

export function fit(q, c) {
  const fields = [q.title, q.hook, q.objective, ...(q.steps || []), q.done_when].filter(Boolean);
  const head = [q.title, q.hook].filter(Boolean);
  const steps = (q.steps || []).filter(Boolean);
  if (["solo", "secret", "dog"].includes(c.social)) {
    const m = scanHit(fields, PARTY);
    if (m) return `solo-party-language:${m}`;
  }
  if (["yapper", "group"].includes(c.social)) {
    const m = scanHit(head, SOLO_WORDS);
    if (m) return `group-solo-language:${m}`;
  }
  if (c.budget === 0) {
    const m = scanHit(fields, PAID);
    if (m) return `paid-on-zero-budget:${m}`;
  }
  if (c.energy <= 10 && (q.duration_minutes > 30 || q.difficulty !== "easy")) return `energy-too-low-for-plan:${q.duration_minutes}m/${q.difficulty}`;
  if (EXHAUSTED.test(c.excuse || "")) {
    const m = scanHit(steps, HIGH_ENERGY);
    if (m) return `excuse-mismatch:${m}`;
  }
  if (c.chaos <= 1) {
    const m = scanHit(fields, WILD);
    if (m) return `chaos-mismatch:${m}`;
  }
  if (c.social === "secret") {
    const m = scanHit(fields, GEOPOST);
    if (m) return `secret-visibility:${m}`;
  }
  if (c.social === "dog") {
    const m = scanHit(steps, INDOOR_DOG);
    if (m) return `dog-mismatch:${m}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// STAGE 3: real-world grounding via SerpApi. Only discovered places are
// handed to the model; if discovery fails the quest is location-independent.
// ---------------------------------------------------------------------------
async function discover(c, signal) {
  if (!process.env.SERPAPI_KEY || !c.city) return [];
  const queries = [
    `hidden gems unusual public spaces in ${c.city}`,
    `parks gardens viewpoints street art in ${c.city}`,
    `markets bookstores landmarks cafes in ${c.city}`,
  ];
  if (c.energy < 30) queries.length = 1;
  const seen = new Set(), out = [];
  const one = async (q) => {
    const u = new URL("https://serpapi.com/search.json");
    u.search = new URLSearchParams({ engine: "google_maps", type: "search", hl: "en", q, api_key: process.env.SERPAPI_KEY }).toString();
    const r = await fetch(u, { signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(typeof j.error === "string" ? j.error : `http ${r.status}`);
    return j.local_results || [];
  };
  // Queries run in parallel: discovery is never allowed to dominate latency.
  const settled = await Promise.allSettled(queries.map(one));
  let ok = 0;
  for (const s of settled) {
    if (s.status === "fulfilled") ok++;
    else continue;
  }
  if (!ok) throw new Error("serpapi unreachable");
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const p of s.value) {
      if (p.title && !seen.has(p.title)) {
        seen.add(p.title);
        out.push({ name: p.title, address: p.address || "", source: "serpapi" });
      }
    }
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

// ---------------------------------------------------------------------------
// STAGE 2: Gemma prompt. Strict JSON out, archetypes in, safety always on.
// ---------------------------------------------------------------------------
const ARCHETYPES = `SCAVENGER (find 3 things matching a visual pattern) | EXPLORER (a route you have never taken) | PHOTO HUNT (capture a strange colour, texture, sign, shadow, reflection) | OBSERVER (something most people walk past) | MICRO-ADVENTURE (a public place you have never entered) | NATURE (an unusual leaf, flower, tree, bird, cloud - observe only, never disturb) | ARCHITECT (the weirdest balcony, doorway, window, street detail) | SOUND HUNT (three distinct sounds, identified) | COLOR QUEST (a sequence of colours in the environment) | MEMORY QUEST (a familiar place via a completely different route) | NPC MODE (a mission from a fictional NPC, no stranger interaction) | MAIN CHARACTER (one small cinematic IRL moment) | MYSTERY (a clue leads to a nearby discovery) | BOSS QUEST (longer, combines several discoveries)`;

function buildPrompt(c, places, feedback, history) {
  const max = maxMinutes(c);
  const recentCats = history.slice(0, 6).map((h) => h.category).filter(Boolean);
  const playerWords = c.excuse ? `\n- the player's own words: "${c.excuse}" (take this seriously, the quest should feel like it was written for this person)` : "";
  const placeBlock = places.length
    ? `VERIFIED REAL PLACES near the player (use by name only if listed, never invent a place): ${JSON.stringify(places)}`
    : "NO PLACES VERIFIED. Write a location-independent quest using only generic public features near any home (street, park, corner, shopfront). Do NOT name any specific business or landmark.";
  const feedbackBlock = feedback
    ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED BY THE GATE: ${feedback}\nGenerate a DIFFERENT quest that fixes this. Do not retry the same idea.`
    : "";
  const historyBlock = recentCats.length ? `\n- recently used categories, DO NOT repeat: ${recentCats.join(", ")}` : "";

  return `You are the quest designer for OUTLAND, an app whose tagline is "your neighborhood has side quests."
You write REAL-WORLD side quests a person finishes on foot, in public, near home.

PLAYER STATE
- mood: ${STATE_TEXT[c.state]}${playerWords}
- energy: ${c.energy}%
- time available: ${max} minutes
- budget: INR ${c.budget}
- social: ${SOCIAL_TEXT[c.social]}
- chaos: ${c.chaos}/5 (1 calm, 5 unhinged-but-legal)
- city: ${c.city || "unknown"}${historyBlock}

${placeBlock}

CHOOSE ONE ARCHETYPE THAT FITS THIS PLAYER, THEN COMMIT TO IT:
${ARCHETYPES}

RARITY - choose exactly one:
COMMON (simple observation) | UNCOMMON (unusual neighbourhood discovery) | RARE (specific environmental hunt) | EPIC (multi-stage micro-adventure) | LEGENDARY (unusual but still realistic and safe)
Rarity raises creativity and XP. Rarity NEVER raises risk, cost, or time beyond the player's limits.

OUTPUT ONLY THE JSON OBJECT. No markdown, no commentary, no analysis, no text before or after the braces. Exactly this shape:
{"title":"","hook":"","objective":"","steps":["","",""],"duration_minutes":0,"budget":0,"difficulty":"easy|medium|hard","xp":0,"category":"","done_when":"","safety":["",""],"rarity":"COMMON|UNCOMMON|RARE|EPIC|LEGENDARY","bonus_objective":"","secret_objective":""}

THE CORE STANDARD - READ THIS TWICE
A quest works when the player reads it and thinks "that's weird, I actually want to try that." It fails when the player thinks "an AI wrote a dramatic paragraph."
So every quest MUST contain at least one genuinely interesting real-world thing: a discovery, a detail nobody notices, a strange object, an unusual route, a small surprise worth texting a friend about. If your quest could be completed by pacing around a room while thinking about it, it is not a quest.

HOOK RULE - the hook states the actual interesting thing, never a mood:
- GOOD: "There is a bench you have never sat on. It is probably offended."
- GOOD: "Your brain has been running 47 tabs. Close exactly one."
- GOOD: "The oldest door on your block has a number nobody can read anymore."
- BAD: "Your party stands at the threshold; make your entrance count." (says nothing about the quest)
- BAD: "Accept this contract and prove your focus still works." (empty motivation)
The hook must name the concrete detail, discovery or surprise the quest is built around, or refer to the player's own stated words. 140 chars max, second person.

ANTI-POETRY - banned in title, hook and objective:
destiny, fate, legend, hero, glory, epic, odyssey, saga, embark, prophecy, champion, vanquish, unleash, seize the day, answer the call, the adventure begins, are you ready, rise and grind, make it count, your legend, greatness. No slogans, no motivational padding, no fake epic language. Real places and real objects are always more interesting than grandeur.

PERSONALIZATION - the quest must match this exact player, not a generic one:
- social is "${SOCIAL_TEXT[c.social]}": if they are alone (solo/secret/dog) the quest must never mention a party, crew, squad or friends, and must not require talking to anyone. If they are with friends, the quest may use them.
- energy ${c.energy}%: low energy means near the front door, sitting or slow wandering, difficulty easy. Never hand an exhausted player a high-effort plan.
- time: ${max} minutes hard cap. budget: INR ${c.budget} hard cap - with INR 0 the quest must cost nothing, so no buying, ordering, tickets or entry fees.
- chaos ${c.chaos}/5: chaos 1-2 wants calm and tidy, chaos 4-5 wants strange and playful. Still legal and safe.
- the player's own words (if given) are the brief: the quest should visibly answer them.

DESIGN RULES
1. title: ALL CAPS, 2-6 words, specific and memorable - a mission name, never an instruction, never generic epic language.
2. hook: one line, max 140 chars, following HOOK RULE above.
3. objective: one sentence describing the win, with the concrete thing named.
4. steps: 2 to 5 short concrete outdoor actions in public space. Each names something specific ("the oldest doorway on your block", "the shadiest bench you can find"), never vague words like "explore" or "look around". At least two steps must be an act of finding, noticing, photographing, listening to or comparing something real.
5. duration_minutes must fit BOTH the ${max} minutes available and the player's energy. budget must be 0 unless the quest genuinely needs money and stays inside INR ${c.budget}.
6. difficulty: easy | medium | hard, honest for this player's energy. energy 10-30 means easy, near the front door.
7. xp: 30-200, scaled by rarity and effort.
8. category: the archetype name you chose, in the exact form above.
9. done_when: one concrete checkable sentence stating how the player knows it is finished.
10. safety: 1-2 short practical warnings for the player.
11. bonus_objective: an optional extra worth BONUS XP, "" if it does not fit. secret_objective: an optional hidden delight, "" if it does not fit - it must never be required to finish.
12. Ground the quest in the verified places when given, otherwise keep it location-independent. Never hallucinate a specific place name.
13. HARD SAFETY BANS - the quest must NEVER instruct any of: touching or moving electrical or utility infrastructure, climbing anything, entering private, restricted or abandoned places, crossing dangerous roads, approaching or talking to strangers unless the social mode explicitly allows it, disturbing wildlife, moving or damaging public property, fire, weapons, substances, rail tracks, sewers, anything illegal or after dark.
14. VERBS: prefer observe, photograph, walk, notice, discover, listen, compare, find, explore, document. Avoid touch, move, climb, enter, approach, cross, interact unless clearly safe.
15. Never repeat a recent category. No arbitrary precision ("exactly 37 steps"), no counting your own steps, no generic "take a walk".
16. Keep every string short and complete - the whole answer must fit in ${TIMING.max_output_tokens} tokens. Cut adjectives before you cut the concrete detail.${feedbackBlock}`;
}

// ---------------------------------------------------------------------------
// Gemma calls. Route 1: OpenRouter free gemma chat completions. Route 2:
// Google AI Studio gemma on the free key. Every attempt is bounded twice:
// per-route timeout (TIMING.primary_attempt_ms / fallback_attempt_ms) and a
// shared deadline for the whole chain (TIMING.gen_budget_ms). A 429 opens a
// circuit breaker, so a rate-limited provider is skipped on later requests
// instead of being re-probed and re-waited on. Thought/reasoning output is
// never parsed - only visible completion text.
// ---------------------------------------------------------------------------
function httpError(status, j) {
  const e = new Error(`http ${status} ${String((j && j.error && j.error.message) || "").trim()}`.trim());
  e.status = status;
  return e;
}

// Returns {text, finish, tokens}: finish/tokens are recorded in the trace so
// a truncated answer (finishReason MAX_TOKENS) is visible instead of looking
// like a generic parse failure.
async function callRoute(route, model, prompt, signal) {
  if (route.kind === "openrouter") {
    const r = await fetch(`https://${route.host}/api/v1/chat/completions`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${route.key}`, "X-Title": "Outland" },
      body: JSON.stringify({ model, temperature: 0.8, max_tokens: TIMING.max_output_tokens, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(r.status, j);
    const ch = j.choices && j.choices[0];
    return { text: ch?.message?.content || "", finish: ch?.finish_reason || null, tokens: j.usage?.completion_tokens ?? null };
  }
  const r = await fetch(`https://${route.host}/v1beta/models/${model}:generateContent?key=${route.key}`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.8, maxOutputTokens: TIMING.max_output_tokens },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(r.status, j);
  const cand = j.candidates && j.candidates[0];
  const parts = cand?.content?.parts || [];
  return {
    text: parts.filter((p) => !p.thought).map((p) => p.text || "").join("\n"),
    finish: cand?.finishReason || null,
    tokens: j.usageMetadata?.candidatesTokenCount ?? null,
  };
}

const isTimeout = (e) => !!e && (e.name === "TimeoutError" || e.name === "AbortError" || e.code === 20 || /abort|timeout/i.test(String(e.message || "")));

// Returns the quest object, or null. The bare document is tried first so a
// model that wraps its answer in prose still parses when the object is clean.
// Truncated answers (finishReason MAX_TOKENS) are salvaged when the object is
// the only malformed part: closing braces are appended and whatever parsed
// cleanly still goes through the gates - a missing field is caught there.
function parseJson(text) {
  const s = String(text || "").trim();
  if (!s) return { raw: null, why: "no JSON" };
  const obj = s.match(/\{[\s\S]*\}/);
  if (obj) { try { return { raw: JSON.parse(obj[0]), why: null }; } catch { /* fall through */ } }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return { raw: JSON.parse(fence[1].trim()), why: null }; } catch { /* fall through */ } }
  const open = s.indexOf("{");
  if (open >= 0) {
    const cut = s.slice(open);
    let detail = "bad JSON";
    for (let depth = 1; depth <= 8; depth++) {
      try { return { raw: JSON.parse(cut + "}".repeat(depth)), why: null }; } catch (e) { detail = e.message; }
    }
    return { raw: null, why: "no JSON", detail };
  }
  return { raw: null, why: "no JSON" };
}

// The shorter of the per-attempt cap and whatever the caller still allows.
function attemptSignal(outer, ms) {
  const t = AbortSignal.timeout(ms);
  if (!outer) return t;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([t, outer]) : t;
}

// opts (all optional, tests inject fakes): routes, call, health, timings,
// deadline, signal. Throws with .routeTrace attached so the caller can keep
// every attempt visible even when the whole chain fails.
export async function gemma(c, places, feedback, history, opts = {}) {
  const routes = opts.routes && opts.routes.length ? opts.routes : ROUTES;
  if (!routes.length) throw new Error("no free gemma route configured (set OPENROUTER_API_KEY or GEMMA_API_KEY)");
  const call = opts.call || callRoute;
  const health = opts.health || routeHealth;
  const T = opts.timings || TIMING;
  const outer = opts.signal || null;
  const deadline = opts.deadline || Date.now() + T.gen_budget_ms;
  const prompt = buildPrompt(c, places, feedback, history);
  const started = Date.now();
  const errors = [], routeTrace = [];
  const down = (route) => {
    const h = health.get(routeKey(route));
    return h && h.until > Date.now() ? h : null;
  };
  // Record a failure and open (or extend) the circuit. The failure count
  // survives an expired cooldown and is only cleared by a success, so two
  // timeouts in a row mean the second one is skipped for twice as long.
  const openCircuit = (route, base, reason) => {
    const key = routeKey(route);
    const prev = health.get(key);
    const fails = ((prev && prev.fails) || 0) + 1;
    const cooldown = Math.min(base * 2 ** (fails - 1), T.cooldown_max_ms || 120000);
    health.set(key, { until: Date.now() + cooldown, reason, fails });
    return cooldown;
  };

  for (const route of routes) {
    for (const model of route.models) {
      const h = down(route);
      if (h) {
        routeTrace.push({ stage: "route_skip", provider: route.provider, endpoint: route.host, ok: false, reason: `circuit open: ${h.reason}`, retry_in_ms: h.until - Date.now() });
        errors.push(`${route.provider}: skipped, circuit open (${h.reason})`);
        break; // next route
      }
      const left = deadline - Date.now();
      if (left < T.min_attempt_ms) {
        routeTrace.push({ stage: "budget_exhausted", ok: false, elapsed_ms: Date.now() - started, reason: `only ${left}ms left of the ${T.gen_budget_ms}ms generation budget` });
        const err = new Error(`${errors.join("; ")}; generation budget exhausted after ${Date.now() - started}ms`.replace(/^; /, ""));
        err.routeTrace = routeTrace;
        throw err;
      }
      const capMs = Math.min(route.kind === "openrouter" ? T.primary_attempt_ms : T.fallback_attempt_ms, left);
      const t1 = Date.now();
      let out;
      try {
        out = await call(route, model, prompt, attemptSignal(outer, capMs));
      } catch (e) {
        const timeout = isTimeout(e);
        const status = (e && e.status) || 0;
        const reason = timeout ? `timeout after ${capMs}ms` : redact(e);
        errors.push(`${route.provider}/${model}: ${reason}`);
        routeTrace.push({ stage: "route_attempt", provider: route.provider, endpoint: route.host, model, ok: false, reason, attempt_ms: Date.now() - t1 });
        // No blind retry for a provider that just told us it cannot serve us,
        // and each consecutive failure extends the time it stays skipped.
        if (timeout) openCircuit(route, T.cooldown_error_ms, `timeout after ${capMs}ms`);
        else if (status === 429) openCircuit(route, T.cooldown_429_ms, "http 429 rate limited");
        else if (status >= 500) openCircuit(route, T.cooldown_error_ms, `http ${status}`);
        continue; // next model
      }
      // Test fakes return a bare string; the real callRoute returns metadata.
      const res = typeof out === "string" ? { text: out } : (out || {});
      const parsed = parseJson(res.text);
      if (!parsed.raw) {
        const truncated = res.finish === "MAX_TOKENS" ? " (cut off by max_output_tokens)" : "";
        errors.push(`${route.provider}/${model}: ${parsed.why}${truncated}`);
        routeTrace.push({ stage: "route_attempt", provider: route.provider, endpoint: route.host, model, ok: false, reason: `${parsed.why}${truncated}`, finish: res.finish || null, attempt_ms: Date.now() - t1 });
        continue;
      }
      health.delete(routeKey(route)); // a working route never stays in a breaker
      routeTrace.push({ stage: "route_attempt", provider: route.provider, endpoint: route.host, model, ok: true, finish: res.finish || null, tokens: res.tokens ?? null, attempt_ms: Date.now() - t1 });
      return { raw: parsed.raw, model, provider: route.provider, endpoint: route.host, latency_ms: Date.now() - started, routeTrace };
    }
  }
  const err = new Error(errors.join("; ") || "no gemma model available");
  err.routeTrace = routeTrace;
  throw err;
}

// ---------------------------------------------------------------------------
// Curated fallback: only when every Gemma attempt is rejected by the gates.
// ---------------------------------------------------------------------------
const OUTING = [
  { min: 0, title: "THE 400-METER EXPEDITION", rarity: "COMMON", category: "EXPLORER", difficulty: "easy", duration_minutes: 12, budget: 0, xp: 35,
    hook: "Everything interesting is within 400 metres of your door. Prove it.",
    objective: "Leave the building and return with one thing you had never actually noticed.",
    steps: ["Step outside and stand still for 30 seconds with your phone in your pocket.","Find the most worn-looking leaf on the ground beneath the nearest tree and photograph it.","Look at one doorway or shop window on your street you have never really looked at.","Take the long way home, even if it only adds one minute."],
    bonus_objective: "Find something shaped like a letter of the alphabet.",
    secret_objective: "",
    done_when: "You left the building, documented a leaf, and came back with one thing you had never noticed." },
  { min: 0, title: "QUIET PATCH", rarity: "COMMON", category: "NATURE", difficulty: "easy", duration_minutes: 8, budget: 0, xp: 30,
    hook: "Find one quiet spot and notice three small things.",
    objective: "Sit quietly near your door and observe.",
    steps: ["Step outside and find the quietest spot nearby.","Sit for two minutes with no phone scrolling.","Notice three quiet sounds.","Find one tiny detail you'd normally miss."],
    bonus_objective: "Spot an unusual shadow.", secret_objective: "", done_when: "You sat quietly, identified three sounds, and found one small detail." },
  { min: 0, title: "ONE LEAF QUEST", rarity: "COMMON", category: "PHOTO HUNT", difficulty: "easy", duration_minutes: 8, budget: 0, xp: 28,
    hook: "Just find the weirdest leaf on your street.",
    objective: "Photograph the weirdest leaf you can find nearby.",
    steps: ["Scan the ground near your building.","Compare at least three leaves.","Photograph your chosen leaf.","Head back."],
    bonus_objective: "Find a leaf with an unexpected shape.", secret_objective: "", done_when: "You photographed a weird leaf." },
  { min: 5, title: "THREE SOUNDS", rarity: "UNCOMMON", category: "SOUND HUNT", difficulty: "easy", duration_minutes: 10, budget: 0, xp: 35,
    hook: "Close your eyes. What are you missing?",
    objective: "Identify three distinct sounds nearby.",
    steps: ["Sit or stand comfortably.","Close eyes for one minute and listen.","Name three sounds.","Locate each source."],
    bonus_objective: "Find a sound you've never noticed.", secret_objective: "", done_when: "You identified and located three sounds." },
  { min: 10, title: "STREET LETTERS", rarity: "COMMON", category: "PHOTO HUNT", difficulty: "easy", duration_minutes: 12, budget: 0, xp: 35,
    hook: "The alphabet is hiding on your block.",
    objective: "Find letter shapes in your environment.",
    steps: ["Walk slowly around your block.","Find at least three letter shapes.","Photograph them.","Try to spell a short word."],
    bonus_objective: "Find a letter made by shadow.", secret_objective: "", done_when: "You found at least three letter shapes." },
  { min: 15, title: "THE LOOP OF UNPROVOKED FRESH AIR", rarity: "UNCOMMON", category: "MEMORY QUEST", difficulty: "medium", duration_minutes: 25, budget: 0, xp: 55,
    hook: "There is a bench you have never sat on. It is probably offended.",
    objective: "Sit somewhere new and see three things your window can't show you.",
    steps: ["Walk until you see something taller than your building.","Find a bench or step and sit 2 minutes without apps.","Spot three things you couldn't see from window.","Return by different road."],
    bonus_objective: "Photograph the strangest shadow.", secret_objective: "Find something that makes you wonder.", done_when: "Sat somewhere new, saw three things, looped home." },
  { min: 20, title: "COLOR HUNT", rarity: "UNCOMMON", category: "COLOR QUEST", difficulty: "medium", duration_minutes: 20, budget: 0, xp: 45,
    hook: "Hunt for five colors you rarely notice.",
    objective: "Find and photograph five different colors.",
    steps: ["Pick five colors.","Find each as a detail.","Photograph all five.","Compare hardest to find."],
    bonus_objective: "Find an unusual shade.", secret_objective: "", done_when: "You photographed five distinct colors." },
  { min: 30, title: "THE NEIGHBOURHOOD LORE RUN", rarity: "RARE", category: "OBSERVER", difficulty: "medium", duration_minutes: 45, budget: 0, xp: 85,
    hook: "The oldest thing on the block is usually the ugliest. Go find it.",
    objective: "Walk an unfamiliar street end to end and return with one old thing and one made thing.",
    steps: ["Walk an unfamiliar street end to end.","Find the oldest thing you can see.","Find something painted/made on purpose.","Stand in a quiet spot 1 minute.","Note the street you wouldn't have entered."],
    bonus_objective: "Find an old house number.", secret_objective: "", done_when: "Walked unfamiliar street end to end; logged old and made thing." },
  { min: 40, title: "MICRO EXPEDITION", rarity: "UNCOMMON", category: "EXPLORER", difficulty: "medium", duration_minutes: 30, budget: 0, xp: 60,
    hook: "Explore one unfamiliar street you keep passing.",
    objective: "Walk an unfamiliar street end to end and find three details.",
    steps: ["Find unfamiliar street.","Walk end to end.","Find three details.","Return different way."],
    bonus_objective: "Find something funny.", secret_objective: "", done_when: "Walked street end to end, found three details." },
  { min: 81, title: "FARTHER THAN USUAL", rarity: "EPIC", category: "BOSS QUEST", difficulty: "hard", duration_minutes: 75, budget: 0, xp: 130,
    hook: "Stand somewhere you have never stood and look back at your own street.",
    objective: "Reach a viewpoint you never visited and come home on foot.",
    steps: ["Go to viewpoint >=15min away.","Find a viewpoint.","Memorize one detail.","Head back within budget.","Return under own steam."],
    bonus_objective: "Spot red on every block.", secret_objective: "Find a view worth remembering.", done_when: "Reached new viewpoint and returned." },
];;
// Low-effort states: the player can barely move (energy <= 30) or the mood
// itself says "do not send me far" (rotting in bed, needs to disappear).
const GENTLE_STATES = new Set(["rotting", "disappear"]);
export const gentle = (c) => c.energy <= 30 || GENTLE_STATES.has(c.state);

// Outings the player can actually finish: inside their energy floor and their
// budget. Time is applied by clamping, never by silently promising more than
// they said they had.
const eligible = (c) => OUTING.filter((o) => c.energy >= o.min && o.budget <= c.budget);

// First pick of the curated pool. A gentle state gets the shortest outing that
// clears its energy floor, not simply the first entry that does.
export const curated = (c) => {
  const pool = eligible(c);
  const list = pool.length ? pool : OUTING;
  const q = gentle(c)
    ? list.reduce((best, o) => (o.duration_minutes < best.duration_minutes || (o.duration_minutes === best.duration_minutes && o.min < best.min) ? o : best), list[0])
    : list[0];
  return { ...q, duration_minutes: Math.min(q.duration_minutes, maxMinutes(c)) };
};

// Optional quest history store. Silently skipped when MONGODB_URI is unset.
let db = null;
async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return;
  try {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db("outland");
    await db.collection("quests").createIndex({ createdAt: -1 });
    console.log("mongodb connected");
  } catch (e) { console.log("mongodb skipped:", redact(e)); }
}
function logQuest(doc) {
  if (!db) return;
  db.collection("quests").insertOne({ ...doc, createdAt: new Date() }).catch((e) => console.log("mongo write failed:", redact(e)));
}

// In-process ring of the last quests, drives duplicate and variety gates.
const recent = [];

app.get("/health", (_q, s) => s.json({
  ok: true,
  routes: ROUTES.map((r) => {
    const h = routeState(r);
    return { provider: r.provider, endpoint: r.host, models: r.models, circuit: h ? "open" : "closed", down_reason: h ? h.reason : null, retry_in_ms: h ? h.retry_in_ms : 0 };
  }),
  timing: TIMING,
  openrouter: !!openRouterKey, gemma_key: !!googleKey, serpapi: !!process.env.SERPAPI_KEY,
  mongo: !!db, sentry: SENTRY_ON,
}));

app.post("/api/quest", async (req, res) => {
  const c = validate(req.body);
  if (!c) return res.status(400).json({ error: "invalid input" });
  const t0 = Date.now();
  let quest = null, source = "curated-fallback", feedback = "", served = null, failReason = "";
  const trace = [{ stage: "state_extraction", ok: true, mood: c.state, energy: c.energy, minutes: maxMinutes(c), budget: c.budget, social: c.social, chaos: c.chaos, city: c.city || null }];

  let places = [];
  if (process.env.SERPAPI_KEY && c.city) {
    try {
      places = await discover(c, AbortSignal.timeout(TIMING.discovery_ms));
      trace.push({ stage: "discovery", provider: "serpapi", ok: true, found: places.length, places: places.map((p) => p.name), budget_ms: TIMING.discovery_ms });
    } catch (e) {
      trace.push({ stage: "discovery", provider: "serpapi", ok: false, error: redact(e), budget_ms: TIMING.discovery_ms, note: "fallback: location-independent quest" });
    }
  } else {
    trace.push({ stage: "discovery", provider: "serpapi", ok: false, skipped: process.env.SERPAPI_KEY ? "no city provided" : "SERPAPI_KEY missing", note: "fallback: location-independent quest" });
  }

  // Fast path: if every configured route is already inside its cooldown, say so
  // up front. gemma() then only emits route_skip entries, so the request costs
  // a few milliseconds instead of a provider timeout.
  const routesCfg = ROUTES || [];
  const anyHealthy = routesCfg.some((r) => !routeState(r));
  if (!anyHealthy && routesCfg.length) {
    failReason = "circuit-open";
    trace.push({ stage: "circuit_check", ok: false, reason: "all routes unhealthy", note: "fast fallback to avoid waiting for provider timeouts" });
  }
  // One deadline governs every generation attempt, including regenerations.
  const deadline = Date.now() + TIMING.gen_budget_ms;
  for (let attempt = 1; attempt <= 3 && !quest; attempt++) {
    const stage = attempt === 1 ? "gemma_generate" : "gemma_regenerate";
    const left = deadline - Date.now();
    if (left < TIMING.min_regenerate_ms) {
      failReason = "generation-timeout";
      trace.push({ stage: "budget_exhausted", attempt, ok: false, reason: `${TIMING.gen_budget_ms}ms generation budget spent, ${left}ms left`, note: "no time for another attempt" });
      break;
    }
    let out;
    try {
      out = await gemma(c, places, feedback, recent, { deadline });
    } catch (e) {
      const rt = e.routeTrace || [];
      for (const a of rt) trace.push(a);
      // Nothing was attempted: every route was skipped by an open circuit, so
      // the skips are the whole story. A generation-failure stage here would
      // bury the real reason and label an immediate fallback as a timeout.
      if (rt.length && rt.every((a) => a.stage === "route_skip")) {
        failReason = "circuit-open";
      } else {
        failReason = /budget|timeout/i.test(String(e.message || "")) ? "generation-timeout" : "no-free-gemma-route";
        trace.push({ stage, attempt, ok: false, error: redact(e), elapsed_ms: Date.now() - t0 });
      }
      break;
    }
    for (const a of out.routeTrace) trace.push(a);
    trace.push({ stage, attempt, provider: out.provider, endpoint: out.endpoint, model: out.model, ok: true, latency_ms: out.latency_ms });

    const s = safety(out.raw, c);
    if (!s.ok) {
      trace.push({ stage: "safety", attempt, ok: false, reason: s.reason, raw: JSON.stringify(out.raw).slice(0, 160) });
      feedback = `schema/safety gate rejected it: ${s.reason}. Fix that field and answer again with the same format.`;
      continue;
    }
    trace.push({ stage: "safety", attempt, ok: true });

    // Rejected quests are recorded (title + hook only) so a fallback can be
    // diagnosed from the stored trace instead of by re-running the request.
    const seen = { title: s.quest.title, hook: s.quest.hook };
    const bad = quality(s.quest, c, recent, places);
    if (bad) {
      trace.push({ stage: "quality", attempt, ok: false, reason: bad, ...seen });
      feedback = gateFeedback(bad);
      continue;
    }
    trace.push({ stage: "quality", attempt, ok: true });

    const f = fit(s.quest, c);
    if (f) {
      trace.push({ stage: "personalization", attempt, ok: false, reason: f, ...seen });
      feedback = `personalization gate rejected it: ${f}. The player profile in the prompt is not decoration - match it exactly.`;
      continue;
    }
    trace.push({ stage: "personalization", attempt, ok: true });

    quest = s.quest;
    source = out.model;
    served = { provider: out.provider, endpoint: out.endpoint };
  }

  if (!quest) {
    // The curated fallback must still clear the gates; if the chosen outing
    // is rejected (it depends on the player's input) the next one is tried.
    // A curated quest that clears safety but not the taste gate is still
    // served - it is hand-written - and the miss is reported in the trace.
    const clamp = (o) => ({ ...o, duration_minutes: Math.min(o.duration_minutes, maxMinutes(c)) });
    const seenTitles = new Map();
    for (const o of [curated(c), ...eligible(c).map(clamp)]) if (!seenTitles.has(o.title)) seenTitles.set(o.title, o);
    const cands = [...seenTitles.values()];
    // Gentle states read the pool lightest-first, so the outing that survives
    // the gates is the cheapest one the player can actually finish.
    if (gentle(c)) cands.sort((a, b) => a.duration_minutes - b.duration_minutes || a.min - b.min);
    let picked = null, curatedQuality = false, curatedWhy = "";
    for (const cand of cands) {
      const sc = safety(cand, c);
      if (!sc.ok) continue;
      picked = picked || sc.quest;
      const taste = quality(sc.quest, c, recent, places);
      curatedWhy = taste || "";
      // A gentle state stops at the gentlest outing that clears safety. The
      // taste gate grades model output (hook markers, discovery verbs) and
      // must not be allowed to promote a longer expedition over a player who
      // is rotting in bed - the miss is still reported in the trace below.
      if (gentle(c)) { curatedQuality = !taste; break; }
      if (!taste) { picked = sc.quest; curatedQuality = true; break; }
    }
    // The pool is tiny, so when every candidate reads as a repeat of the
    // recent history, rotate the category instead of serving the same
    // outing for the N-th request in a row.
    if (!curatedQuality && picked) {
      const lastCats = new Set(recent.slice(0, 3).map((h) => h.category));
      for (const cand of cands) {
        const sc = safety(cand, c);
        if (sc.ok && !lastCats.has(sc.quest.category)) { picked = sc.quest; break; }
      }
    }
    if (!picked) {
      trace.push({ stage: "curated_fallback", ok: false, reason: "every curated outing was rejected", note: "refusing to serve an unvetted quest" });
      logQuest({ input: c, source: "curated-fallback", failed: true, trace });
      return res.status(503).json({ error: "no safe quest available", trace });
    }
    quest = picked;
    source = "curated-fallback";
    failReason = failReason || "gates-rejected";
    trace.push({ stage: "safety", ok: true, source: "curated" });
    trace.push({ stage: "quality", ok: curatedQuality, source: "curated", ...(curatedQuality ? {} : { reason: curatedWhy || "curated pool", note: "curated content is hand-written; the AI taste gate does not apply to it" }) });
    trace.push({ stage: "curated_fallback", ok: true, reason: failReason, note: "gemma did not deliver a quest that passed every gate inside the budget" });
    if (SENTRY_ON) Sentry.captureMessage(`quest fallback: ${JSON.stringify(trace)}`, "warning");
  }
  recent.unshift({ title: quest.title, category: quest.category, objective: quest.objective, steps: quest.steps });
  if (recent.length > 8) recent.pop();

  trace.push({ stage: "ready", model: source, rarity: quest.rarity, xp: quest.xp, archetype: quest.category, latency_ms: Date.now() - t0 });
  const payload = {
    quest, source,
    provider: served ? served.provider : null,
    endpoint: served ? served.endpoint : null,
    fallback: served ? null : { reason: failReason, quest: "curated" },
    trace, latency_ms: Date.now() - t0,
  };
  logQuest({ input: c, source, latency_ms: payload.latency_ms, trace, quest_title: quest.title });
  res.json(payload);
});

if (SENTRY_ON) Sentry.setupExpressErrorHandler(app);
app.use((err, _req, res, _next) => { if (SENTRY_ON) Sentry.captureException(err); res.status(500).json({ error: "server error" }); });

const port = process.env.PORT || 3000;
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  connectMongo().catch(() => {});
  app.listen(port, () => console.log(`outland on ${port} · free gemma routes: ${ROUTES.map((r) => `${r.provider}(${r.models.join("|")})`).join(" -> ") || "NONE CONFIGURED"}`));
}
