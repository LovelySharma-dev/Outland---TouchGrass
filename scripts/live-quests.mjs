// Live integration battery: hits the real /api/quest pipeline (Gemma + SerpApi).
// Run manually: node scripts/live-quests.mjs
import "dotenv/config";

const BASE = process.env.BASE || "http://localhost:3000";
const KEYS = [process.env.OPENROUTER_API_KEY, process.env.OpenRouter_API, process.env.OPENROUTER_API, process.env.GEMMA_API_KEY].filter(Boolean);

const SCENARIOS = [
  ["10min/₹0/solo/low-energy", { state: "low-battery", energy: 10, budget: 0, social: "solo", chaos: 1, minutes: 10, city: "Ghaziabad" }],
  ["30min/₹0/solo", { state: "leave-room", energy: 30, budget: 0, social: "solo", chaos: 3, city: "Ghaziabad" }],
  ["60min/₹100/solo", { state: "side-quest", energy: 50, budget: 100, social: "solo", chaos: 3, minutes: 60, city: "Ghaziabad" }],
  ["see-something-weird", { state: "main-character", energy: 50, budget: 0, social: "solo", chaos: 4, excuse: "I want to see something weird" }],
  ["brain-fried", { state: "tabs", energy: 30, budget: 0, social: "solo", chaos: 2, minutes: 40, excuse: "I've been studying all day and my brain is fried" }],
  ["friend-mode", { state: "side-quest", energy: 80, budget: 200, social: "group", chaos: 3, city: "Ghaziabad" }],
  ["high-chaos", { state: "surprise", energy: 80, budget: 0, social: "solo", chaos: 5, city: "Ghaziabad" }],
  ["very-low-energy", { state: "rotting", energy: 10, budget: 0, social: "solo", chaos: 2, minutes: 15 }],
];

const fails = [];
const check = (name, cond, msg) => { if (!cond) fails.push(`${name}: ${msg}`); };

for (const [name, body] of SCENARIOS) {
  const t0 = Date.now();
  let r, text;
  try {
    const res = await fetch(`${BASE}/api/quest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(600000),
    });
    text = await res.text();
    check(name, res.ok, `http ${res.status}`);
    r = JSON.parse(text);
  } catch (e) {
    console.log(`✖ ${name} :: ${e.message}`);
    fails.push(`${name}: request failed ${e.message}`);
    continue;
  }
  const q = r.quest || {};
  const curated = r.source === "curated-fallback";
  const safetyStages = (r.trace || []).filter((t) => t.stage === "safety");
  const qualityStages = (r.trace || []).filter((t) => t.stage === "quality");
  const genStages = (r.trace || []).filter((t) => ["gemma_generate", "gemma_regenerate", "route_attempt"].includes(t.stage));

  // A curated fallback is a legitimate, honestly-labelled outcome; every
  // other response must come from a real Gemma generation that cleared
  // every gate.
  check(name, /^gemma/i.test(r.source || "") || curated, `source=${r.source}`);
  if (curated) {
    check(name, r.provider === null && r.endpoint === null, `curated response claims provider=${r.provider}`);
    check(name, !!r.fallback && !!r.fallback.reason, "curated response missing fallback.reason");
    check(name, qualityStages.length > 0 && qualityStages.at(-1).source === "curated", "curated response missing its quality verdict");
  } else {
    check(name, ["openrouter", "google-generative-ai"].includes(r.provider || ""), `provider=${r.provider}`);
    check(name, (r.endpoint || "") === "openrouter.ai" || (r.endpoint || "") === "generativelanguage.googleapis.com", `endpoint=${r.endpoint}`);
    check(name, r.fallback === null, "gemma response should not carry a fallback");
    check(name, qualityStages.length > 0 && qualityStages.at(-1).ok === true, "quality did not pass");
  }
  check(name, genStages.every((g) => g.ok === false || /gemma/i.test(g.model)), "non-gemma model in trace");
  check(name, safetyStages.length > 0 && safetyStages.at(-1).ok === true, "safety did not pass");
  check(name, KEYS.every((k) => !text.includes(k)) && !text.includes("AIza") && !text.includes("sk-or-"), "API key leaked");
  check(name, q.title && q.hook && q.objective && Array.isArray(q.steps) && q.steps.length >= 2 && q.steps.length <= 5, "schema incomplete");
  check(name, q.done_when && q.rarity && q.category && q.xp > 0, "missing game fields");
  check(name, (q.duration_minutes || 0) <= (body.minutes || { 10: 15, 30: 40, 50: 60, 80: 90, 100: 120 }[body.energy]), `duration ${q.duration_minutes} exceeds limit`);
  check(name, (q.budget || 0) <= body.budget, `budget ${q.budget} > ${body.budget}`);

  const gates = r.trace.map((t) => t.stage === "safety" || t.stage === "quality"
    ? `${t.stage}:${t.ok ? "pass" : "FAIL " + t.reason}`
    : t.stage).join(" → ");
  console.log(`✔ ${name} | ${curated ? "curated-fallback (" + (r.fallback && r.fallback.reason) + ")" : `${r.provider}/${r.source} | ${r.endpoint}`} | ${r.latency_ms}ms`);
  console.log(`  ${gates}`);
  console.log(`  [${q.rarity}] ${q.title} (+${q.xp} XP, ${q.category}, ${q.duration_minutes}min, ₹${q.budget})`);
  console.log(`  hook: ${q.hook}`);
}

const categories = [];
console.log(`\n${fails.length === 0 ? "ALL LIVE CHECKS PASSED" : "FAILURES:\n" + fails.join("\n")}`);
process.exit(fails.length === 0 ? 0 : 1);
