import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE COMMAND CENTER'S ORDER, owner-ordered 2026-07-30: usage header → the CHAT lane's card, pinned
// first whatever state ordering the daemon sent → a "Coding Sessions" label → the coding sessions.
//
// The fixture is built to make the pin FALSIFIABLE: the chat lane arrives LAST in the payload and idle,
// with the workers working. A render that keeps the daemon's order, or that sorts by state, puts it at
// the bottom — so "the chat card is first" is a claim about this change rather than about the fixture.
//
// The label is checked two ways, because "in the existing vocabulary" and "reading exactly Coding
// Sessions" pull against each other: `.sechead` carries `text-transform: uppercase`, which would render
// CODING SESSIONS. The owner settled the label verbatim, so this panel's label drops the transform and
// keeps every other property — and both halves are asserted, including that the Scheduled view's own
// labels still uppercase (the scope did not leak).
//
// Since 2026-07-30 the label also carries a static decoration: one frozen frame of the working
// spinner's glyph set, BEFORE the words. The text is matched against LABEL (glyph included) rather
// than loosened to a substring — the decoration is part of what the owner ordered, so the check
// asserts it instead of tolerating it, and the WORDS are still checked verbatim on their own.
//
// The glyph also OWNS THE CARDS' DOT COLUMN (the owner's ask, same day): its centre sits on the axis
// every card's status dot centres on. That is asserted two ways, because they can disagree — the
// element's rect (geometry) and the RENDERED ink's centroid (paint), the second because a box flex
// centring reports as centred while its contents paint half a pixel off. Both to ±0.5px, and the
// residual is printed either way rather than rounded into a pass.
//
// CONTROL: the page pinned before the ordering. Every state check must FAIL there; the guards (the cards
// themselves, the header's place, Scheduled's labels) held before and must hold after.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// c156027 is the last commit whose command center rendered the payload's own order with no label.
const BASELINE = process.env.LISTORDER_BASELINE || "c156027";
const BASE = join(mkdtempSync(join(tmpdir(), "listorder-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

const worker = (sid, name, over = {}) => ({ sid, name, cwd: `~/projects/${name}`, alive: true, working: true,
  state: "working", task: "measuring the list order", model: "Opus 5", effort: "high", ctxPct: 42, h5Pct: 26, branch: "main", subagents: 0, ...over });
const chat = (sid, name) => ({ sid, name, chat: true, cwd: "", alive: true, working: false, state: "waiting",
  task: "Approved — shipping it.", model: "Fable 5", effort: "high", ctxPct: 34, h5Pct: 26, branch: "main", subagents: 0 });
// Chat LAST and idle, workers first and working.
const MIXED = [worker("s1", "cc-bridge"), worker("s2", "memes", { state: "waiting", working: false, wait: { label: "gh run watch" } }), chat("s4", "Chat (@suchag)")];
const USAGE = { fiveHour: { pct: 26, resetIn: "1h41m" }, sevenDay: { pct: 85, resetIn: "3d12h" } };

let bad = 0;
const results = [];
const sink = (kind, ok, label) => { results.push({ kind, ok, label }); console.log(`${ok ? "OK  " : "FAIL"}  [${kind}] ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

// dpr is a parameter because one claim in this file is about INK GEOMETRY, not layout: a screenshot's
// resolution IS the measurement's resolution (0.5px at dpr 2, 0.25px at 4), and the layout it measures
// is dpr-independent, so the finer page renders the same boxes and only samples their paint closer.
const open = async (path, sessions, usage = USAGE, dpr = 2, width = 390) => {
  const p = await b.newPage({ viewport: { width, height: 812 }, deviceScaleFactor: dpr });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(([ss, u]) => {
    window.api = async q => q.includes("/api/sessions") ? { sessions: ss, ...(u ? { usage: u } : {}) }
      : q.includes("/api/auto") ? { cron: [{ id: "c1", fireAt: 1785400000000, sessionLabel: "cc-bridge", text: "check the deploy" }], queue: [] } : {};
    showTab("sessions");
  }, [sessions, usage]);
  await p.waitForTimeout(600);
  return p;
};

// The glyph the label carries, and the words it decorates — kept apart so the two claims stay separate.
const GLYPH = "✳";
const WORDS = "Coding Sessions";
const LABEL = `${GLYPH} ${WORDS}`;

// The intensity-weighted centroid x of the ink inside a CSS-px band, in CSS px — how the PAINTED mark
// sits, which a rect cannot answer. The band's own top-left pixel is the ground it measures against, so
// the band must be wider than the mark (callers pad it) and must not straddle two fills.
const inkCentroid = async (p, band) => {
  const shot = await p.screenshot({ clip: band });
  const off = await p.evaluate(async data => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const at = (x, y) => d.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3);
    const bg = at(0, 0);
    let sum = 0, wsum = 0;
    for (let x = 0; x < img.width; x++) {
      let col = 0;
      for (let y = 0; y < img.height; y++) {
        const q = at(x, y);
        col += Math.max(Math.abs(q[0] - bg[0]), Math.abs(q[1] - bg[1]), Math.abs(q[2] - bg[2]));
      }
      sum += col; wsum += col * (x + 0.5);
    }
    return sum === 0 ? null : { cx: wsum / sum, dpr: img.width };   // device px, plus the band's width in them
  }, shot.toString("base64"));
  return off === null ? null : band.x + off.cx / (off.dpr / band.width);
};

// The x where a letter's ink STARTS, in CSS px — the left edge an eye reads, which no rect carries: a
// text rect is the ADVANCE box and every letterform sits inside its own side bearings. `onset` is the
// first column carrying ink at all (2% of the band's peak, above AA noise); `half` is the first
// substantially inked one, reported because a light 12px curve and a semibold 14px one ramp at different
// rates — quoting one number as "the edge" would hide that. The band must hold ONE letter on ONE fill.
const inkOnset = async (p, band, dpr) => {
  const shot = await p.screenshot({ clip: band });
  return p.evaluate(async ([data, bx, d]) => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const at = (x, y) => { const i = (y * img.width + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const bg = at(0, 0);
    const cols = [...Array(img.width)].map((_, x) => {
      let s = 0;
      for (let y = 0; y < img.height; y++) { const q = at(x, y); s += Math.max(Math.abs(q[0] - bg[0]), Math.abs(q[1] - bg[1]), Math.abs(q[2] - bg[2])); }
      return s;
    });
    const peak = Math.max(...cols);
    if (peak === 0) return null;
    return { onset: bx + cols.findIndex(v => v > peak * 0.02) / d, half: bx + cols.findIndex(v => v > peak * 0.5) / d };
  }, [shot.toString("base64"), band.x, dpr]);
};

// The panel's children, in order, each named by what it is — which is the whole claim of this file.
const stack = p => p.evaluate(() => [...document.getElementById("tab-sessions").children].map(e =>
  e.id === "usagehead" ? "usage"
  : e.classList.contains("sechead") ? `label:${e.textContent}`
  : e.classList.contains("sess") ? `card:${e.querySelector(".nm") ? e.querySelector(".nm").textContent : "?"}`
  : e.className || e.tagName));

async function measure(path, label, shotPrefix) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);
  let labelled = false;   // carried into the chat-only case: "no label here" is a claim about the
                          // condition only if a label appeared where one was due. On a page that has no
                          // labels at all, the absence is true for the wrong reason.

  // ---- the full stack --------------------------------------------------------------------------
  {
    const p = await open(path, MIXED);
    const st = await stack(p);
    state(st.join(" → ") === `usage → card:Chat (@suchag) → label:${LABEL} → card:cc-bridge → card:memes`,
      `header → chat → label → coding sessions, in that order (${st.join(" → ")})`);
    const lab = await p.evaluate(() => {
      const l = document.querySelector("#tab-sessions .sechead");
      if (!l) return null;
      const cs = getComputedStyle(l);
      return { text: l.textContent, transform: cs.textTransform, size: cs.fontSize, colour: cs.color, tracking: cs.letterSpacing, margin: cs.margin };
    });
    labelled = !!lab && lab.text === LABEL && lab.transform === "none";
    state(labelled,
      `the label reads exactly ${JSON.stringify(LABEL)}, un-transformed (${lab ? `${JSON.stringify(lab.text)} / ${lab.transform}` : "no label"})`);
    // Stated separately from the whole string above so a change to either half names itself: the words
    // the owner settled are still verbatim, and the decoration leads them rather than trailing or wrapping.
    state(!!lab && lab.text.startsWith(`${GLYPH} `) && lab.text.slice(GLYPH.length + 1) === WORDS,
      `the glyph leads and the words are untouched behind it (${lab ? JSON.stringify(lab.text) : "no label"})`);
    // ---- the glyph sits on the cards' dot column ------------------------------------------------
    // Rects first: the glyph's own element against EVERY card dot, not the first one, so a dot column
    // that is not a column at all cannot pass on its top row.
    const cols = await p.evaluate(() => {
      const g = document.querySelector("#tab-sessions .sechead .sglyph");
      const mid = e => { const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, x: r.x, w: r.width, y: r.y, h: r.height }; };
      const dots = [...document.querySelectorAll("#tab-sessions .sess .top .dot")].map(mid);
      const words = document.querySelector("#tab-sessions .sechead .swords");
      return { glyph: g ? mid(g) : null, dots,
        names: [...document.querySelectorAll("#tab-sessions .sess .nm")].map(e => e.getBoundingClientRect().x),
        words: words ? words.textContent : null };
    });
    const off = cols.glyph ? cols.dots.map(d => Math.abs(d.cx - cols.glyph.cx)) : [];
    state(!!cols.glyph && cols.dots.length >= 2 && off.every(v => v <= 0.5),
      `the glyph's box centres on every card dot's axis — glyph cx ${cols.glyph && cols.glyph.cx}, dots ${cols.dots.map(d => d.cx).join("/")}, residual ${off.map(v => v.toFixed(2)).join("/")}px (≤0.50)`);
    // The words, still verbatim, now in their own element — and landing on the card NAMES' axis, which
    // is the same gap read twice and is what makes the label the cards' own title row rather than a
    // hand-tuned indent.
    state(cols.words === WORDS, `the words are their own element and verbatim (${JSON.stringify(cols.words)})`);
    state(cols.names.length >= 2 && cols.names.every(x => Math.abs(x - (cols.glyph ? cols.glyph.x + cols.glyph.w + 8 : -1)) <= 0.5),
      `…and the words start on the card names' axis — names ${cols.names.join("/")} vs glyph box end + the row's 8px gap ${cols.glyph && (cols.glyph.x + cols.glyph.w + 8)}`);
    // Then PAINT, at dpr 2: a box centred by flex free space reports centred and paints half a pixel
    // down-right (this file's neighbours have been bitten by exactly that), so the mark's own ink is read.
    // Each band is padded 6px past its mark and sits on ONE fill — the label's ground, the card's.
    const pad = 6;
    const gInk = cols.glyph ? await inkCentroid(p, { x: cols.glyph.x - pad, y: cols.glyph.y, width: cols.glyph.w + 2 * pad, height: cols.glyph.h }) : null;
    const dInk = cols.dots.length ? await inkCentroid(p, { x: cols.dots[0].x - pad, y: cols.dots[0].y, width: cols.dots[0].w + 2 * pad, height: cols.dots[0].h }) : null;
    const inkOff = gInk !== null && dInk !== null ? Math.abs(gInk - dInk) : null;
    state(inkOff !== null && inkOff <= 0.5,
      `…and the PAINTED ink agrees — glyph centroid ${gInk && gInk.toFixed(2)} vs dot centroid ${dInk && dInk.toFixed(2)}, residual ${inkOff === null ? "n/a" : inkOff.toFixed(2)}px (≤0.50)`);
    // Vocabulary as computed values, against the SAME class used by the Scheduled view: everything but
    // the transform has to match, or this is a new design element wearing an old class name.
    const other = await p.evaluate(async () => {
      await showTab("auto");
      const l = document.querySelector("#tab-auto .sechead");
      if (!l) return null;
      const cs = getComputedStyle(l);
      return { text: l.textContent, transform: cs.textTransform, size: cs.fontSize, colour: cs.color, tracking: cs.letterSpacing, margin: cs.margin };
    });
    state(!!lab && !!other && lab.size === other.size && lab.colour === other.colour
      && lab.tracking === other.tracking && lab.margin === other.margin,
      `…and is .sechead's own type, colour, tracking and margins (${lab && lab.size}/${lab && lab.colour} vs ${other && other.size}/${other && other.colour})`);
    guard(!!other && other.transform === "uppercase",
      `the scope did not leak — Scheduled's own labels still uppercase (${other && other.transform})`);
    await p.evaluate(() => showTab("sessions"));
    await p.waitForTimeout(400);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-command-center-390.png`), clip: { x: 0, y: 0, width: 390, height: 640 } });
    await p.close();
  }

  // ---- the label's C stands over the card names' own first letter -------------------------------
  // The owner's second ask on this label (2026-07-30). The words' BOX already sits on the names' box
  // axis (checked above), and that axis is the only column every card can share: the names differ in
  // letterform, so their INK edges cannot all coincide with one another, let alone with the label's.
  // So the claim asserted is the strongest true one: the box axis is exact, and against the SAME
  // LETTER on a card — the chat lane's capital C — the painted edges agree to within half a pixel
  // despite the label's 12px/400 against the card's 14px/600. The per-letterform scatter is PRINTED,
  // not gated: it is type, not misalignment, and a check that demanded 0 across letterforms would be
  // demanding something no layout can deliver.
  //
  // TWO CONDITIONS, because a fixture that only ever ran at one width and one DPR is what let this file
  // pass while the owner's phone was in dispute (2026-07-30 — his screenshot, measured against the 11px
  // dot in its own frame as the ruler, agreed with these numbers to a quarter pixel, so the page was
  // right and the single condition was still a gap). The column is built from paddings and so is
  // width-invariant BY CONSTRUCTION — which is a claim, and this is where it gets checked.
  // `scripts/webapp-measure/labelaxis.mjs` sweeps the full range; these two are the cheap standing points.
  for (const { vw, dpr } of [{ vw: 390, dpr: 4 }, { vw: 320, dpr: 3 }]) {
    const cond = `@${vw}px/dpr${dpr}`;
    const p = await open(path, MIXED, USAGE, dpr, vw);
    const at = await p.evaluate(() => {
      const firstChar = el => { const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 1);
        const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, ch: el.firstChild.textContent[0] }; };
      const w = document.querySelector("#tab-sessions .sechead .swords");
      const names = [...document.querySelectorAll("#tab-sessions .sess .nm")];
      return { label: w ? { ...firstChar(w), size: getComputedStyle(w).fontSize, weight: getComputedStyle(w).fontWeight } : null,
        names: names.map(n => ({ ...firstChar(n), full: n.textContent, size: getComputedStyle(n).fontSize, weight: getComputedStyle(n).fontWeight })),
        boxes: { label: w ? w.getBoundingClientRect().x : null, names: names.map(n => n.getBoundingClientRect().x) } };
    });
    const band = r => ({ x: r.x - 4, y: r.y, width: r.w + 8, height: r.h });
    const lab = at.label ? await inkOnset(p, band(at.label), dpr) : null;
    const inks = [];
    for (const n of at.names) inks.push({ ...n, ink: await inkOnset(p, band(n), dpr) });
    // Box axis first — exact, and the reason the ink lands as close as it does.
    state(at.boxes.label !== null && at.boxes.names.length >= 2 && at.boxes.names.every(x => Math.abs(x - at.boxes.label) <= 0.5),
      `${cond} the words' box sits on every card name's box axis — label ${at.boxes.label}, names ${at.boxes.names.join("/")}`);
    // Then the same letter, painted, at 0.25px resolution.
    const twin = inks.find(n => n.ch === "C" && n.ink);
    const twinOff = lab && twin ? Math.abs(lab.onset - twin.ink.onset) : null;
    state(twinOff !== null && twinOff <= 0.5,
      `${cond} …and the label's C paints on a card C's own left edge — ${lab && lab.onset.toFixed(2)} vs ${twin && twin.ink.onset.toFixed(2)} (${twin && JSON.stringify(twin.full)}, ${twin && twin.size}/${twin && twin.weight} against the label's ${at.label && at.label.size}/${at.label && at.label.weight}), residual ${twinOff === null ? "n/a" : twinOff.toFixed(2)}px (≤0.50)`);
    const px2 = v => v === null || v === undefined ? "n/a" : v.toFixed(2);
    console.log(`      ink onsets ${cond} — label ${at.label && at.label.ch}: ${px2(lab && lab.onset)} (half ${px2(lab && lab.half)})`
      + inks.map(n => ` · ${JSON.stringify(n.full)} ${n.ch}: ${px2(n.ink && n.ink.onset)} (half ${px2(n.ink && n.ink.half)})`).join(""));
    // The zoomed crop the owner reads: the label's C directly above the next card's name, at dpr 4.
    if (OUT && at.label && vw === 390) {
      const below = at.names.find(n => n.y > at.label.y);
      if (below) await p.screenshot({ path: join(OUT, `${shotPrefix}-c-axis-zoom.png`),
        clip: { x: at.label.x - 12, y: at.label.y - 10, width: 120, height: (below.y + below.h + 10) - (at.label.y - 10) } });
    }
    await p.close();
  }

  // ---- no coding sessions → no label -----------------------------------------------------------
  {
    const p = await open(path, [chat("s4", "Chat (@suchag)")]);
    const st = await stack(p);
    state(labelled && st.join(" → ") === "usage → card:Chat (@suchag)",
      `a chat-only fleet gets no label — there would be nothing under it (labelled elsewhere ${labelled}; here ${st.join(" → ")})`);
    await p.close();
  }

  // ---- no chat lane → the label still leads the coding sessions ---------------------------------
  {
    const p = await open(path, [worker("s1", "cc-bridge")]);
    const st = await stack(p);
    state(st.join(" → ") === `usage → label:${LABEL} → card:cc-bridge`,
      `with no chat lane the label still names the section it heads (${st.join(" → ")})`);
    await p.close();
  }

  // ---- several chat lanes (dmLanes) all lead ----------------------------------------------------
  {
    const p = await open(path, [worker("s1", "cc-bridge"), chat("s4", "Chat (@suchag)"), chat("s5", "Chat (@second)")]);
    const st = await stack(p);
    state(st.join(" → ") === `usage → card:Chat (@suchag) → card:Chat (@second) → label:${LABEL} → card:cc-bridge`,
      `every chat lane leads, in the payload's own order, and one label follows them (${st.join(" → ")})`);
    guard(await p.evaluate(() => document.querySelectorAll("#tab-sessions .sess:not(.usage)").length === 3),
      "…and no card was lost or duplicated by the reordering");
    await p.close();
  }
}

await measure(PAGE, "page", "1");

console.log(`\n--- control: ${BASELINE} (payload order, no label) ---`);
const mark = results.length;
await measure(BASE, "baseline", "0");
const ctl = results.slice(mark);
const ctlState = ctl.filter(r => r.kind === "state");
const ctlStateFailed = ctlState.filter(r => !r.ok).length;
const ctlGuardFailed = ctl.filter(r => r.kind === "guard" && !r.ok).length;
console.log(`\ncontrol: ${ctlStateFailed}/${ctlState.length} state checks failed on ${BASELINE} (they must), ${ctlGuardFailed} guards failed (must be 0)`);
const pageBad = results.slice(0, mark).filter(r => !r.ok).length;
const vacuous = ctlStateFailed < ctlState.length || ctlGuardFailed > 0;
console.log(vacuous
  ? "FAIL  the control did not behave: every order check must fail there and the guards must pass"
  : "OK    the control renders the payload's order with no label, and keeps every guard");
console.log(`\n${pageBad === 0 && !vacuous ? "PASS" : "FAIL"}  page failures: ${pageBad}`);
await b.close();
process.exit(pageBad === 0 && !vacuous ? 0 : 1);
