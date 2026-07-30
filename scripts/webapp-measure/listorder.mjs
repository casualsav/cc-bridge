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

const open = async (path, sessions, usage = USAGE) => {
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
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
    state(st.join(" → ") === "usage → card:Chat (@suchag) → label:Coding Sessions → card:cc-bridge → card:memes",
      `header → chat → label → coding sessions, in that order (${st.join(" → ")})`);
    const lab = await p.evaluate(() => {
      const l = document.querySelector("#tab-sessions .sechead");
      if (!l) return null;
      const cs = getComputedStyle(l);
      return { text: l.textContent, transform: cs.textTransform, size: cs.fontSize, colour: cs.color, tracking: cs.letterSpacing, margin: cs.margin };
    });
    labelled = !!lab && lab.text === "Coding Sessions" && lab.transform === "none";
    state(labelled,
      `the label reads exactly "Coding Sessions", un-transformed (${lab ? `${JSON.stringify(lab.text)} / ${lab.transform}` : "no label"})`);
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
    state(st.join(" → ") === "usage → label:Coding Sessions → card:cc-bridge",
      `with no chat lane the label still names the section it heads (${st.join(" → ")})`);
    await p.close();
  }

  // ---- several chat lanes (dmLanes) all lead ----------------------------------------------------
  {
    const p = await open(path, [worker("s1", "cc-bridge"), chat("s4", "Chat (@suchag)"), chat("s5", "Chat (@second)")]);
    const st = await stack(p);
    state(st.join(" → ") === "usage → card:Chat (@suchag) → card:Chat (@second) → label:Coding Sessions → card:cc-bridge",
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
