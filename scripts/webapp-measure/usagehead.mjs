import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE USAGE HEADER on the command center: the account's 5h and weekly windows, shown ONCE, above the
// cards. The owner approved it on 2026-07-30 as the home for a stat that was banned from the CARDS in
// v0.4.232 — and the ban's reasoning is what makes the header right: an account-level number repeated on
// every card said nothing about any session. So the scoped form is what this measures: **no card shows
// it, the header does, exactly once.**
//
// It is deliberately not a new design language, and "looks like the cards" is checked as pixels rather
// than trusted: the header's box must resolve to the SAME fill, radius and padding as a session card,
// and its bars must be the cards' own `pctBar`. What it may differ in is stated and asserted too — it is
// not a tap target.
//
// The two states that are easy to ship broken, and both are checked: a payload with NO usage (an older
// daemon, or a snapshot too stale to date) must render NO header rather than zeros, and a payload with
// one window must render one row rather than inventing the other.
//
// CONTROL: the page pinned before the header. Every state check must FAIL there; the guards (the cards
// themselves, and the ban on per-card usage) held before and must hold after.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// 49906f3 is the last commit whose command center had no usage header.
const BASELINE = process.env.USAGEHEAD_BASELINE || "49906f3";
const BASE = join(mkdtempSync(join(tmpdir(), "usagehead-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

// Two cards, and BOTH carry `h5Pct` on the wire — the field the cards stopped rendering in v0.4.232 and
// still receive. That is what makes "no card shows it" a decision the client makes rather than an empty
// payload, exactly as cardfoot.mjs's chat-lane fixture does for its own rule.
const SESSIONS = [
  { sid: "s1", name: "cc-bridge", cwd: "~/projects/cc-bridge", alive: true, working: true, state: "working",
    task: "measuring the usage header", model: "Opus 5", effort: "high", ctxPct: 42, h5Pct: 25, branch: "main", subagents: 0 },
  { sid: "s2", name: "memes", cwd: "~/projects/memes", alive: true, working: false, state: "idle",
    task: "Deployed and verified.", model: "Sonnet 5", effort: "medium", ctxPct: 18, h5Pct: 25, branch: "main", subagents: 0 },
];
const USAGE = { fiveHour: { pct: 25, resetIn: "1h46m" }, sevenDay: { pct: 84, resetIn: "3d12h" } };

let bad = 0;
const results = [];
const sink = (kind, ok, label) => { results.push({ kind, ok, label }); console.log(`${ok ? "OK  " : "FAIL"}  [${kind}] ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

// 390px, the viewport the owner reads it at.
const open = async (path, usage) => {
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(([ss, u]) => {
    window.api = async q => q.includes("/api/sessions") ? { sessions: ss, ...(u ? { usage: u } : {}) } : {};
    showTab("sessions");
  }, [SESSIONS, usage]);
  await p.waitForTimeout(600);
  return p;
};

const read = p => p.evaluate(() => {
  const h = document.getElementById("usagehead");
  const cards = [...document.querySelectorAll("#tab-sessions .sess:not(.usage)")];
  const c = cards[0];
  const box = el => { const s = getComputedStyle(el); return { fill: s.backgroundColor, radius: s.borderTopLeftRadius, pad: s.padding, cursor: s.cursor }; };
  return {
    present: !!h,
    count: document.querySelectorAll("#tab-sessions .usage").length,
    first: (document.querySelector("#tab-sessions > div") || {}).id || null,
    rows: h ? [...h.querySelectorAll(".foot")].map(r => r.textContent.replace(/\s+/g, " ").trim()) : [],
    bars: h ? [...h.querySelectorAll(".bar span")].map(s => s.style.width) : [],
    head: h ? box(h) : null,
    card: c ? box(c) : null,
    // The scoped ruling: the cards must still show no usage reading, with h5Pct on the wire for both.
    cardsUsage: cards.filter(x => /\b5h\b|weekly|resets in/.test(x.textContent)).map(x => x.querySelector(".nm").textContent),
    payloadHadH5: true,
  };
});

async function measure(path, label, shotPrefix) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);
  let withUsage = false;   // carried across the blocks: "no header without usage" is only a claim about
                           // this change if the header DID appear with it — on a page that never has one,
                           // the absence is true for the wrong reason.

  // ---- the header, with both windows ------------------------------------------------------------
  {
    const p = await open(path, USAGE);
    const m = await read(p);
    withUsage = m.present && m.count === 1 && m.first === "usagehead";
    state(withUsage,
      `the account's usage is shown ONCE, above the cards (present ${m.present}, count ${m.count}, first ${m.first})`);
    state(m.rows.length === 2 && /🕒 5h 25%/.test(m.rows[0]) && /resets in 1h46m/.test(m.rows[0])
      && /📅 weekly 84%/.test(m.rows[1]) && /resets in 3d12h/.test(m.rows[1]),
      `both windows read as themselves, 5h first (${m.rows.join(" | ")})`);
    state(m.bars.join(",") === "25%,84%", `and each bar is its own window's fill, not the other's (${m.bars.join(", ")})`);
    // The vocabulary claim, as pixels: same box as a card, differing only in not being tappable.
    state(!!m.head && !!m.card && m.head.fill === m.card.fill && m.head.radius === m.card.radius && m.head.pad === m.card.pad,
      `it is the card's own box — same fill, radius and padding (${JSON.stringify(m.head)} vs ${JSON.stringify(m.card)})`);
    state(m.head && m.head.cursor === "default" && m.card.cursor === "pointer",
      `…and the one thing it is not is a tap target (${m.head && m.head.cursor} vs ${m.card && m.card.cursor})`);
    // The SCOPED ruling, and the half that did not change.
    guard(m.cardsUsage.length === 0,
      `no CARD shows a usage reading, with h5Pct on the wire for both (${m.cardsUsage.join(", ") || "none"})`);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-command-center-390.png`), clip: { x: 0, y: 0, width: 390, height: 460 } });
    await p.close();
  }

  // ---- no usage on the wire → NO header, not zeros ----------------------------------------------
  {
    const p = await open(path, null);
    const m = await read(p);
    state(withUsage && !m.present && m.first !== "usagehead",
      `a payload with no usage renders no header at all — never a 0% (with usage ${withUsage} → without ${m.present})`);
    guard(await p.evaluate(() => document.querySelectorAll("#tab-sessions .sess").length === 2),
      "…and the cards are unaffected by its absence");
    await p.close();
  }

  // ---- one window → one row ---------------------------------------------------------------------
  {
    const p = await open(path, { fiveHour: { pct: 7, resetIn: "12m" } });
    const m = await read(p);
    state(m.present && m.rows.length === 1 && /🕒 5h 7%/.test(m.rows[0]),
      `one window on the wire renders one row, and invents nothing (${m.rows.join(" | ") || "no header"})`);
    await p.close();
  }

  // ---- a window with no datable reset -----------------------------------------------------------
  {
    const p = await open(path, { fiveHour: { pct: 40, resetIn: null }, sevenDay: { pct: 90, resetIn: "2d" } });
    const m = await read(p);
    state(m.present && !/resets in/.test(m.rows[0]) && /resets in 2d/.test(m.rows[1]),
      `an unknown reset epoch shows the percentage and no countdown, never a placeholder (${m.rows.join(" | ")})`);
    await p.close();
  }
}

await measure(PAGE, "page", "1");

console.log(`\n--- control: ${BASELINE} (no usage header) ---`);
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
  ? "FAIL  the control did not behave: every header check must fail there and the card guards must pass"
  : "OK    the control has no header and still bans usage on the cards");
console.log(`\n${pageBad === 0 && !vacuous ? "PASS" : "FAIL"}  page failures: ${pageBad}`);
await b.close();
process.exit(pageBad === 0 && !vacuous ? 0 : 1);
