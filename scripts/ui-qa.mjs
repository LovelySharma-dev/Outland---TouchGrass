// Visual QA harness: drives the real UI in headless Chrome over CDP (no
// npm dependencies - Node's built-in WebSocket), captures every screen in
// dark and light, desktop and mobile, and runs a contrast audit against the
// actual computed colours.
//
// Run: node scripts/ui-qa.mjs            (server must be up for the live card)
//       BASE=http://host:port OUTLAND_URL=... node scripts/ui-qa.mjs
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 10000 + Math.floor(Math.random() * 20000);
const BASE = process.env.BASE || "http://localhost:3000";
const OUT = path.join(os.tmpdir(), "outland-qa");
await mkdir(OUT, { recursive: true });
const log = (...a) => console.error("[ui-qa]", ...a);
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chrome = CANDIDATES.find((p) => p && existsSync(p));
if (!chrome) { console.error("no Chrome/Edge found"); process.exit(2); }

const profile = path.join(os.tmpdir(), `outland-qa-profile-${PORT}`);
const proc = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--window-size=1280,900", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
proc.stderr.on("data", (d) => (chromeErr += d));
process.on("exit", () => { try { proc.kill(); } catch {} });
const watchdog = setTimeout(() => { log("WATCHDOG timed out; chrome stderr:", chromeErr.slice(0, 800)); proc.kill(); process.exit(4); }, 240000);
watchdog.unref();
log("chrome pid", proc.pid, "port", PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome DevTools endpoint never came up");
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
log("connected to", page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const until = async (expression, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(expression)) return true; } catch {} // context may be mid-navigation
    await sleep(120);
  }
  return false;
};

// Contrast audit - runs inside the page.
const AUDIT = () => {
  const parse = (str) => {
    const c = document.createElement("canvas"); c.width = c.height = 1;
    const x = c.getContext("2d");
    x.clearRect(0, 0, 1, 1);
    x.fillStyle = "#000"; x.fillStyle = str; x.fillRect(0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };
  const effBg = (el) => {
    const layers = []; let n = el;
    while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] === 255) break; } n = n.parentElement; }
    if (!layers.length) layers.push([255, 255, 255, 255]);
    let r = 255, g = 255, b = 255;
    for (let i = layers.length - 1; i >= 0; i--) { const [sr, sg, sb, sa] = layers[i]; const a = sa / 255; r = sr * a + r * (1 - a); g = sg * a + g * (1 - a); b = sb * a + b * (1 - a); }
    return [r, g, b];
  };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
  const sels = [".go", ".ghost", 'button[aria-pressed="true"]', "button", "small", ".tag", ".meta span", ".rarity", ".cat",
    ".stats b", ".stats span", ".hook", ".accepted", ".bonus b", ".done", ".safe", "summary", "footer", "h1",
    ".qtitle", ".obj", ".load .secs", ".stage", "input", ".secret", ".done small", ".welcome",
    ".place b", ".place small", ".place a"];
  const out = [];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = effBg(el);
    const composited = (() => { const a = fg[3] / 255; return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)]; })();
    const fs = parseFloat(cs.fontSize), fw = parseInt(cs.fontWeight) || 400;
    const need = (fs >= 24 || (fs >= 18.66 && fw >= 700)) ? 3 : 4.5;
    const r = ratio(composited, bg);
    out.push({ sel, ratio: r, need, pass: r >= need, size: `${fs}px/${fw}`, fg: cs.color });
  }
  // focus indicator is verified separately via CSS.forcePseudoState (programmatic
  // focus() does not reliably match :focus-visible, so the page-side audit
  // only measures colour contrast).
  return { out };
};

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("CSS.enable");

async function checkFocus(label, scheme) {
  const { root } = await send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "body button" });
  if (!nodeId) return; // screens without buttons (loading/error) skip the focus check
  await send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus-visible"] });
  const { computedStyle } = await send("CSS.getComputedStyleForNode", { nodeId });
  const s = Object.fromEntries(computedStyle.map((c) => [c.name, c.value]));
  const ok = s["outline-style"] === "solid" && parseFloat(s["outline-width"]) >= 2;
  if (!ok) failures.push(`${label}/${scheme}: focus-visible outline "${s["outline-style"]} ${s["outline-width"]} ${s["outline-color"]}"`);
}

let shot = 0;
const failures = [];
async function capture(label, { scheme = "dark", viewport = DESKTOP } = {}) {
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await sleep(180);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${String(++shot).padStart(2, "0")}-${label}-${scheme}-${viewport.mobile ? "mobile" : "desktop"}.png`);
  await writeFile(file, Buffer.from(data, "base64"));
  log("captured", path.basename(file));
  return file;
}
async function audit(label, scheme, viewport) {
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await sleep(150);
  log("audit", label, scheme, viewport.mobile ? "mobile" : "desktop");
  const { out } = await evalJs(`(${AUDIT.toString()})()`);
  for (const row of out) if (!row.pass) failures.push(`${label}/${scheme}: ${row.sel} ratio ${row.ratio} < ${row.need} (${row.size}, ${row.fg})`);
  await checkFocus(label, scheme);
  return { out };
}

try {
  // A real quest from the live pipeline, so the card is not a mock.
  let questPayload = null;
  try {
    const res = await fetch(`${BASE}/api/quest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "side-quest", energy: 50, budget: 0, social: "solo", chaos: 3, city: "Ghaziabad" }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) questPayload = await res.json();
  } catch {}
  if (!questPayload) {
    questPayload = { source: "offline-sample", provider: null, endpoint: null, fallback: null, latency_ms: 0, trace: [], quest: {
      title: "THE SILENT LIBRARY OF SHADOWS", hook: "Your street is hiding one thing you have never once noticed.",
      objective: "Find the object nobody on your street has stopped to look at and document it.",
      steps: ["Stand at your front door and pick the least familiar direction to walk.", "Find the oldest doorway on that street and photograph its handle.",
        "Notice something that has been there for years and you have walked past every day.", "Return home by a different route than the one you took out."],
      done_when: "You found and documented the object.", rarity: "RARE", category: "EXPLORER", difficulty: "medium",
      duration_minutes: 30, budget: 0, xp: 85, bonus_objective: "Spot something red within every block you walk.",
      secret_objective: "Find a view that would make a great album cover.",
      safety: ["Stay in public, well-lit places.", "Skip any step that feels unsafe."],
    } };
  }
  await writeFile(path.join(OUT, "live-quest.json"), JSON.stringify(questPayload, null, 2));

  await send("Emulation.setDeviceMetricsOverride", DESKTOP);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.navigate", { url: `${BASE}/` });
  if (!(await until("document.readyState === 'complete' && !!document.querySelector('.wordmark')", 15000))) {
    throw new Error(`landing never rendered; chromeErr=${chromeErr.slice(0, 500)}`);
  }

  const files = [];
  files.push(await capture("01-landing", { scheme: "dark" }));
  files.push(await capture("02-landing", { scheme: "light" }));
  await audit("landing", "dark", DESKTOP);
  await audit("landing", "light", DESKTOP);

  await evalJs("s1()");
  files.push(await capture("03-mood", { scheme: "dark" }));
  await evalJs("s1()");
  files.push(await capture("04-mood", { scheme: "light" }));
  await audit("mood", "light", DESKTOP);

  await evalJs("S.energy=50;S.budget=0;S.social='solo';s2()");
  await evalJs("[...document.querySelectorAll('#v .g button')][1].click(); [...document.querySelectorAll('#v .row')][0].querySelector('button').click(); [...document.querySelectorAll('#v .row')][1].querySelector('button').click(); 'ok'");
  await evalJs("document.getElementById('excuse')||true");
  files.push(await capture("05-answers-pressed", { scheme: "dark" }));
  await audit("answers", "dark", DESKTOP);
  await evalJs("S.energy=50;S.budget=0;S.social='solo';s2();[...document.querySelectorAll('#v .g button')][1].click();[...document.querySelectorAll('#v .row')][0].querySelector('button').click();'ok'");
  files.push(await capture("06-answers-pressed", { scheme: "light" }));
  await audit("answers", "light", DESKTOP);

  await evalJs("S.chaos=3;s3()");
  files.push(await capture("07-chaos", { scheme: "dark", viewport: MOBILE }));
  await evalJs("S.chaos=3;s3()");
  files.push(await capture("08-chaos", { scheme: "light", viewport: MOBILE }));
  await audit("chaos", "dark", MOBILE);

  // Loading state: the request is held open so the elapsed ticker is visible.
  // gen() itself must not be awaited (its fetch never resolves).
  await evalJs("window.__realFetch=window.fetch;window.fetch=()=>new Promise(()=>{});gen();'started'");
  await sleep(1400);
  files.push(await capture("09-loading", { scheme: "dark" }));
  await audit("loading", "dark", DESKTOP);
  await evalJs("clearInterval(ticker);ticker=null;window.fetch=window.__realFetch;true");

  // Error state: a 503 from the server.
  await evalJs("window.fetch=async()=>({ok:false,status:503,json:async()=>({error:'no safe quest available'})});gen();'started'");
  await until("!!document.querySelector('.cta .go')");
  files.push(await capture("10-error", { scheme: "dark" }));
  await evalJs("window.fetch=window.__realFetch;true");

  // Quest card, both schemes and viewports, plus the secret reveal.
  await evalJs(`show(${JSON.stringify(questPayload)})`);
  files.push(await capture("11-quest", { scheme: "dark" }));
  await evalJs(`show(${JSON.stringify(questPayload)})`);
  files.push(await capture("12-quest", { scheme: "light" }));
  await audit("quest", "dark", DESKTOP);
  await audit("quest", "light", DESKTOP);

  await evalJs(`show(${JSON.stringify(questPayload)})`);
  await evalJs("document.getElementById('sec')?.click()");
  await sleep(400);
  files.push(await capture("13-secret-revealed", { scheme: "dark" }));

  await evalJs(`show(${JSON.stringify(questPayload)})`);
  files.push(await capture("14-quest", { scheme: "dark", viewport: MOBILE }));
  await evalJs(`show(${JSON.stringify(questPayload)})`);
  files.push(await capture("15-quest", { scheme: "light", viewport: MOBILE }));
  await audit("quest-mobile", "light", MOBILE);

  // Location grounding: if the live pipeline selected a real place, the card
  // must actually show it. If it did not, a verified discovery is injected so
  // the banner and the map link still get screenshotted and contrast-audited.
  if (questPayload.quest.location) {
    await evalJs(`show(${JSON.stringify(questPayload)})`);
    const shown = await evalJs(`((document.querySelector(".place b")||{}).textContent||"")`);
    if (!shown || !shown.toLowerCase().includes(String(questPayload.quest.location.name).toLowerCase())) {
      failures.push(`quest card does not show the selected location "${questPayload.quest.location.name}" (rendered: "${shown}")`);
    } else log("selected location rendered on the live quest card:", shown);
  } else {
    log("live payload carried no location; injecting a verified discovery for the location screenshots");
  }
  const placePayload = questPayload.quest.location ? questPayload : {
    ...questPayload,
    quest: { ...questPayload.quest, location: {
      name: "Meghdootam Park", source: "serpapi",
      reason: "quiet public green space suitable for a low-energy observation quest",
      map_url: "https://www.google.com/maps/search/?api=1&query=Meghdootam%20Park%2C%20Ghaziabad",
    } },
  };
  await evalJs(`show(${JSON.stringify(placePayload)})`);
  files.push(await capture("16-place-quest", { scheme: "dark" }));
  await evalJs(`show(${JSON.stringify(placePayload)})`);
  files.push(await capture("17-place-quest", { scheme: "light" }));
  await audit("place-quest", "dark", DESKTOP);
  await audit("place-quest", "light", DESKTOP);
  await evalJs(`show(${JSON.stringify(placePayload)})`);
  files.push(await capture("18-place-quest", { scheme: "dark", viewport: MOBILE }));

  const report = [
    `screenshots: ${files.length}`,
    ...files.map((f) => `  ${path.basename(f)}`),
    "",
    failures.length ? `FAILURES (${failures.length}):\n  ${failures.join("\n  ")}` : "contrast + focus checks: ALL PASS",
  ].join("\n");
  console.log(report);
  await writeFile(path.join(OUT, "report.txt"), report + "\n");
  console.log(`\nartifacts in ${OUT}`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  try { ws.close(); } catch {}
  try { proc.kill(); } catch {}
}
