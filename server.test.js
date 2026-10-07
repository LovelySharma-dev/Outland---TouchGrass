import test from "node:test";
import assert from "node:assert";
import { validate, safety, quality, fit, maxMinutes, redact, gemma, TIMING, freeOpenRouterModels, freeGoogleModels, curated, gentle } from "./server.js";

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
test("latency ceilings stay far below the old 150s ceiling", () => {
  assert.ok(TIMING.discovery_ms <= 6000, "discovery bounded");
  assert.ok(TIMING.primary_attempt_ms <= 8000, "primary route fails fast");
  assert.ok(TIMING.fallback_attempt_ms <= 20000, "fallback bounded");
  assert.ok(TIMING.gen_budget_ms <= 30000, "generation budget bounded");
  assert.ok(TIMING.discovery_ms + TIMING.gen_budget_ms < 40000, "worst case request under 40s");
  assert.ok(TIMING.max_output_tokens > 0 && TIMING.max_output_tokens <= 1500, "output bounded");
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
  assert.ok(open && open.until - Date.now() >= TIMING.cooldown_error_ms, "the cooldown must outlive the attempt that opened it");
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
    [goKey, { until: Date.now() + 30000, reason: "timeout after 16000ms", fails: 2 }],
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
