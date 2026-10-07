// Demo report: a battery of live /api/quest requests with the numbers the
// hand-off needs - provider, model, latency, fallback behaviour, gate
// outcomes, category/rarity spread and API-key leakage.
// Run: npm run demo   (server must be up: npm start)
import "dotenv/config";

const BASE = process.env.BASE || "http://localhost:3000";
const N = Number(process.env.N || 12);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60000);
const SPACING_MS = Number(process.env.SPACING_MS || 1500); // pacing between requests; bursts trip the circuit breakers and skew latency
const SECRET_KEYS = [
  process.env.OPENROUTER_API_KEY, process.env.OpenRouter_API, process.env.OPENROUTER_API,
  process.env.GEMMA_API_KEY, process.env.SERPAPI_KEY, process.env.SENTRY_DSN, process.env.MONGODB_URI,
].filter(Boolean);

const SCENARIOS = [
  ["10min/₹0/solo/low-energy", { state: "low-battery", energy: 10, budget: 0, social: "solo", chaos: 1, minutes: 10, city: "Ghaziabad" }],
  ["30min/₹0/solo", { state: "leave-room", energy: 30, budget: 0, social: "solo", chaos: 3, city: "Ghaziabad" }],
  ["60min/₹100/solo", { state: "side-quest", energy: 50, budget: 100, social: "solo", chaos: 3, minutes: 60, city: "Ghaziabad" }],
  ["see-something-weird", { state: "main-character", energy: 50, budget: 0, social: "solo", chaos: 4, excuse: "I want to see something weird" }],
  ["brain-fried", { state: "tabs", energy: 30, budget: 0, social: "solo", chaos: 2, minutes: 40, excuse: "I've been studying all day and my brain is fried" }],
  ["friend-mode", { state: "side-quest", energy: 80, budget: 200, social: "group", chaos: 3, city: "Ghaziabad" }],
  ["high-chaos", { state: "surprise", energy: 80, budget: 0, social: "solo", chaos: 5, city: "Ghaziabad" }],
  ["very-low-energy", { state: "rotting", energy: 10, budget: 0, social: "solo", chaos: 2, minutes: 15 }],
  ["dog-walk", { state: "leave-room", energy: 50, budget: 0, social: "dog", chaos: 2, city: "Ghaziabad" }],
  ["secret-mode", { state: "disappear", energy: 50, budget: 0, social: "secret", chaos: 3 }],
  ["no-city", { state: "side-quest", energy: 80, budget: 500, social: "yapper", chaos: 4 }],
  ["repeat-of-2 (distinctiveness)", { state: "leave-room", energy: 30, budget: 0, social: "solo", chaos: 3, city: "Ghaziabad" }],
];

const rows = [];
const fails = [];
const warns = [];
const check = (name, cond, msg) => { if (!cond) fails.push(`${name}: ${msg}`); };
const tally = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const hist = new Map();
const titles = [];

console.log(`outland demo report · ${N} requests · ${BASE}\n`);

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
if (!health) { console.log("server is not reachable"); process.exit(1); }
console.log("routes: " + health.routes.map((r) => `${r.provider}(${r.models.join("|")})=${r.circuit}`).join(" -> "));
console.log(`timing: gen_budget=${health.timing.gen_budget_ms}ms · attempts ${health.timing.primary_attempt_ms}/${health.timing.fallback_attempt_ms}ms · output cap ${health.timing.max_output_tokens} tokens\n`);

for (let i = 0; i < N; i++) {
  const [name, body] = SCENARIOS[i % SCENARIOS.length];
  const t0 = Date.now();
  let res, text, r;
  try {
    res = await fetch(`${BASE}/api/quest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
    r = JSON.parse(text);
  } catch (e) {
    console.log(`x ${String(i + 1).padStart(2)} ${name} :: ${e.message}`);
    fails.push(`#${i + 1} ${name}: request failed ${e.message}`);
    continue;
  }
  const label = `#${i + 1} ${name}`;
  const q = r.quest || {};
  const curated = r.source === "curated-fallback";
  const safetyStages = (r.trace || []).filter((t) => t.stage === "safety");
  const qualityStages = (r.trace || []).filter((t) => t.stage === "quality");
  const fitStages = (r.trace || []).filter((t) => t.stage === "personalization");
  const attempts = (r.trace || []).filter((t) => t.stage === "route_attempt");
  const circuitSkips = (r.trace || []).filter((t) => t.stage === "route_skip");
  const rejected = (r.trace || []).filter((t) => (t.stage === "quality" || t.stage === "personalization" || t.stage === "safety") && t.ok === false);

  check(label, res.ok, `http ${res.status}`);
  check(label, q.title && q.hook && q.objective && Array.isArray(q.steps) && q.steps.length >= 2 && q.steps.length <= 5, "schema incomplete");
  check(label, q.done_when && q.rarity && q.category && q.xp > 0, "missing game fields");
  check(label, safetyStages.length > 0 && safetyStages.at(-1).ok === true, "safety did not pass");
  check(label, SECRET_KEYS.every((k) => !text.includes(k)) && !text.includes("AIza") && !text.includes("sk-or-") && !text.includes("serpapi.com/search"), "API key leaked");
  check(label, Number.isFinite(r.latency_ms) && r.latency_ms >= 0, "no latency recorded");
  check(label, (q.budget || 0) <= body.budget, `budget ${q.budget} > ${body.budget}`);
  check(label, (q.safety || []).length >= 1, "no safety note");
  if (curated) {
    check(label, r.provider === null && r.endpoint === null, `curated claims provider=${r.provider}`);
    check(label, !!r.fallback && !!r.fallback.reason, "curated missing fallback.reason");
  } else {
    check(label, /^gemma/i.test(r.source || ""), `source=${r.source}`);
    check(label, ["openrouter", "google-generative-ai"].includes(r.provider), `provider=${r.provider}`);
    check(label, r.fallback === null, "gemma response carries fallback");
    check(label, qualityStages.length > 0 && qualityStages.at(-1).ok === true, "quality did not pass");
    check(label, fitStages.length > 0 && fitStages.at(-1).ok === true, "personalization did not pass");
  }

  rows.push({
    i: i + 1, name, source: r.source, provider: r.provider || "-", model: r.source,
    latency: r.latency_ms, fallback: r.fallback ? r.fallback.reason : "-",
    rarity: q.rarity, category: q.category, xp: q.xp, min: q.duration_minutes, budget: q.budget,
    attempts: attempts.length, rejected: rejected.length, skipped: circuitSkips.length, title: q.title,
  });
  titles.push(q.title);
  tally(hist, curated ? `curated-fallback (${r.fallback && r.fallback.reason})` : `${r.provider}/${r.source}`);
  for (const a of attempts) tally(hist, `attempt ${a.ok ? "ok" : "fail"}: ${a.ok ? a.model : String(a.reason).slice(0, 46)}`);
  for (const s of circuitSkips) tally(hist, `route skip: ${String(s.reason).slice(0, 60)}`);
  for (const g of rejected) tally(hist, `gate reject: ${g.stage}/${g.reason}`);
  if (r.fallback) console.log(`  fallback reason: ${r.fallback.reason}`);
  if (i < N - 1 && SPACING_MS > 0) await new Promise((r) => setTimeout(r, SPACING_MS));
}

const lat = rows.map((r) => r.latency).sort((a, b) => a - b);
const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor((lat.length - 1) * p))] : 0;
const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
const gemma = rows.filter((r) => r.source !== "curated-fallback");
const curatedRows = rows.filter((r) => r.source === "curated-fallback");
const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
if (dupes.length) warns.push(`repeated titles: ${dupes.join(" | ")}`);

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
const lpad = (s, n) => String(s ?? "").padStart(n);

console.log(`\n${"#".padStart(2)} ${pad("scenario", 30)} ${pad("source", 26)} ${pad("provider", 21)} ${lpad("ms", 6)} ${pad("fallback", 20)} ${pad("rarity", 9)} ${pad("category", 11)} ${lpad("xp", 4)} title`);
for (const r of rows) {
  console.log(`${String(r.i).padStart(2)} ${pad(r.name, 30)} ${pad(r.source, 26)} ${pad(r.provider, 21)} ${lpad(r.latency, 6)} ${pad(r.fallback, 20)} ${pad(r.rarity, 9)} ${pad(r.category, 11)} ${lpad(r.xp, 4)} ${r.title}`);
}

console.log("\n--- summary ---");
console.log(`requests: ${rows.length}/${N} ok · gemma ${gemma.length} · curated fallback ${curatedRows.length}`);
console.log(`latency: avg ${avg}ms · p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms · max ${lat.length ? lat.at(-1) : "-"}ms`);
console.log("sources/endpoints:");
for (const [k, n] of [...hist].sort((a, b) => b[1] - a[1])) console.log(`  ${lpad(n, 3)}x ${k}`);
console.log(`distinct titles: ${new Set(titles).size}/${titles.length}`);
console.log(`api key leakage: ${fails.some((f) => f.includes("key leaked")) ? "FOUND" : "none"}`);

if (warns.length) console.log(`\nwarnings:\n  ${warns.join("\n  ")}`);
if (fails.length) console.log(`\nFAILURES (${fails.length}):\n  ${fails.join("\n  ")}`);
else console.log("\nALL DEMO CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
