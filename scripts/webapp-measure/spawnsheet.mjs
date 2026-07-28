import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The new-session sheet: the composer's model dial hosted inside it, plus the focus ring, lowercase
// entry, pill actions and the slide-up family.
//
// Three claims, three instruments, and the first one is the acceptance criterion:
//
//   CONGRUENCY. The sheet must not RESEMBLE the composer's dial, it must BE it. Both hosts are opened
//   in one page and a row from each is compared — DOM shape and computed values. A copy-paste
//   implementation passes on the day it ships and drifts the first time either side is touched; this
//   check is what makes the shared-component claim falsifiable rather than a promise.
//
//   THE FOCUS RING IS MEASURED IN PIXELS. Before v0.4.174 no rule touched that field's focus, so
//   `outline-style` resolved to the UA's `auto` — a computed-style assertion ("it has an outline")
//   PASSES on the broken page while each platform paints its own colour: amber on the owner's Android
//   WebView, a white/near-black double ring in headless Chromium off identical bytes.
//
//   NOTHING LOST, both directions. Every model/effort/mode value in HEAD's SPAWN_OPTS must still be
//   reachable in the new lists — that check passes on both pages by design. SURFACE inverts it: the
//   owner removed the picker, so the assertion is that the sheet offers no surface control and sends
//   no `headless` key WHILE the API still accepts one, which the live headless spawn proves.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const BASE = join(mkdtempSync(join(tmpdir(), "spawn-")), "head.html");
writeFileSync(BASE, execFileSync("git", ["show", "HEAD:webapp/index.html"], { cwd: REPO, maxBuffer: 32e6 }));

// What /api/settings answers on the owner's box. prefMode arrives as a LABEL ("Bypass"), the other
// two as raw aliases — the sheet has to render all three the way the dial renders them.
const SETTINGS = { settings: { spawnModel: { value: "opus" }, spawnEffort: { value: "high" }, prefMode: { value: "\ud83d\udea8 Bypass", raw: "bypassPermissions" } } };
const SETTINGS_OFF = { settings: { spawnModel: { value: "off" }, spawnEffort: { value: "off" }, prefMode: { value: "\ud83c\udfe0 Default", raw: "" } } };
const FEED = { sid: "s1", name: "probe", working: false, cwd: "~/x", model: "Opus 5", effort: "high",
  defModel: "opus", defEffort: "high", items: [] };

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };
const near = (a, b, tol, l) => check(Math.abs(a - b) <= tol, `${l} (${a?.toFixed ? a.toFixed(2) : a} vs ${b})`);

const b = await chromium.launch();
const open = async (path, settings = SETTINGS, opts = {}) => {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...opts });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(({ s, feed }) => {
    window.__posts = [];
    window.api = async u => u.includes("/api/settings") ? s : u.includes("feed") ? feed : { sessions: [] };
    // The spawn goes through writeOp, which uses fetch directly — stubbing `api` alone records nothing.
    window.fetch = async (u, o) => {
      window.__posts.push({ u: String(u), body: JSON.parse(o?.body || "{}") });
      return new Response(JSON.stringify({ ok: true, name: "probe", sid: "s1" }), { headers: { "content-type": "application/json" } });
    };
    openSpawnSheet();
  }, { s: settings, feed: FEED });
  await p.waitForTimeout(600);
  return p;
};
const p = await open(PAGE);

// ---- 1. CONGRUENCY: one component, two hosts ----------------------------------------------------
const cong = await p.evaluate(async () => {
  // Model is a drill row in the sheet now, so its rows live on the detail page — drill in, then
  // compare. Same claim, one tap further in.
  document.querySelector('#spp1 .dialrow[data-drill="model"]')?.click();
  await new Promise(r => setTimeout(r, 250));
  await openDrill("s1", "probe");
  await new Promise(r => setTimeout(r, 400));
  document.getElementById("ddial").onclick();
  await new Promise(r => setTimeout(r, 300));
  const shape = row => {
    if (!row) return null;
    const cs = getComputedStyle(row);
    const part = sel => { const e = row.querySelector(sel); if (!e) return null; const c = getComputedStyle(e);
      return { size: c.fontSize, colour: c.color, weight: c.fontWeight, display: c.display }; };
    return {
      tag: row.tagName, cls: row.className.replace(/\bon\b/, "").trim(),
      h: +row.getBoundingClientRect().height.toFixed(1),
      pad: cs.padding, gap: cs.gap, border: cs.borderTopWidth + " " + cs.borderTopColor, size: cs.fontSize,
      name: part(".nm .n"), desc: part(".nm .d"), tick: part(".tick"),
      kids: [...row.children].map(e => e.className || e.tagName.toLowerCase()).join("|"),
    };
  };
  // The same MODEL in both hosts, so any difference is the host's and not the row's content.
  const inDial = [...document.querySelectorAll("#dialmodels .dialrow")].find(r => r.dataset.v === "sonnet");
  const inSheet = [...document.querySelectorAll("#spdetail .dialrow")].find(r => r.dataset.v === "sonnet");
  return { dial: shape(inDial), sheet: shape(inSheet),
    dialCount: document.querySelectorAll("#dialmodels .dialrow").length,
    sheetCount: document.querySelectorAll("#spdetail .dialrow").length,
    dialVals: [...document.querySelectorAll("#dialmodels .dialrow")].map(r => r.dataset.v).join(","),
    sheetVals: [...document.querySelectorAll("#spdetail .dialrow")].map(r => r.dataset.v).join(","),
    oneBuilder: typeof dialRow === "function" && document.querySelectorAll("#spdetail .dialrow[data-k]").length > 0 };
});
check(!!cong.dial && !!cong.sheet, "the same model row renders in BOTH hosts");
for (const k of ["tag", "cls", "h", "pad", "gap", "border", "size", "kids"]) {
  check(JSON.stringify(cong.dial?.[k]) === JSON.stringify(cong.sheet?.[k]),
    `row ${k} is congruent across hosts (${JSON.stringify(cong.dial?.[k])} vs ${JSON.stringify(cong.sheet?.[k])})`);
}
for (const part of ["name", "desc", "tick"]) {
  check(JSON.stringify(cong.dial?.[part]) === JSON.stringify(cong.sheet?.[part]),
    `its .${part} is congruent (${JSON.stringify(cong.dial?.[part])} vs ${JSON.stringify(cong.sheet?.[part])})`);
}
check(cong.oneBuilder, "and both are built by the one dialRow()");
// With no synthetic rows left, the two hosts' lists are the same list.
check(cong.dialCount === cong.sheetCount && cong.dialVals === cong.sheetVals,
  `both hosts render the SAME rows, count for count (${cong.dialVals} vs ${cong.sheetVals})`);

// ---- 2. The overlay's OWN presentation: concrete rows, the badge on the configured default --------
const rows = async (pg, sel = "#spdetail") => pg.evaluate(s => [...document.querySelectorAll(s + " .dialrow")].map(r => ({
  v: r.dataset.v, n: r.querySelector(".nm .n")?.textContent.trim(), d: r.querySelector(".nm .d")?.textContent.trim(),
  on: r.classList.contains("on"), badge: r.querySelector(".badge")?.textContent.trim() || "" })), sel);
// Null-safe throughout: the pre-change page's list is a different shape, and a control run has to
// print a readable column rather than die on the first missing element.
const drillModel = async pg => { await pg.evaluate(async () => {
  document.getElementById("spawn").classList.remove("p2");
  document.querySelector('#spp1 .dialrow[data-drill="model"]')?.click();
  await new Promise(r => setTimeout(r, 250)); }); };
await drillModel(p);
const M = await rows(p);
check(!M.some(r => r.v === ""), `no synthetic row in the list — concrete options only (${M.map(r => r.v).join(",")})`);
check(M.map(r => r.v).join(",") === "fable,opus,sonnet,haiku",
  `it IS the dial's table, in its order (${M.map(r => r.v).join(",")})`);
check(M.filter(r => r.badge).length === 1 && M.find(r => r.v === "opus")?.badge === "Default",
  `the Default badge sits on the configured default, and only there (${M.filter(r => r.badge).map(r => r.v + ":" + r.badge).join(",") || "none"})`);
check(M.filter(r => r.on).length === 1 && M.find(r => r.v === "opus")?.on,
  `which is also the row that comes preselected (${M.filter(r => r.on).map(r => r.v).join(",") || "none"})`);
// Nothing configured: no badge to place, so nothing is marked — and the sheet must not invent one.
const pOff = await open(PAGE, SETTINGS_OFF);
await drillModel(pOff);
const MOff = await rows(pOff);
check(!MOff.some(r => r.badge) && !MOff.some(r => r.on),
  `with nothing configured no row is badged or ticked (${MOff.filter(r => r.badge || r.on).map(r => r.v).join(",") || "none"})`);
check(await pOff.evaluate(() => document.getElementById("speffnow").textContent) === "not set",
  "and the drill rows say so rather than naming a value nobody configured");
await pOff.close();

// ---- 3. Effort and Mode drill in, and Surface is gone --------------------------------------------
const drill = await p.evaluate(async () => { try {
  const out = {};
  // Back to page 1 through the BUTTON, not by stripping the class: the track's height is set in JS,
  // so a class change alone leaves it at the previous page's height and the "height follows the live
  // page" check below would compare a stale number with itself.
  document.getElementById("spback").click();
  await new Promise(r => setTimeout(r, 300));
  out.rowsOnP1 = [...document.querySelectorAll("#spp1 .dialrow[data-drill]")].map(r => ({
    k: r.dataset.drill, n: r.querySelector(".nm .n").textContent.trim(), d: r.querySelector(".nm .d").textContent.trim(),
    chev: !!r.querySelector(".chev"), card: r.closest(".diallist").querySelectorAll(".dialrow").length }));
  const h0 = document.querySelector("#spawn .dialpages").style.height;
  document.querySelector('#spp1 .dialrow[data-drill="mode"]').click();
  await new Promise(r => setTimeout(r, 350));
  out.p2 = document.getElementById("spawn").classList.contains("p2");
  out.title = document.getElementById("spdetailt").textContent;
  out.detail = [...document.querySelectorAll("#spdetail .dialrow")].map(r => r.dataset.v);
  out.trackMoved = document.querySelector("#spawn .dialpages").style.height !== h0;
  document.querySelector('#spdetail .dialrow[data-v="plan"]').click();
  await new Promise(r => setTimeout(r, 350));
  out.backOnP1 = !document.getElementById("spawn").classList.contains("p2");
  out.modeNow = document.getElementById("spmodenow").textContent;
  return out;
} catch (e) { return { rowsOnP1: [], detail: [], err: String(e) }; } });
// The two gaps are compared to EACH OTHER, never to 8: the claim is that they match, and a future
// spacing change should keep this passing rather than need it re-tuned. Measured rect-to-rect, which
// is the only reading that sees the difference — rows inside one card sit 0px apart (their divider is
// a border inside the row's own box) while two cards sit --sp-2 apart, and both look like "a gap" in
// the stylesheet.
const gaps = await p.evaluate(() => {
  document.getElementById("spback").click();
  const card = k => document.querySelector(`#spp1 .dialrow[data-drill="${k}"]`)?.closest(".diallist");
  const [mo, ef, md] = ["model", "effort", "mode"].map(card);
  const nm = document.getElementById("spname");
  if (!mo || !ef || !md || !nm) return null;
  const r = e => e.getBoundingClientRect();
  return { above: +(r(ef).top - r(mo).bottom).toFixed(2),
    below: +(r(md).top - r(ef).bottom).toFixed(2),
    name: +(r(nm).top - r(md).bottom).toFixed(2) };
});
check(gaps !== null && Math.abs(gaps.above - gaps.below) < 0.2,
  `Effort→Mode is the same gap as Model→Effort (${gaps?.below} vs ${gaps?.above})`);
check(gaps !== null && Math.abs(gaps.above - gaps.name) < 0.2,
  `and the name field takes it too, under Mode (${gaps?.name} vs ${gaps?.above})`);
check((gaps?.above ?? 0) > 0, `and neither is zero — a shared card would read 0 (${gaps?.above})`);
check(drill.rowsOnP1.length === 3 && drill.rowsOnP1.every(r => r.chev),
  `Model, Effort and Mode are all drill rows (${JSON.stringify(drill.rowsOnP1.map(r => r.n))})`);
check(drill.rowsOnP1.map(r => r.n).join(",") === "Model,Effort,Mode", "in that order");
check(drill.rowsOnP1.map(r => r.d).join(",") === "Opus 5,High,Bypass",
  `each showing its RESOLVED value inline, never the word "Default" (${drill.rowsOnP1.map(r => r.d).join(",") || "no rows"})`);
check(drill.rowsOnP1.every(r => r.card === 1),
  `and each sits in its own card, which is what keeps one gap rhythm (rows per card: ${drill.rowsOnP1.map(r => r.card).join(",")})`);
check(drill.p2 && drill.title === "Mode", `tapping one opens the shared detail page, titled for it (${drill.title})`);
check(drill.detail.join(",") === "default,acceptEdits,plan,bypassPermissions",
  `carrying every mode and no synthetic row (${drill.detail.join(",")})`);
check(drill.trackMoved, "and the track's height follows the live page");
check(drill.backOnP1 && drill.modeNow === "Plan", `a pick returns to the list with the row updated (${drill.modeNow})`);
const surface = await p.evaluate(() => ({
  rows: document.querySelectorAll("#spawn [data-drill='surface']").length,
  text: document.getElementById("spawn").textContent.toLowerCase(),
}));
check(surface.rows === 0 && !surface.text.includes("headless"),
  "the sheet offers no surface control at all — every session it creates gets a topic");

// ---- 4. The payload ------------------------------------------------------------------------------
const post = async (pg, picks) => pg.evaluate(async sel => {
  window.__posts = [];
  Object.assign(spawnSel, sel);
  document.getElementById("spname").value = "probe";
  await document.getElementById("spgo").onclick();
  await new Promise(r => setTimeout(r, 120));
  return window.__posts.find(x => x.u.includes("spawn"))?.body ?? null;
}, picks);
// THE THREE STATES the reverted presentation forces, and the middle one is the decision: an
// untouched sheet and a TAP on the badged row are the same state, so neither can pin today's default
// into tomorrow's session.
const bodyUntouched = await post(p, { model: "", effort: "", mode: "" });
check(bodyUntouched && !("model" in bodyUntouched) && !("effort" in bodyUntouched) && !("mode" in bodyUntouched),
  `untouched sends NOTHING — the daemon resolves all three at spawn time (${JSON.stringify(bodyUntouched)})`);
check(bodyUntouched && !("headless" in bodyUntouched), `and no headless key (${JSON.stringify(bodyUntouched)})`);
const pTap = await open(PAGE);
const bodyTapped = await pTap.evaluate(async () => {
  window.__posts = [];
  // Model is a drill row now, so the badged row is one page in.
  document.querySelector('#spp1 .dialrow[data-drill="model"]')?.click();
  await new Promise(r => setTimeout(r, 250));
  document.querySelector('#spdetail .dialrow[data-v="opus"]')?.click();      // the BADGED row
  await new Promise(r => setTimeout(r, 150));
  document.getElementById("spname").value = "probe";
  await document.getElementById("spgo").onclick();
  await new Promise(r => setTimeout(r, 120));
  return { body: window.__posts.find(x => x.u.includes("spawn"))?.body ?? null, sel: spawnSel.model };
});
check(bodyTapped.sel === "" && !("model" in (bodyTapped.body || {})),
  `tapping the badged row is the same state as leaving it — still no pin (${JSON.stringify(bodyTapped)})`);
await pTap.close();
const p3 = await open(PAGE);
const bodyPicked = await post(p3, { model: "sonnet", effort: "low", mode: "default" });
check(bodyPicked?.model === "sonnet" && bodyPicked?.effort === "low" && bodyPicked?.mode === "default",
  `a named value ships — INCLUDING mode "default", which is what makes the Ask row mean it (${JSON.stringify(bodyPicked)})`);
await p3.close();

// ---- 5. Nothing lost: every value HEAD offered is still reachable ---------------------------------
const p0 = await open(BASE);
const was = await p0.evaluate(() => (typeof SPAWN_OPTS === "object" ? SPAWN_OPTS : null));
await p0.close();
// Read through the page's own globals where they exist — on a pre-change page they do not, and the
// control has to reach the summary line.
const now = await p.evaluate(() => ({
  // The sheet renders these tables on its detail page (checked above, row for row against the
  // overlay); the tables themselves are what "still reachable" means.
  model: typeof DIAL_MODELS === "object" ? DIAL_MODELS.map(([v]) => v) : [],
  effort: typeof DIAL_EFFORTS === "object" ? DIAL_EFFORTS.map(([v]) => v) : [],
  mode: typeof DIAL_MODES === "object" ? DIAL_MODES.map(([v]) => v) : [],
}));
for (const k of ["model", "effort", "mode"]) {
  const missing = (was?.[k] ?? []).filter(v => v !== "inherit" && !now[k].includes(v));
  check(missing.length === 0, `every ${k} HEAD offered is still reachable (missing: ${missing.join(",") || "none"})`);
}
check((was?.surface ?? []).includes("headless"),
  "HEAD did offer a headless surface — which the API keeps and the live test spawns through");

// ---- 6. Kept verbatim from the approved plan: ring, attributes, pills, slide ----------------------
const ringOf = async pg => {
  const r = await pg.evaluate(() => {
    const i = document.getElementById("spname"); i.focus();
    const b = i.getBoundingClientRect(); return { x: b.x, y: b.y + b.height / 2 };
  });
  await pg.waitForTimeout(150);
  const shot = await pg.screenshot({ clip: { x: r.x - 4, y: r.y - 2, width: 10, height: 4 } });
  return pg.evaluate(async data => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const row = [];
    for (let i = 0; i < img.width; i++) { const d = x.getImageData(i, Math.floor(img.height / 2), 1, 1).data; row.push([d[0], d[1], d[2]]); }
    return row;
  }, shot.toString("base64"));
};
const probe = (pg, v) => pg.evaluate(x => { const d = document.createElement("div");
  d.style.cssText = "position:fixed;left:-99px;top:0;width:4px;height:4px;background:var(" + x + ")";
  document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove();
  return c.match(/\d+/g).slice(0, 3).map(Number); }, v);
const p4 = await open(PAGE);
const btn = await probe(p4, "--btn");
const ring = await ringOf(p4);
check(ring.some(px => Math.max(...px.map((v, i) => Math.abs(v - btn[i]))) <= 12),
  `the focus ring is painted in --btn (${btn}) — scanned ${JSON.stringify(ring)}`);
check(!ring.some(px => (px[0] > 240 && px[1] > 240 && px[2] > 240) || (px[0] < 24 && px[1] < 24 && px[2] < 24)),
  `and the UA's own double ring is gone (${JSON.stringify(ring)})`);
const attrs = await p4.evaluate(() => {
  const i = document.getElementById("spname");
  return { cap: i.getAttribute("autocapitalize"), corr: i.getAttribute("autocorrect"), spell: i.getAttribute("spellcheck"),
    size: parseFloat(getComputedStyle(i).fontSize), radius: parseFloat(getComputedStyle(i).borderTopLeftRadius) };
});
check(attrs.cap === "none", `the name field does not auto-capitalize (autocapitalize=${attrs.cap})`);
check(attrs.corr === "off" && attrs.spell === "false", `nor autocorrect or spellcheck it (${attrs.corr}/${attrs.spell})`);
near(attrs.size, 16, 0.1, "and it is 16px — under that, iOS zooms the page on focus");
near(attrs.radius, 12, 0.5, "field radius is --r-md");
const btns = await p4.evaluate(() => {
  const one = id => { const e = document.getElementById(id), c = getComputedStyle(e), r = e.getBoundingClientRect();
    return { h: r.height, radius: parseFloat(c.borderTopLeftRadius), bg: c.backgroundColor, size: parseFloat(c.fontSize) }; };
  return { cancel: one("spcancel"), create: one("spgo") };
});
const sec = await probe(p4, "--sec");
for (const [k, e] of [["Cancel", btns.cancel], ["Create", btns.create]]) {
  near(e.h, 44, 0.5, `${k} is --fab-h tall — a real touch target`);
  near(e.radius, e.h / 2, 0.6, `${k}'s radius is half its height, a stadium`);
  near(e.size, 16, 0.1, `${k} is --t-body`);
}
check(btns.create.bg === `rgb(${btn.join(", ")})`, `Create carries --btn (${btns.create.bg})`);
check(btns.cancel.bg === `rgb(${sec.join(", ")})`, `Cancel carries --sec (${btns.cancel.bg})`);
const slide = await p4.evaluate(async () => { try {
  const s = document.getElementById("spawn"), sheet = s.querySelector(".sheet");
  const trans = getComputedStyle(sheet).transitionDuration;
  s.classList.remove("show", "up");
  await new Promise(r => requestAnimationFrame(r));
  openSpawnSheet();
  const atOpen = getComputedStyle(sheet).transform;
  await new Promise(r => setTimeout(r, 400));
  return { trans, atOpen, settled: getComputedStyle(sheet).transform, up: s.classList.contains("up") };
} catch (e) { return { trans: "-", atOpen: "none", settled: "none", up: false, err: String(e) }; } });
check(slide.trans === "0.18s", `the sheet transitions in 180ms, like #dial and #calls (${slide.trans})`);
check(slide.atOpen !== "none" && slide.atOpen !== slide.settled,
  `it starts OFF-SCREEN and animates from there (${slide.atOpen} → ${slide.settled})`);
check(slide.up && (slide.settled === "none" || /matrix\(1, 0, 0, 1, 0, 0\)/.test(slide.settled)), `and settles flush (${slide.settled})`);
await p4.close();

// ---- 6b. THE KEYBOARD CRITERION -----------------------------------------------------------------
// What the move is actually for: with the keyboard up, the focused name field must still be ON SCREEN.
// Simulated by shrinking the viewport, which is what a keyboard does to the layout viewport — and the
// pre-move page reproduces the complaint exactly (field at the sheet's top, pushed off above it), so
// this section is a real control rather than a claim. Hit-tested as well as rect-checked: "its rect is
// inside the viewport" and "you can actually tap it" are different questions.
for (const [label, vh] of [["keyboard up (~300px)", 544], ["small phone + keyboard", 420]]) {
  const pk = await open(PAGE, SETTINGS, { viewport: { width: 390, height: vh } });
  const k = await pk.evaluate(() => {
    const nm = document.getElementById("spname"), go = document.getElementById("spgo");
    if (!nm) return null;
    nm.focus();
    const vis = e => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; };
    const hit = e => { const b = e.getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!el && (el === e || e.contains(el)); };
    const b = nm.getBoundingClientRect();
    return { focused: document.activeElement?.id, top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1),
      vh: innerHeight, vis: vis(nm), hit: hit(nm), createVis: vis(go), createHit: hit(go),
      sheetTop: +document.querySelector("#spawn .sheet").getBoundingClientRect().top.toFixed(1) };
  });
  check(k?.focused === "spname", `${label}: the field takes focus (${k?.focused})`);
  check(!!k?.vis, `${label}: and stays ON SCREEN while typing — ${k?.top}-${k?.bottom} in a ${k?.vh}px viewport`);
  check(!!k?.hit, `${label}: and is tappable there, not merely inside the box`);
  check(!!k?.createVis && !!k?.createHit, `${label}: Create is reachable too (${k?.createVis}/${k?.createHit})`);
  await pk.close();
}

// ---- 7. Shots ------------------------------------------------------------------------------------
if (process.argv[3]) {
  mkdirSync(process.argv[3], { recursive: true });
  const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
    "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };
  for (const [name, path, vars, drillTo] of [["before", BASE, null, null], ["after", PAGE, null, null],
    ["after-model", PAGE, null, "model"], ["after-mode", PAGE, null, "mode"], ["after-light", PAGE, LIGHT, null]]) {
    const s = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await s.goto("file://" + path, { waitUntil: "domcontentloaded" });
    if (vars) await s.evaluate(v => { for (const [k, val] of Object.entries(v))
      document.documentElement.style.setProperty("--tg-theme-" + k, val); pinChromeColour(); }, vars);
    await s.evaluate(x => { window.api = async u => u.includes("/api/settings") ? x : { sessions: [] }; openSpawnSheet(); }, SETTINGS);
    await s.waitForTimeout(700);
    if (drillTo) { await s.click(`#spp1 .dialrow[data-drill="${drillTo}"]`).catch(() => {}); await s.waitForTimeout(400); }
    else { await s.evaluate(() => document.getElementById("spname").focus()); await s.waitForTimeout(250); }
    await s.screenshot({ path: join(process.argv[3], `spawnsheet-${name}.png`) });
    await s.close();
  }
  console.log(`\nshots → ${process.argv[3]}`);
}

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
