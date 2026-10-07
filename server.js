import "dotenv/config";
import * as Sentry from "@sentry/node";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const SENTRY_ON = !!process.env.SENTRY_DSN;
if (SENTRY_ON) Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || "development", tracesSampleRate: 0.2, release: "outland@0.1.0" });

const app = express();
const DIR = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(DIR, "public")));
app.get("/", (_q, s) => s.sendFile(path.join(DIR, "index.html")));
if (SENTRY_ON) app.use(Sentry.expressRequestHandler());

// Fallback chain, comma-separated, first model that returns passable JSON wins.
// gemma-4-26b-a4b-it works on this key but takes ~55s/call, so Gemini is default.
const MODELS = (process.env.GEMMA_MODEL || "gemini-3.5-flash-lite,gemini-flash-lite-latest")
  .split(",").map((m) => m.trim()).filter(Boolean);
const UNSAFE = /trespass|climb|roof|fence|private propert|abandoned|after dark|midnight|highway|traffic|swim|stranger|illegal|restricted|blindfold|weapon|knife|fire|medicine|prescription|alcohol/gi;
const NEGATE = /\b(never|no|not|n't|don'?t|do not|avoid|without|skip|stay|keep|refrain|away|zero|don't)\b/i;
const OUTDOOR = /outside|street|road|path|sidewalk|pavement|park|tree|sky|bench|corner|shop|store|market|bridge|river|lake|gate|block|door|walk|route|building|statue|cafe|library|station|garden|plaza|square|lane|sun|cloud|bird|plant|flower|fountain|stair|hill|view|sign|mural|cable|wire|bus|train|pond|shore|field|court|alley|steps|porch|balcony|neighbourhood|neighborhood/i;
const STATES = ["rotting","scrolling","leave-room","tabs","low-battery","side-quest","new-sight","disappear","dunno","main-character","surprise"];
const BUDGETS = [0, 50, 200, 500];
const SOCIAL = ["solo","yapper","group","dog","meet-humans","secret"];

export function validate(b) {
  const ok = b && STATES.includes(b.state) && [10,30,50,80,100].includes(b.energy) &&
    BUDGETS.includes(b.budget) && SOCIAL.includes(b.social) && Number.isInteger(b.chaos) && b.chaos >= 1 && b.chaos <= 5;
  return ok ? { ...b, city: typeof b.city === "string" ? b.city.slice(0, 60) : "" } : null;
}

// Negation-aware scan so "avoid strangers" passes while "talk to a stranger" fails.
function hasUnsafe(text) {
  for (const m of text.matchAll(UNSAFE)) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (!NEGATE.test(before)) return true;
  }
  return false;
}

// Stage 4: safety validation. Rejects or sanitises model output.
export function safety(q, c) {
  if (!q || !q.title || !Array.isArray(q.steps) || q.steps.length < 2 || !q.completion_condition) return { ok: false, reason: "schema" };
  // safety_notes are excluded: they legitimately mention things like "don't talk to strangers".
  const scan = JSON.stringify({ title: q.title, mission_type: q.mission_type, steps: q.steps, clues: q.clues, completion_condition: q.completion_condition });
  if (hasUnsafe(scan)) return { ok: false, reason: "unsafe-content" };
  q.duration_minutes = Math.min(Math.max(+q.duration_minutes || 20, 5), 20 + c.energy * 1.5);
  q.budget = Math.min(+q.budget || 0, c.budget);
  q.difficulty = c.chaos;
  q.xp = 40 + c.chaos * 20;
  q.safety_notes = [...(q.safety_notes || []), "Stay in public, well-lit places. Skip any step that feels unsafe."];
  return { ok: true, quest: q };
}

// Stage 5: anti-slop gate. Generic indoor quests get rejected and regenerated.
export function quality(q, c) {
  if (String(q.title).trim().length < 8) return "weak-title";
  if (q.steps.length < 4) return "too-few-steps";
  if (q.steps.some((s) => typeof s !== "string" || s.trim().length < 12 || s.length > 220)) return "weak-step";
  if (c.energy >= 30 && !q.steps.some((s) => OUTDOOR.test(s))) return "not-outdoors";
  return null;
}

// Hand-written quests used only when every model attempt is rejected.
const OUTING = [
  { min: 0,  title: "THE 400-METER EXPEDITION", mission_type: "doorstep", duration_minutes: 12, budget: 0, clues: ["Everything interesting is within 400 meters of your door."], steps: [
    "Step outside your building and stand still for 30 seconds with your phone in your pocket.",
    "Walk to the nearest tree and pick up the most worn-looking leaf on the ground beneath it.",
    "Find one doorway or shop window on your street you have never actually looked at before.",
    "Take the long way home, even if it only adds one minute." ],
    completion_condition: "You left the building, held a leaf, and came back with one thing you had never noticed." },
  { min: 31, title: "THE LOOP OF UNPROVOKED FRESH AIR", mission_type: "short walk", duration_minutes: 25, budget: 0, clues: ["Sit somewhere you have never sat."], steps: [
    "Leave your street and walk until you can see something taller than your building.",
    "Find a bench, a low wall, or a step and sit there for two full minutes without opening an app.",
    "Spot three things on that block that you could not have seen from your window.",
    "Walk home by a different road than the one you came by." ],
    completion_condition: "You sat somewhere new, saw three unseen things, and looped home on a new road." },
  { min: 51, title: "THE NEIGHBOURHOOD LORE RUN", mission_type: "local exploration", duration_minutes: 45, budget: 0, clues: ["The oldest thing on the block is usually the ugliest."], steps: [
    "Pick the least familiar street within ten minutes of you and walk its full length.",
    "Find the oldest thing you can see out there: a tree, a wall, a shutter, a sign.",
    "Find something painted, tiled, or tagged that someone made on purpose.",
    "Get within earshot of running water, wind in trees, or an open square and stay one minute.",
    "Walk home and name the street you would never have entered if you had stayed in." ],
    completion_condition: "You walked an unfamiliar street end to end and came back with one old thing and one made thing." },
  { min: 81, title: "THE FULL SIDE QUEST: FARTHER THAN USUAL", mission_type: "mini expedition", duration_minutes: 75, budget: 0, clues: ["Stand somewhere you have never stood and look back at your street."], steps: [
    "Leave with a destination at least fifteen minutes away on foot and commit to it.",
    "Find a viewpoint: a rise, a bridge, an elevated plaza, or the far end of a park.",
    "Do one thing you would describe to nobody: photograph, sketch, or memorise one detail.",
    "Buy or collect nothing that costs more than your budget allows, then head back.",
    "Return home and log the distance you covered without opening a map app." ],
    completion_condition: "You reached a viewpoint you had never stood at before and came home under your own steam." },
];
const outing = (c) => OUTING.find((o) => c.energy >= o.min) || OUTING[0];

function buildPrompt(c, places) {
  return `You are the quest designer for OUTLAND, an app whose tagline is "your neighborhood has side quests."
You write REAL-WORLD side quests a person finishes on foot, in public, near home.

Output ONLY JSON, no markdown, no commentary:
{"title":"","mission_type":"","duration_minutes":0,"budget":0,"steps":[],"clues":[],"location_candidates":[],"completion_condition":"","safety_notes":[]}

PLAYER: mood=${c.state}, energy=${c.energy}%, budget=INR ${c.budget}, social=${c.social}, chaos ${c.chaos}/5, city=${c.city || "unknown"}.
VERIFIED PLACES (use by name only if listed, otherwise claim no place): ${JSON.stringify(places)}

HARD RULES
1. The quest happens OUTDOOR public space. Never inside a home: no bed, couch, laundry, fridge, chores, or screen-only tasks.
2. steps: 4 to 6 entries. Each is one concrete action with a named place or object ("the oldest tree on your block"), never vague words like "explore" or "look around".
3. Budget and duration must fit the player. Do not mention money that exceeds it.
4. energy 10-30: within a few minutes of the front door, tiny effort, still outside. energy 50+: a real neighbourhood spot. energy 80+: a proper mini expedition.
5. chaos 1-2 calm, 3-4 playful and slightly absurd, 5 maximal but still legal and safe.
6. Hard bans: talking to strangers, private property, climbing, roofs, fences, highways, traffic, swimming, anything illegal, alcohol, medicine, fire, weapons, blindfolds.
7. Never require more than the player's energy allows. social=solo or secret means absolutely no interaction with people.
8. Title is ALL CAPS, specific and funny, never generic. mission_type is a 2-3 word label.
9. clues: 1-3 short cryptic hints. completion_condition: one concrete, checkable sentence. safety_notes: 1-2 short practical warnings.`;
}

async function gemma(c, places, signal) {
  const key = process.env.GEMMA_API_KEY;
  if (!key) throw new Error("GEMMA_API_KEY missing");
  const prompt = buildPrompt(c, places);
  const errors = [];
  for (const model of MODELS) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 1 },
        }),
      });
    } catch (e) { errors.push(`${model}: ${e.message}`); continue; }
    if (r.status === 404) { errors.push(`${model}: 404 unavailable`); continue; }
    if (!r.ok) { errors.push(`${model}: http ${r.status}`); continue; }
    const j = await r.json().catch(() => ({}));
    const parts = j.candidates?.[0]?.content?.parts || [];
    const t = parts.filter((p) => !p.thought).map((p) => p.text || "").join("\n");
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) { errors.push(`${model}: no JSON`); continue; }
    try { return { raw: JSON.parse(m[0]), model }; } catch { errors.push(`${model}: bad JSON`); }
  }
  throw new Error(errors.join("; ") || "no model available");
}

// Stage 3: only real places from SerpApi, never invented.
async function discover(c, signal) {
  if (!process.env.SERPAPI_KEY || !c.city || c.energy < 30) return [];
  const u = new URL("https://serpapi.com/search.json");
  u.search = new URLSearchParams({
    engine: "google_maps", type: "search", hl: "en",
    q: `parks gardens landmarks in ${c.city}`, api_key: process.env.SERPAPI_KEY,
  }).toString();
  const r = await fetch(u, { signal });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(typeof j.error === "string" ? j.error : `serpapi http ${r.status}`);
  return (j.local_results || []).slice(0, 4).map(p => ({ name: p.title, address: p.address, source: "serpapi" }));
}

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
  } catch (e) { console.log("mongodb skipped:", e.message); }
}
function logQuest(doc) {
  if (!db) return;
  db.collection("quests").insertOne({ ...doc, createdAt: new Date() }).catch((e) => console.log("mongo write failed:", e.message));
}

app.get("/health", (_q, s) => s.json({ ok: true, gemma: !!process.env.GEMMA_API_KEY, serpapi: !!process.env.SERPAPI_KEY, mongo: !!db, sentry: SENTRY_ON, models: MODELS }));

app.post("/api/quest", async (req, res) => {
  const c = validate(req.body);
  if (!c) return res.status(400).json({ error: "invalid input" });
  const trace = [{ stage: "state_extraction", ok: true }];
  const t0 = Date.now();
  const sig = () => AbortSignal.timeout(30000);
  let places = [];
  try { places = await discover(c, sig()); trace.push({ stage: "discovery", ok: true, found: places.length }); }
  catch (e) { trace.push({ stage: "discovery", ok: false, error: e.message, note: "fell back to location-independent" }); }
  let quest = null, source = "fallback";
  for (let attempt = 1; attempt <= 2 && !quest; attempt++) {
    try {
      const { raw, model } = await gemma(c, places, sig());
      const v = safety(raw, c);
      const bad = v.ok ? quality(v.quest, c) : v.reason;
      trace.push({ stage: "gemma_plan+safety", attempt, model, ok: !bad, reason: bad });
      if (!bad) { quest = v.quest; source = model; }
    } catch (e) { trace.push({ stage: "gemma_plan+safety", attempt, ok: false, error: e.message }); }
  }
  if (!quest) {
    quest = safety(outing(c), c).quest;
    trace.push({ stage: "curated_fallback", ok: true });
    if (SENTRY_ON) Sentry.captureMessage(`quest fallback: ${JSON.stringify(trace)}`, "warning");
  }
  const payload = { quest, source, trace, latency_ms: Date.now() - t0 };
  logQuest({ input: c, source, latency_ms: payload.latency_ms, trace, quest_title: quest.title });
  res.json(payload);
});

if (SENTRY_ON) Sentry.setupExpressErrorHandler(app);
app.use((err, _req, res, _next) => { if (SENTRY_ON) Sentry.captureException(err); res.status(500).json({ error: "server error" }); });

const port = process.env.PORT || 3000;
if (process.argv[1].endsWith("server.js")) {
  connectMongo().catch(() => {});
  app.listen(port, () => console.log(`outland on ${port}`));
}
