import test from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { validate, safety, quality, fit, maxMinutes, redact, gemma, TIMING, attemptDeadline, repairFields, buildRepairPrompt, generateQuest, routeState, resetRouteHealth, freeOpenRouterModels, freeGoogleModels, curated, gentle, locationGate, curatedLocation } from "./server.js";

const c = { state: "surprise", energy: 30, budget: 0, social: "solo", chaos: 3, city: "", excuse: "", minutes: 0 };

const quest = (over = {}) => ({
  title: "THE SILENT LIBRARY OF SHADOWS",
  hook: "Your street is hiding one thing you have never once noticed.",
  objective: "Find one overlooked detail on your own block and document it.",
  steps: [
    "Stand at your front door and pick the least familiar direction to walk.",
    "Find the oldest doorway on that street and photograph its handle.",
    "Notice one shadow that will be gone by tomorrow and sketch its shape.",
  ],
  duration_minutes: 25,
  budget: 0,
  difficulty: "easy",
  xp: 55,
  category: "OBSERVER",
  done_when: "You photographed a doorway and sketched a shadow you had never seen before.",
  safety: ["Stay on public pavement only."],
  rarity: "UNCOMMON",
  bonus_objective: "Spot something shaped like an animal.",
  secret_objective: "Find something that makes you ask why is that here.",
  ...over,
});

const unsafe = (steps, extra = {}) => {
  const arr = (Array.isArray(steps) ? steps : [steps]).concat(["Find one strange window and photograph its frame."]);
  return safety(quest({ steps: arr.slice(0, Math.max(2, arr.length)), ...extra }), c);
};

// --- input validation -------------------------------------------------------
test("rejects bad input", () => assert.equal(validate({ state: "x" }), null));
test("accepts good input", () => assert.ok(validate(c)));
test("rejects out-of-range energy", () => assert.equal(validate({ ...c, energy: 45 }), null));
test("carries excuse and minutes", () => {
  const v = validate({ ...c, excuse: "my brain is fried", minutes: 10 });
  assert.equal(v.excuse, "my brain is fried");
  assert.equal(v.minutes, 10);
  assert.equal(maxMinutes(v), 10);
});
test("accepts arbitrary budgets up to 500", () => {
  assert.ok(validate({ ...c, budget: 100 }));
  assert.equal(validate({ ...c, budget: 900 }), null);
});
test("energy maps to a time budget", () => assert.equal(maxMinutes({ energy: 30 }), 40));

// --- safety gate: every dangerous category must be rejected -----------------
test("safety rejects electrical infrastructure", () => {
  const r = unsafe(["Place the leaf on the nearest public electric box to see it glow."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^unsafe:/);
});
test("safety rejects road crossing", () => {
  const r = unsafe(["Cross the road at the busy junction to reach the park faster."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /road-crossing/);
});
test("safety rejects private property", () => {
  const r = unsafe(["Walk onto the private property behind the mall for a shortcut."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /private-property/);
});
test("safety rejects climbing", () => {
  const r = unsafe(["Climb the fence to get a better view of the garden."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /climbing/);
});
test("safety rejects touching unknown objects", () => {
  const r = unsafe(["Pick up the unknown object lying near the bench and examine it."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown-object/);
});
test("safety rejects approaching dangerous animals", () => {
  const r = unsafe(["Approach the stray dog near the corner and offer it your snack."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^unsafe:/);
});
test("safety rejects stranger interaction when solo", () => {
  const r = unsafe(["Talk to a stranger and ask them for directions to the square."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /stranger-interaction/);
});
test("safety allows stranger interaction in meet-humans mode", () => {
  const r = safety(quest({ steps: ["Ask a stranger which bench they think is the oldest.", "Photograph the bench they point to.", "Compare it with the one outside the library."] }), { ...c, social: "meet-humans" });
  assert.equal(r.ok, true, r.reason);
});
test("safety rejects trespassing", () => {
  const r = unsafe(["Trespass into the empty lot to see the graffiti wall up close."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /trespassing/);
});
test("safety rejects rail tracks", () => {
  const r = unsafe(["Walk along the train tracks to count the sleepers."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /rail-tracks/);
});
test("safety rejects restricted areas", () => {
  const r = unsafe(["Slip past the restricted area sign to reach the old platform."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /restricted-area/);
});
test("safety rejects abandoned places", () => {
  const r = unsafe(["Wait inside the abandoned shelter until the rain stops."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /restricted-area/);
});
test("safety rejects dangerous verb+noun proximity", () => {
  const r = unsafe(["Move the metal cover off the drain to see what is underneath it."]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^unsafe:/);
});
test("safety passes negated danger wording", () => {
  const r = safety(quest({ steps: ["Never climb anything on this quest, only look up.", "Find the tallest balcony you can see from the pavement.", "Photograph one window with its curtains open."] }), c);
  assert.equal(r.ok, true, r.reason);
});
test("safety lets safety notes mention danger", () => {
  const r = safety(quest({ safety: ["Do not talk to strangers or climb anything."] }), c);
  assert.equal(r.ok, true, r.reason);
});

// --- safety gate: schema ----------------------------------------------------
test("safety rejects missing done condition", () => {
  const q = quest(); delete q.done_when;
  assert.equal(safety(q, c).ok, false);
});
test("safety rejects too few steps", () => assert.equal(safety(quest({ steps: ["Find one strange window."] }), c).ok, false));
test("safety rejects too many steps", () => assert.equal(safety(quest({ steps: Array(7).fill("Find one strange window and photograph it.") }), c).ok, false));
test("safety rejects thin objective", () => assert.equal(safety(quest({ objective: "go" }), c).ok, false));

// --- safety gate: normalisation --------------------------------------------
test("safety clamps xp into the rarity band", () => {
  assert.equal(safety(quest({ rarity: "COMMON", xp: 999 }), c).quest.xp, 45);
  assert.equal(safety(quest({ rarity: "LEGENDARY", xp: 5 }), c).quest.xp, 150);
});
test("safety always appends the standing safety note", () => {
  assert.ok(safety(quest(), c).quest.safety.some((s) => /public/.test(s)));
});
test("safety normalises a missing rarity", () => {
  const q = quest(); delete q.rarity;
  assert.equal(safety(q, c).quest.rarity, "UNCOMMON");
});

// --- quality gate -----------------------------------------------------------
test("quality passes a good quest", () => assert.equal(quality(quest(), c, []), null));
test("quality rejects a weak title", () => assert.equal(quality(quest({ title: "Walk" }), c, []), "weak-title"));
test("quality rejects a weak hook", () => assert.equal(quality(quest({ hook: "go" }), c, []), "weak-hook"));
test("quality rejects generic quests", () => {
  assert.equal(quality(quest({ title: "GO FOR A FRESH AIR WALK", objective: "Take a walk around your neighbourhood." }), c, []), "too-generic");
  assert.equal(quality(quest({ steps: ["Take a walk around the block.", "Get some fresh air near the park.", "Find one strange window and photograph it."] }), c, []), "too-generic");
});
test("quality rejects arbitrary precision", () => {
  assert.equal(quality(quest({ steps: ["Walk exactly 37 steps and stop at the marker.", "Find one strange window and photograph its frame.", "Notice one shadow and sketch its shape."] }), c, []), "arbitrary-instruction");
});
test("quality rejects unavailable equipment", () => {
  assert.equal(quality(quest({ steps: ["Bring a drone for aerial shots over the park.", "Find one strange window and photograph its frame.", "Notice one shadow and sketch its shape."] }), c, []), "needs-unavailable-equipment");
});
test("quality rejects quests longer than the player has", () => {
  assert.match(quality(quest({ duration_minutes: 90 }), c, []), /^over-time/);
});
test("quality rejects quests over budget", () => {
  assert.match(quality(quest({ budget: 200 }), c, []), /^over-budget/);
});
test("quality rejects quests with no clear done condition", () => {
  const q = quest(); q.done_when = "";
  assert.equal(safety(q, c).ok, false, "schema gate catches it first");
});
test("quality rejects duplicates", () => {
  assert.equal(quality(quest(), c, [{ title: "THE SILENT LIBRARY OF SHADOWS", category: "MYSTERY" }]), "duplicate-quest");
  assert.equal(quality(quest(), c, [{ title: "SILENT LIBRARY ABOUT SHADOWS", category: "MYSTERY" }]), "duplicate-quest");
});
test("quality rejects category stagnation", () => {
  assert.equal(quality(quest(), c, [{ title: "A", category: "OBSERVER" }, { title: "B", category: "OBSERVER" }]), "repeat-category");
  assert.equal(quality(quest(), c, [{ title: "A", category: "PHOTO HUNT" }, { title: "B", category: "OBSERVER" }]), null);
});
test("quality rejects mood mismatches", () => {
  assert.equal(quality(quest({ difficulty: "hard" }), { ...c, energy: 30 }, []), "mood-mismatch-energy");
  assert.equal(quality(quest({ duration_minutes: 40 }), { ...c, excuse: "my brain is fried" }, []), null);
  assert.equal(quality(quest({ duration_minutes: 40, difficulty: "hard" }), { ...c, energy: 50, excuse: "my brain is fried" }, []), "mood-mismatch-excuse");
});
test("quality rejects indoor-only quests at high energy", () => {
  const q = quest({ steps: ["Reread the first chapter of the book on your shelf.", "Compare its ending with the ending of a different book.", "Write one sentence you wish the author had included."] });
  assert.equal(quality(q, { ...c, energy: 50 }, []), "not-outdoors");
});

// --- key safety -------------------------------------------------------------
test("redact strips credentials from errors", () => {
  const out = redact(new Error("fetch failed https://x/y?key=SECRETVALUE&z=1"));
  assert.ok(!out.includes("SECRETVALUE"));
  assert.match(out, /key=REDACTED/);
});
test("redact strips bare key= credentials", () => {
  const out = redact(new Error("google said key=AIzaSyFakeSecretValue123 is not valid"));
  assert.ok(!out.includes("AIzaSyFakeSecretValue123"));
  assert.match(out, /key=REDACTED/);
});

// --- cost safety: only free models can ever be configured -------------------
test("paid model ids can never reach a provider", () => {
  assert.deepEqual(freeOpenRouterModels(["google/gemma-4-26b-a4b-it", "anthropic/claude-3"]), []);
  assert.deepEqual(freeOpenRouterModels(["google/gemma-4-26b-a4b-it:free"]), ["google/gemma-4-26b-a4b-it:free"]);
  assert.deepEqual(freeGoogleModels(["gemini-2.5-flash", "gemma-4-26b-a4b-it"]), ["gemma-4-26b-a4b-it"]);
  assert.deepEqual(freeGoogleModels(["gemini-3.1-pro"]), []);
});

// --- latency contract -------------------------------------------------------
test("latency ceilings keep the worst case under 15s", () => {
  assert.ok(TIMING.discovery_ms <= 4000, "discovery bounded");
  assert.ok(TIMING.primary_attempt_ms <= 7000, "primary route fails fast");
  assert.ok(TIMING.fallback_attempt_ms <= 9000, "fallback bounded");
  assert.ok(TIMING.gen_budget_ms <= 10000, "generation budget bounded");
  assert.ok(TIMING.regen_budget_ms <= 5000, "regeneration budget is much tighter than generation");
  assert.ok(TIMING.regen_budget_ms < TIMING.gen_budget_ms, "a rejection can never cost as much as a first attempt");
  assert.ok(TIMING.discovery_ms + TIMING.gen_budget_ms <= 14000, "worst case request under 15s");
  assert.ok(TIMING.max_output_tokens > 0 && TIMING.max_output_tokens <= 1500, "output bounded");
  assert.ok(TIMING.repair_output_tokens < TIMING.max_output_tokens, "a field repair asks for less text than a full quest");
  assert.ok(TIMING.min_regenerate_ms <= TIMING.regen_budget_ms, "a regeneration is only started when it can finish");
  assert.ok(TIMING.min_attempt_ms <= TIMING.gen_budget_ms, "a first attempt is only started when it can finish");
});

// --- routing: primary available / unavailable -> fallback -------------------
const routeOr = { kind: "openrouter", provider: "openrouter", host: "openrouter.ai", key: "k", models: ["google/gemma-4-26b-a4b-it:free"] };
const routeGo = { kind: "google", provider: "google-generative-ai", host: "generativelanguage.googleapis.com", key: "k", models: ["gemma-4-26b-a4b-it"] };
const okBody = JSON.stringify({ title: "A REASONABLE QUEST TITLE", hook: "The oldest bench on the street has a number nobody can read." });

test("routing: primary available is used first, single attempt", async () => {
  const calls = [];
  const out = await gemma(c, [], "", [], {
    routes: [routeOr, routeGo],
    call: async (route) => { calls.push(route.provider); return okBody; },
    health: new Map(),
  });
  assert.equal(out.provider, "openrouter");
  assert.equal(out.model, "google/gemma-4-26b-a4b-it:free");
  assert.deepEqual(calls, ["openrouter"], "must not touch the fallback when the primary works");
  assert.equal(out.routeTrace.length, 1);
  assert.equal(out.routeTrace[0].stage, "route_attempt");
  assert.equal(out.routeTrace[0].ok, true);
});

test("routing: primary 429 fails over fast with both attempts traced", async () => {
  const health = new Map(), calls = [];
  const t0 = Date.now();
  const out = await gemma(c, [], "", [], {
    routes: [routeOr, routeGo],
    health,
    call: async (route) => {
      calls.push(route.provider);
      if (route.kind === "openrouter") { const e = new Error("http 429 Provider returned error"); e.status = 429; throw e; }
      return okBody;
    },
  });
  assert.equal(out.provider, "google-generative-ai");
  assert.deepEqual(calls, ["openrouter", "google-generative-ai"]);
  assert.ok(Date.now() - t0 < 1000, "no backoff sleep on a rate limit");
  const fail = out.routeTrace[0];
  assert.equal(fail.stage, "route_attempt");
  assert.equal(fail.provider, "openrouter");
  assert.equal(fail.ok, false);
  assert.match(fail.reason, /429/);
  assert.equal(out.routeTrace.at(-1).ok, true, "fallback attempt is visible too");
  assert.ok(health.get("openrouter:openrouter.ai").until > Date.now(), "circuit opens after 429");
});

test("routing: a cooling-down provider is skipped, not re-probed", async () => {
  const health = new Map([["openrouter:openrouter.ai", { until: Date.now() + 30000, reason: "http 429 rate limited" }]]);
  const calls = [];
  const out = await gemma(c, [], "", [], {
    routes: [routeOr, routeGo],
    health,
    call: async (route) => { calls.push(route.provider); return okBody; },
  });
  assert.deepEqual(calls, ["google-generative-ai"], "the rate-limited route is never called");
  assert.equal(out.provider, "google-generative-ai");
  const skip = out.routeTrace.find((t) => t.stage === "route_skip");
  assert.ok(skip, "the skip must stay visible in the trace");
  assert.equal(skip.provider, "openrouter");
  assert.match(skip.reason, /circuit open/);
  assert.ok(skip.retry_in_ms > 0);
});

test("routing: a hung primary is cut off by its timeout and labelled", async () => {
  const health = new Map();
  const t0 = Date.now();
  const out = await gemma(c, [], "", [], {
    routes: [routeOr, routeGo],
    health,
    timings: { ...TIMING, primary_attempt_ms: 60, fallback_attempt_ms: 2000, min_attempt_ms: 10 },
    call: (route, _model, _prompt, signal) => (route.kind === "openrouter"
      ? new Promise((_res, rej) => signal.addEventListener("abort", () => rej(signal.reason), { once: true }))
      : Promise.resolve(okBody)),
  });
  const fail = out.routeTrace.find((t) => t.stage === "route_attempt" && t.ok === false);
  assert.match(fail.reason, /timeout after 60ms/);
  assert.equal(out.provider, "google-generative-ai");
  assert.ok(Date.now() - t0 < 3000, "failed over quickly");
  assert.ok(health.get("openrouter:openrouter.ai").until > Date.now(), "a timeout opens the circuit too");
});

test("routing: budget exhaustion throws fast with a traceable reason", async () => {
  await assert.rejects(
    gemma(c, [], "", [], {
      routes: [routeOr, routeGo],
      health: new Map(),
      call: async () => okBody,
      deadline: Date.now() - 1,
    }),
    (e) => {
      assert.match(e.message, /generation budget exhausted/);
      assert.ok(e.routeTrace.some((t) => t.stage === "budget_exhausted"), "timeout is not hidden");
      return true;
    },
  );
});

// --- circuit persistence: a cooldown must survive into the next request ----
const goKey = `${routeGo.provider}:${routeGo.host}`;
const timeoutErr = () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; return e; };

test("routing: the next request skips a timed-out provider instead of waiting again", async () => {
  const health = new Map(), calls = [];
  const opts = {
    routes: [routeGo],
    health,
    call: async () => { calls.push("attempt"); throw timeoutErr(); },
  };
  await assert.rejects(gemma(c, [], "", [], opts), /timeout after/);
  assert.equal(calls.length, 1, "first request pays the attempt");
  const open = health.get(goKey);
  // 100ms of slack for the clock ticks between openCircuit() and this assert;
  // the guarantee that matters is that the cooldown still dwarfs the attempt
  // cap (9s) that produced it.
  assert.ok(open && open.until - Date.now() >= TIMING.cooldown_error_ms - 100, "the cooldown must outlive the attempt that opened it");
  assert.equal(open.fails, 1);

  const t0 = Date.now();
  await assert.rejects(gemma(c, [], "", [], opts), (e) => {
    assert.ok(e.routeTrace.length > 0, "the skip stays visible");
    assert.ok(e.routeTrace.every((a) => a.stage === "route_skip"), "nothing is attempted while the circuit is open");
    assert.match(e.routeTrace[0].reason, /circuit open/);
    assert.ok(e.routeTrace[0].retry_in_ms > 0);
    return true;
  });
  assert.equal(calls.length, 1, "the cooling-down provider is never re-probed");
  assert.ok(Date.now() - t0 < 1000, "no provider wait on the second request");
});

test("routing: repeated failures widen the cooldown, a success clears it", async () => {
  const health = new Map();
  const opts = { routes: [routeGo], health, call: async () => { throw timeoutErr(); } };
  await assert.rejects(gemma(c, [], "", [], opts));
  const first = health.get(goKey).until - Date.now();
  // The cooldown lapses and the provider fails again: same route, second strike.
  health.set(goKey, { ...health.get(goKey), until: Date.now() - 1 });
  await assert.rejects(gemma(c, [], "", [], opts));
  const second = health.get(goKey);
  assert.equal(second.fails, 2, "consecutive failures are counted");
  assert.ok(second.until - Date.now() > first, "the second failure buys a longer cooldown");
  assert.ok(second.until - Date.now() <= TIMING.cooldown_max_ms, "and never beyond the cap");

  health.set(goKey, { ...second, until: Date.now() - 1 });
  const ok = await gemma(c, [], "", [], { routes: [routeGo], health, call: async () => okBody });
  assert.equal(ok.provider, "google-generative-ai");
  assert.equal(health.has(goKey), false, "a working route never stays in a breaker");
});

test("routing: every circuit open means skips only, so the caller can label it circuit-open", async () => {
  const health = new Map([
    ["openrouter:openrouter.ai", { until: Date.now() + 30000, reason: "http 429 rate limited", fails: 1 }],
    [goKey, { until: Date.now() + 30000, reason: "timeout after 9000ms", fails: 2 }],
  ]);
  const calls = [];
  await assert.rejects(
    gemma(c, [], "", [], { routes: [routeOr, routeGo], health, call: async (r) => { calls.push(r.provider); return okBody; } }),
    (e) => {
      assert.deepEqual(e.routeTrace.map((t) => t.stage), ["route_skip", "route_skip"]);
      assert.match(e.routeTrace[0].reason, /circuit open: http 429/);
      assert.match(e.routeTrace[1].reason, /circuit open: timeout/);
      return true;
    },
  );
  assert.deepEqual(calls, [], "both providers are inside their cooldown");
});

// --- curated fallback: the selector honours the player's declared limits ----
test("curated: a rotting, zero-budget, 15-minute player gets the gentlest outing", () => {
  const base = { energy: 10, budget: 0, social: "solo", chaos: 2, minutes: 15, city: "", excuse: "" };
  for (const state of ["rotting", "disappear"]) {
    const p = { ...base, state };
    assert.ok(gentle(p), `${state} is a gentle state`);
    const q = curated(p);
    assert.ok(q.duration_minutes <= 15, `${q.title} fits 15 minutes`);
    assert.ok(q.duration_minutes <= 10, `${q.title} should be the low-effort end of the pool`);
    assert.equal(q.budget, 0, "zero budget means zero cost");
    assert.equal(q.difficulty, "easy");
    assert.ok(q.min <= p.energy, "never above the player's energy floor");
  }
  assert.equal(curated({ ...base, state: "rotting" }).title, "QUIET PATCH");
});

test("curated: a player who is not gentle keeps the original first-fit pick", () => {
  const q = curated({ energy: 50, budget: 0, social: "solo", chaos: 3, minutes: 0, state: "side-quest", city: "", excuse: "" });
  assert.equal(q.title, "THE 400-METER EXPEDITION");
  assert.equal(gentle({ energy: 50, budget: 0, social: "solo", chaos: 3, minutes: 0, state: "side-quest" }), false);
});

// --- quality: real adventure, not AI poetry ---------------------------------
test("quality rejects cinematic AI poetry", () => {
  assert.equal(quality(quest({ title: "THE HERO'S ARRIVAL", hook: "Your party stands at the threshold; make your entrance count.", objective: "Answer the call and prove your destiny." }), c, []), "ai-poetry");
});
test("quality rejects hooks that say nothing concrete", () => {
  assert.equal(quality(quest({ hook: "Prove your focus is still sharp and accept the challenge." }), c, []), "generic-hook");
});
test("quality rejects quests without real discovery actions", () => {
  const q = quest({ steps: [
    "Head out the door and keep moving until you feel like stopping.",
    "Let the route decide itself and never check your phone.",
    "Come back the same way you left and remember the time."] });
  assert.equal(quality(q, c, []), "no-discovery-action");
});
test("quality rejects a near-identical objective under a new title", () => {
  const h = [{ title: "A TOTALLY DIFFERENT NAME", category: "EXPLORER",
    objective: "Find the oldest doorway on your block and photograph the number on it.",
    steps: ["Find the oldest doorway on your block.", "Photograph the number painted on it."] }];
  assert.equal(quality(quest({ objective: "Find the oldest doorway on your block and photograph the number." }), c, h), "near-duplicate-objective");
});
test("quality rejects a recycled activity wearing a new title", () => {
  const h = [{ title: "SOMETHING ELSE ENTIRELY", category: "NATURE",
    objective: "Collect three fallen leaves and compare their edges.",
    steps: ["Find a bench nobody sits on and photograph its cracks.",
      "Spot three things on that block you never noticed.",
      "Walk home by a different road than you came by."] }];
  const q = quest({
    objective: "Collect a fallen leaf and compare it with one from a different tree.",
    steps: ["Find a bench nobody sits on and photograph its cracks.",
      "Spot three things on that block you never noticed.",
      "Take the long way home even if it adds a minute."] });
  assert.equal(quality(q, c, h), "near-duplicate-activity");
});

// --- personalization gate ---------------------------------------------------
test("personalization passes a quest that fits the player", () => assert.equal(fit(quest(), c), null));
test("personalization rejects party language for a solo player", () => {
  assert.match(fit(quest({ objective: "Gather your crew and explore the block together." }), c), /^solo-party-language/);
});
test("personalization rejects paid activities on a zero budget", () => {
  assert.match(fit(quest({ steps: ["Buy a coffee at the corner and sit down with it.",
    "Find the oldest doorway on that street and photograph its handle.",
    "Notice one shadow and sketch its shape."] }), c), /^paid-on-zero-budget/);
});
test("personalization rejects a big plan for a barely-awake player", () => {
  assert.match(fit(quest({ duration_minutes: 60, difficulty: "medium" }), { ...c, energy: 10 }), /^energy-too-low-for-plan/);
});
test("personalization respects an exhausted excuse", () => {
  assert.match(fit(quest({ steps: ["Sprint to the park and jog back before sunset.",
    "Find the oldest doorway on that street and photograph its handle.",
    "Notice one shadow and sketch its shape."] }), { ...c, excuse: "my brain is fried" }), /^excuse-mismatch/);
});
test("personalization keeps chaos 1 calm", () => {
  assert.match(fit(quest({ hook: "A chaotic sprint through the park, no rules, pure mayhem." }), { ...c, chaos: 1 }), /^chaos-mismatch/);
});
test("personalization keeps group quests from being solo orders", () => {
  assert.match(fit(quest({ hook: "A bench you should visit by yourself before the sun sets." }), { ...c, social: "group" }), /^group-solo-language/);
});
test("personalization protects secret mode from geo-tagged posts", () => {
  assert.match(fit(quest({ steps: ["Post it on your story after you find the shadow.",
    "Find the oldest doorway on that street and photograph its handle.",
    "Notice one shadow and sketch its shape."] }), { ...c, social: "secret" }), /^secret-visibility/);
});
test("personalization keeps dog walks out of shops", () => {
  assert.match(fit(quest({ steps: ["Step inside the library and read the oldest plaque you find.",
    "Photograph the cracked number on the door outside.",
    "Compare it with the one across the street."] }), { ...c, social: "dog" }), /^dog-mismatch/);
});

// --- location grounding: SerpApi discovery -> Gemma selection -> quest ------
// The discovery list a real /api/quest request hands to the gates.
const places = [
  { name: "Meghdootam Park", address: "Sector 21, Ghaziabad, Uttar Pradesh", type: "Park", source: "serpapi", lat: 28.6698, lng: 77.4536, place_id: "ChIJmghdootam000" },
  { name: "Jungle Trail", address: "Lal Kuan, Ghaziabad", type: "Hiking area", source: "serpapi" },
  { name: "Rashtriya Dalit Prerna Sthal", address: "Sector 16, Ghaziabad", type: "Park", source: "serpapi", lat: 28.6712, lng: 77.4501 },
  { name: "Abandoned Factory Lane", address: "Ghaziabad", type: "Point of interest", source: "serpapi" },
  { name: "Tea Town Cafe", address: "Shipra Mall Road, Ghaziabad", type: "Cafe", source: "serpapi" },
  { name: "Weekend Party Lounge", address: "Ghaziabad", type: "Night club", source: "serpapi" },
];
const at = (name, reason, over = {}) => quest({ location: { name, reason, source: "serpapi" }, ...over });

test("location: a verified SerpApi place reaches the quest JSON", () => {
  const s = safety(at("Meghdootam Park", "quiet public green space for a low-energy observation quest"), c);
  assert.equal(s.ok, true, s.reason);
  assert.equal(s.quest.location.name, "Meghdootam Park");
  const lg = locationGate(s.quest, c, places);
  assert.equal(lg.ok, true, lg.reason);
  assert.equal(lg.location.name, "Meghdootam Park", "the canonical discovered name is served");
  assert.equal(lg.location.source, "serpapi");
  assert.match(lg.location.reason, /quiet public green space/);
  assert.match(lg.location.map_url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/, "real coordinates build a real map link");
});

test("location: the quest card renders the selected place", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /q\.location/, "the card reads the location off the quest");
  assert.match(html, /📍/, "the place is shown with the pin");
  assert.match(html, /Your side quest happens here\./);
  assert.match(html, /OPEN IN MAPS/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.ok(html.includes("www\\.google\\.com\\/maps"), "the map link is only ever a google maps url");
  assert.match(html, /\.place b\{[^}]*text-transform:uppercase/, "the place name is shown prominently");
});

test("location: Gemma selects no place so the location stays null", () => {
  assert.equal(safety(quest({ location: null }), c).quest.location, null, "explicit null");
  assert.equal(safety(quest(), c).quest.location, null, "field absent");
  assert.equal(locationGate(safety(quest({ location: null }), c).quest, c, places).location, null, "nothing to show");
  assert.equal(locationGate(safety(quest(), c).quest, c, places).ok, true);
});

test("location: an ungrounded or malformed selection never survives", () => {
  const invented = locationGate(safety(at("Definitely Not A Real Park", "sounds nice"), c).quest, c, places);
  assert.equal(invented.ok, false);
  assert.equal(invented.reason, "location:unverified-place");
  assert.equal(safety(quest({ location: { reason: "no name at all" } }), c).quest.location, null, "malformed drops to null");
  assert.equal(safety(quest({ location: 42 }), c).quest.location, null, "wrong type drops to null");
});

test("location: SerpApi unavailable means a location-independent quest", () => {
  const s = safety(at("Meghdootam Park", "fits the mood"), c);
  const lg = locationGate(s.quest, c, []);
  assert.equal(lg.ok, false, "with no discovery nothing can be verified");
  assert.equal(lg.reason, "location:unverified-place");
  // The rejected selection is dropped on the retry: with no places in the
  // request there is nothing to ground, attach or display.
  const retry = locationGate(safety(quest({ location: null }), c).quest, c, []);
  assert.equal(retry.ok, true);
  assert.equal(retry.location, null);
});

test("location: an unsafe place is rejected", () => {
  const lg = locationGate(safety(at("Abandoned Factory Lane", "quiet industrial ruins"), c).quest, c, places);
  assert.equal(lg.ok, false, "a restricted/unsafe spot is never served");
  assert.match(lg.reason, /^location:unsafe:/);
});

test("location: a ₹0 player never gets a paid destination", () => {
  const broke = { ...c, budget: 0 };
  const lg = locationGate(safety(at("Tea Town Cafe", "cosy spot to sit with a chai"), broke).quest, broke, places);
  assert.equal(lg.ok, false);
  assert.equal(lg.reason, "location:paid-on-zero-budget");
  const funded = { ...c, budget: 200 };
  const ok = locationGate(safety(at("Tea Town Cafe", "cosy spot to sit with a chai"), funded).quest, funded, places);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.location.name, "Tea Town Cafe");
});

test("location: a very low-energy player is not sent on a trek", () => {
  const flat = { ...c, energy: 10, minutes: 15 };
  const lg = locationGate(safety(at("Jungle Trail", "a 6 km uphill trek to a hidden waterfall"), flat).quest, flat, places);
  assert.equal(lg.ok, false);
  assert.match(lg.reason, /^location:(energy-mismatch|over-time)$/);
  // The same place is allowed once the player actually has energy for it.
  const hiked = locationGate(safety(at("Jungle Trail", "a short nature trail"), { ...c, energy: 80, minutes: 90 }).quest, { ...c, energy: 80, minutes: 90 }, places);
  assert.equal(hiked.ok, true, hiked.reason);
  assert.equal(hiked.location.name, "Jungle Trail");
});

test("location: a solo player is never sent to a group venue", () => {
  const funded = { ...c, budget: 200 };
  const lg = locationGate(safety(at("Weekend Party Lounge", "busy nightlife spot with a crowd"), funded).quest, funded, places);
  assert.equal(lg.ok, false);
  assert.equal(lg.reason, "location:social-mismatch:solo");
  const crew = { ...funded, social: "group" };
  assert.equal(locationGate(safety(at("Weekend Party Lounge", "busy nightlife spot with a crowd"), crew).quest, crew, places).ok, true);
});

test("location: a place named inside the quest text is surfaced", () => {
  const s = safety(quest({
    location: null,
    hook: "Meghdootam Park has a bench nobody has ever sat on.",
    objective: "Find the least-used bench in Meghdootam Park and photograph it.",
  }), c);
  const lg = locationGate(s.quest, c, places);
  assert.equal(lg.ok, true, lg.reason);
  assert.equal(lg.inferred, true, "the quest itself named the place");
  assert.equal(lg.location.name, "Meghdootam Park");
});

test("location: no map link is invented without real map data", () => {
  const bare = [{ name: "Quiet Bench Corner", address: "", type: "", source: "serpapi" }];
  const lg = locationGate(safety(at("Quiet Bench Corner", "flat, close and free"), c).quest, c, bare);
  assert.equal(lg.ok, true, lg.reason);
  assert.equal(lg.location.name, "Quiet Bench Corner", "the name is still shown");
  assert.equal("map_url" in lg.location, false, "no coordinates, no address, no link");
});

test("curated fallback: no misleading SerpApi attribution", () => {
  const q = curated(c);
  assert.equal(safety(q, c).quest.location, null, "curated quests ship without a location");
  assert.equal(curatedLocation(q, places, c), null, "the curated text names none of the discoveries");
  // A place is only ever attached when the curated quest itself names it,
  // and then it is honestly labelled as the discovery it is.
  const named = { ...q, objective: "Sit quietly in Meghdootam Park and observe.", steps: ["Sit quietly in Meghdootam Park for two minutes.", "Notice three quiet sounds."] };
  const attached = curatedLocation(named, places, c);
  assert.equal(attached && attached.name, "Meghdootam Park");
  assert.equal(attached.source, "serpapi");
  // Unsafe or unfitting places stay out of curated quests too.
  const unsafeCurated = { ...q, objective: "Explore Abandoned Factory Lane." };
  assert.equal(curatedLocation(unsafeCurated, places, c), null);
});

// --- field repair helpers ---------------------------------------------------
test("repairFields returns the correct single field for generic-hook", () => {
  assert.deepEqual(repairFields("generic-hook"), ["hook"]);
});

test("repairFields looks at the reason head for location reasons", () => {
  assert.deepEqual(repairFields("location:unverified-place"), ["location"]);
  assert.deepEqual(repairFields("location:paid-on-zero-budget"), ["location"]);
  assert.deepEqual(repairFields("location:energy-mismatch"), ["location"]);
  assert.deepEqual(repairFields("location:over-time:90>40"), ["location"]);
});

test("repairFields returns null for a reason it does not know how to patch", () => {
  assert.equal(repairFields("duplicate-quest"), null);
  assert.equal(repairFields("near-duplicate-objective"), null);
  assert.equal(repairFields("location:unsafe:climbing"), null);
});

// --- attemptDeadline: regeneration never exceeds regen_budget_ms -------------
test("attemptDeadline keeps regeneration to the regeneration budget", () => {
  const now = 10000;
  const genDeadline = now + 60000; // generation budget is no constraint at all here
  const d = attemptDeadline({ now, attempt: 2, genDeadline, timings: TIMING });
  assert.equal(d, now + TIMING.regen_budget_ms);
});

test("attemptDeadline returns genDeadline for the first attempt", () => {
  const now = 100;
  const genDeadline = now + 5000;
  assert.equal(attemptDeadline({ now, attempt: 1, genDeadline }), genDeadline);
});

test("attemptDeadline respects that genDeadline may already be tighter", () => {
  const now = 10000;
  const genDeadline = now + 2000; // only 2s left of whole budget
  const d = attemptDeadline({ now, attempt: 2, genDeadline, timings: TIMING });
  assert.equal(d, genDeadline);
});

// --- generateQuest: field repair is capped by regen_budget_ms ----------------
test("generateQuest uses a field repair for a generic-hook rejection and is capped by regen_budget_ms", async () => {
  resetRouteHealth();
  const calls = [];
  const questProto = quest({ hook: 'short hook', location: null });
  let repaired = false;
  const gemmaFake = async (_c, _places, feedback, _history, opts) => {
    calls.push({ feedback, max_output_tokens: opts.max_output_tokens, prompt: opts.prompt || "", budget_ms: opts.budget_ms });
    if (!repaired) {
      repaired = true;
      return {
        raw: questProto,
        model: "gemma-4-26b-a4b-it",
        provider: "google-generative-ai",
        endpoint: "generativelanguage.googleapis.com",
        latency_ms: 50,
        routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
      };
    }
    // The repair must only override hook
    return {
      raw: { ...questProto, hook: "The oldest bench on this street has a number nobody can read." },
      model: "gemma-4-26b-a4b-it",
      provider: "google-generative-ai",
      endpoint: "generativelanguage.googleapis.com",
      latency_ms: 40,
      routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
    };
  };

  const out = await generateQuest(c, [], [], {
    gemma: gemmaFake,
    routes: [routeGo],
    timings: { ...TIMING, min_attempt_ms: 10, min_regenerate_ms: 10 },
    now: () => 0,
  });

  assert.ok(out.quest, "quest must pass after a hook repair");
  assert.equal(out.quest.hook, "The oldest bench on this street has a number nobody can read.");
  assert.equal(out.failReason, "");
  assert.equal(calls.length, 2, "one generation, one repair");
  assert.equal(calls[0].budget_ms, TIMING.gen_budget_ms);
  assert.equal(calls[1].budget_ms, TIMING.regen_budget_ms);
  assert.equal(calls[1].max_output_tokens, TIMING.repair_output_tokens, "repair uses the much smaller token cap");
  assert.ok(calls[1].prompt.includes("FIX ONLY THESE FIELD"), "the repair prompt is the single-field repair prompt");
  const stages = out.trace.map((t) => t.stage);
  assert.ok(stages.includes("gemma_generate"));
  assert.ok(stages.includes("gemma_repair"));
  assert.ok(stages.includes("quality"));
  assert.ok(stages.includes("personalization"));
  assert.ok(!stages.includes("gemma_regenerate"), "no full regeneration should have happened");
});

// --- regeneration: a gate rejection gets a strict, short deadline ------------
// The production failure this locks down: a real Gemma answer was rejected by
// the safety gate (unsafe:restricted-area), regeneration then burned ~15.8s
// and the request took ~30.3s before the curated fallback. A regeneration is
// now bounded by regen_budget_ms (and by the generation deadline, whichever
// is sooner), never by the leftovers of the generation budget.

test("generateQuest: unsafe Gemma output gets a regeneration capped by regen_budget_ms", async () => {
  resetRouteHealth();
  const calls = [];
  let wall = 100000;
  const gemmaFake = async (_c, _places, _feedback, _history, opts) => {
    calls.push({ deadline: opts.deadline, budget_ms: opts.budget_ms, at: wall });
    if (calls.length === 1) {
      wall += 3000; // the unsafe first attempt burns 3s of the generation budget
      return {
        raw: quest({ steps: ["Slip past the restricted area sign to reach the old platform.", "Find one strange window and photograph its frame."] }),
        model: "m", provider: "google-generative-ai", endpoint: "e",
        latency_ms: 3000,
        routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
      };
    }
    return {
      raw: quest(),
      model: "m", provider: "google-generative-ai", endpoint: "e",
      latency_ms: 500,
      routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
    };
  };

  const out = await generateQuest(c, [], [], { gemma: gemmaFake, routes: [routeGo], now: () => wall, trace: [] });

  assert.equal(calls.length, 2, "a safety rejection gets exactly one regeneration");
  const safetyFail = out.trace.find((t) => t.stage === "safety" && t.ok === false);
  assert.equal(safetyFail.reason, "unsafe:restricted-area", "the real production rejection stays visible");
  assert.equal(safetyFail.attempt, 1);
  assert.ok(out.trace.some((t) => t.stage === "gemma_regenerate" && t.ok === true), "the regeneration is traced");
  // Attempt 1 starts at 100000 with the whole generation budget; the
  // regeneration starts at 103000 with 7000ms of generation budget still
  // left - and must still only get regen_budget_ms.
  assert.equal(calls[0].deadline, 100000 + TIMING.gen_budget_ms, "attempt 1 gets the whole generation budget");
  assert.equal(calls[1].budget_ms, TIMING.regen_budget_ms, "attempt 2 is labelled with the regeneration budget");
  assert.equal(calls[1].deadline, 103000 + TIMING.regen_budget_ms, "attempt 2 gets regen_budget_ms from now, never the leftovers of gen budget");
  assert.ok(calls[1].deadline < calls[0].deadline, "the regeneration deadline is strictly earlier than attempt 1's");
  assert.ok(out.quest, "the regenerated quest is served");
  assert.equal(out.failReason, "");
  assert.equal(out.served.provider, "google-generative-ai");
});

test("generateQuest: a quality rejection gets the same strict regeneration deadline", async () => {
  resetRouteHealth();
  const calls = [];
  let wall = 200000;
  const gemmaFake = async (_c, _places, _feedback, _history, opts) => {
    calls.push({ deadline: opts.deadline, budget_ms: opts.budget_ms, prompt: opts.prompt || "", at: wall });
    if (calls.length === 1) {
      wall += 4000;
      return {
        raw: quest(),
        model: "m", provider: "google-generative-ai", endpoint: "e",
        latency_ms: 4000,
        routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
      };
    }
    return {
      raw: quest({ title: "THE OLDEST DOOR NUMBER" }),
      model: "m", provider: "google-generative-ai", endpoint: "e",
      latency_ms: 500,
      routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
    };
  };
  const history = [{ title: "THE SILENT LIBRARY OF SHADOWS", category: "MYSTERY" }];

  const out = await generateQuest(c, [], history, { gemma: gemmaFake, routes: [routeGo], now: () => wall, trace: [] });

  assert.equal(calls.length, 2, "a quality rejection gets exactly one regeneration");
  const qFail = out.trace.find((t) => t.stage === "quality" && t.ok === false);
  assert.equal(qFail.reason, "duplicate-quest", "the quality rejection stays visible");
  assert.ok(out.trace.some((t) => t.stage === "gemma_regenerate"), "duplicate-quest cannot be patched, it is a full regeneration");
  // At the regeneration call the wall clock is 204000, so 6000ms of the
  // generation budget would still be available - the deadline must not use it.
  assert.equal(calls[1].deadline, 204000 + TIMING.regen_budget_ms, "regeneration is capped at regen_budget_ms even with gen budget left");
  assert.equal(calls[1].budget_ms, TIMING.regen_budget_ms);
  assert.ok(calls[1].deadline < calls[0].deadline, "the regeneration deadline is strictly earlier than attempt 1's");
  assert.equal(calls[1].prompt, "", "a full regeneration uses the full prompt, not the field-repair prompt");
  assert.ok(out.quest, "the regenerated quest is served");
  assert.equal(out.quest.title, "THE OLDEST DOOR NUMBER");
  assert.equal(out.failReason, "");
});

test("generateQuest: regeneration timeout falls back immediately with an honest trace", async () => {
  resetRouteHealth();
  const calls = [];
  let wall = 300000;
  const gemmaFake = async (_c, _places, _feedback, _history, opts) => {
    calls.push({ deadline: opts.deadline, budget_ms: opts.budget_ms, at: wall });
    if (calls.length === 1) {
      wall += 3500;
      return {
        raw: quest({ steps: ["Slip past the restricted area sign to reach the old platform.", "Find one strange window and photograph its frame."] }),
        model: "m", provider: "google-generative-ai", endpoint: "e",
        latency_ms: 3500,
        routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
      };
    }
    // The regeneration burns its whole short budget at the provider.
    wall += TIMING.regen_budget_ms;
    const err = new Error("google/gemma-4-26b-a4b-it: timeout after 5000ms; generation budget exhausted after 5000ms");
    err.routeTrace = [{ stage: "budget_exhausted", ok: false, reason: "only 0ms left of the 5000ms regeneration budget" }];
    throw err;
  };

  const out = await generateQuest(c, [], [], { gemma: gemmaFake, routes: [routeGo], now: () => wall, trace: [] });

  assert.equal(calls.length, 2, "exactly one regeneration attempt, then stop");
  assert.equal(calls[1].budget_ms, TIMING.regen_budget_ms);
  assert.equal(calls[1].deadline, 303500 + TIMING.regen_budget_ms, "the regeneration could never have waited longer than regen_budget_ms");
  assert.equal(out.quest, null, "no generation is served");
  assert.equal(out.served, null, "the fallback is never relabelled as gemma");
  assert.equal(out.failReason, "regeneration-timeout", "the failure is labelled as a regeneration timeout, not hidden");
  const stages = out.trace.map((t) => t.stage);
  assert.ok(stages.includes("gemma_generate"), "the first attempt is traced");
  const safetyFail = out.trace.find((t) => t.stage === "safety" && t.ok === false);
  assert.ok(safetyFail, "the safety rejection stays in the trace");
  assert.ok(stages.includes("budget_exhausted"), "the regeneration budget exhaustion stays in the trace");
  const regenFail = out.trace.find((t) => t.stage === "gemma_regenerate" && t.ok === false);
  assert.ok(regenFail, "the failed regeneration is visible, not hidden");
  assert.ok(!out.trace.some((t) => t.stage === "gemma_regenerate" && t.ok === true), "nothing pretends the regeneration succeeded");
});

test("generateQuest: open circuits mean an immediate curated fallback, no provider wait", async () => {
  const health = new Map([
    ["openrouter:openrouter.ai", { until: Date.now() + 30000, reason: "http 429 rate limited", fails: 1 }],
    [goKey, { until: Date.now() + 30000, reason: "timeout after 9000ms", fails: 2 }],
  ]);
  const t0 = Date.now();
  const out = await generateQuest(c, [], [], { routes: [routeOr, routeGo], health, trace: [] });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `open circuits must fall back near-instantly, took ${ms}ms`);
  assert.equal(out.quest, null);
  assert.equal(out.served, null);
  assert.equal(out.failReason, "circuit-open");
  const stages = out.trace.map((t) => t.stage);
  assert.ok(stages.includes("circuit_check"), "the fast path is visible");
  assert.ok(stages.includes("route_skip"), "the skipped providers are visible");
  assert.ok(!stages.includes("gemma_generate"), "nothing was generated");
});

test("generateQuest: a healthy Gemma attempt is still served as gemma", async () => {
  resetRouteHealth();
  let calls = 0;
  const gemmaFake = async () => {
    calls += 1;
    return {
      raw: quest(),
      model: "gemma-4-26b-a4b-it",
      provider: "google-generative-ai",
      endpoint: "generativelanguage.googleapis.com",
      latency_ms: 600,
      routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
    };
  };
  const out = await generateQuest(c, [], [], { gemma: gemmaFake, routes: [routeGo], trace: [] });

  assert.equal(calls, 1, "one attempt is enough");
  assert.ok(out.quest, "the quest is served");
  assert.equal(out.source, "gemma-4-26b-a4b-it");
  assert.equal(out.served.provider, "google-generative-ai");
  assert.equal(out.failReason, "");
  const stages = out.trace.map((t) => t.stage);
  for (const s of ["gemma_generate", "safety", "location", "quality", "personalization"]) {
    assert.ok(stages.includes(s), `${s} stage traced`);
  }
  assert.equal(out.trace.find((t) => t.stage === "safety").ok, true);
  assert.ok(!stages.includes("gemma_regenerate"), "no regeneration was needed");
});

test("generateQuest: the safety gate stays just as strict on the regeneration", async () => {
  resetRouteHealth();
  let calls = 0;
  const gemmaFake = async () => {
    calls += 1;
    const steps = calls === 1
      ? ["Slip past the restricted area sign to reach the old platform.", "Find one strange window and photograph its frame."]
      : ["Climb the fence behind the depot for a better view of the yard.", "Notice one shadow and sketch its shape."];
    return {
      raw: quest({ steps }),
      model: "m", provider: "google-generative-ai", endpoint: "e",
      latency_ms: 100,
      routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
    };
  };

  const out = await generateQuest(c, [], [], { gemma: gemmaFake, routes: [routeGo], trace: [] });

  assert.equal(calls, 2, "the regeneration was attempted");
  const fails = out.trace.filter((t) => t.stage === "safety" && t.ok === false);
  assert.equal(fails.length, 2, "both unsafe outputs were rejected");
  assert.equal(fails[0].reason, "unsafe:restricted-area");
  assert.equal(fails[1].reason, "unsafe:climbing", "the regeneration is scanned with the same unchanged rules");
  assert.equal(out.quest, null, "an unsafe regeneration is never served");
  assert.equal(out.served, null, "and it is never relabelled as a success");
});

test("regeneration: a live provider attempt can never outlive its deadline", async () => {
  const health = new Map();
  const deadline = Date.now() + 400;
  const t0 = Date.now();
  await assert.rejects(
    gemma(c, [], "", [], {
      routes: [routeGo],
      health,
      timings: { ...TIMING, min_attempt_ms: 100 },
      deadline,
      budget_ms: TIMING.regen_budget_ms,
      call: (_r, _m, _p, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(signal.reason), { once: true })),
    }),
    (e) => {
      assert.ok(e.routeTrace.some((t) => t.stage === "route_attempt" && t.ok === false), "the cut-off attempt is traced");
      assert.match(e.message, /timeout|budget/i);
      return true;
    },
  );
  const ms = Date.now() - t0;
  assert.ok(ms >= 350, "it waited for its own deadline instead of failing instantly");
  assert.ok(ms < 1000, `a regeneration attempt must be cut off at its deadline, took ${ms}ms`);
});

// --- generateQuest: regen budget exhausted -> curated fallback immediately ---
test("generateQuest serves curated fallback immediately when regeneration budget cannot be met", async () => {
  resetRouteHealth();
  let first = true;
  const c = { state: "surprise", energy: 30, budget: 0, social: "solo", chaos: 3, city: "", excuse: "", minutes: 0 };
  const q = (o = {}) => ({
    title: "X".repeat(20),
    hook: "Y".repeat(20),
    objective: "Z".repeat(20),
    steps: ["A".repeat(15), "B".repeat(15), "C".repeat(15)],
    duration_minutes: 25,
    budget: 0,
    difficulty: "easy",
    xp: 55,
    category: "OBSERVER",
    done_when: "D".repeat(20),
    ...o,
  });
  const routeGo = { kind: "google", provider: "google-generative-ai", host: "generativelanguage.googleapis.com", key: "k", models: ["gemma-4-26b-a4b-it"] };
  const gemmaFake = async () => {
    if (first) {
      first = false;
      return {
        raw: q({
          title: "THE SILENT LIBRARY OF SHADOWS",
          hook: "The oldest bench on this street has a number nobody can read.",
          objective: "Find one overlooked detail and document it.",
        }),
        model: "m",
        provider: "google-generative-ai",
        endpoint: "e",
        latency_ms: 50,
        routeTrace: [{ stage: "route_attempt", provider: "google-generative-ai", ok: true }],
      };
    }
    throw new Error("should not be called when budget exhausted");
  };
  const history = [{ title: "THE SILENT LIBRARY OF SHADOWS", category: "OBSERVER" }];
  const out = await generateQuest(c, [], history, {
    gemma: gemmaFake,
    routes: [routeGo],
    timings: { ...TIMING, min_attempt_ms: 10, min_regenerate_ms: TIMING.regen_budget_ms + 1000 },
    now: () => 10000,
    trace: [],
  });
  const traceStages = out.trace.map((t) => t.stage);
  assert.ok(traceStages.includes("quality"), "quality rejection was recorded");
  assert.ok(traceStages.includes("regen_budget_exhausted") || traceStages.includes("budget_exhausted"), "a budget-exhaustion stage was recorded");
  assert.ok(!out.quest, "quest was not produced from generation");
});
