import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE MESSAGE YOU JUST SENT RIDES OPEN UNTIL IT IS BURIED (the owner, 2026-08-08: "when I send a
// message, I don't want it to collapse until it's buried in the conversation; when it's still the
// newest message I want it to remain expanded").
//
// This reverses a stated ruling — "a user bubble keeps its fold whatever its position (you wrote
// it)" — so the checks here are written to say WHICH of the two shipped, not merely that folding
// happens somewhere. The symptom was the snap: an optimistic bubble paints unfolded, and its own
// transcript echo folded it a second later, which reads as the app closing your message under your
// thumb.
//
// The claims, and what each is worth:
//
//   1. A long NEWEST user message renders with no fold at all — full height, no fold bar.
//   2. It folds again once BURIED_ROWS (3) rows have landed after it. Checked at one, two and three
//      rows, because "it eventually folds" is true of a page with no exemption at all.
//   3. An OLDER long user message keeps its fold even while it is within three rows of the end: the
//      exemption belongs to the LAST user row, so a newer message of yours takes it with you.
//   4. A payload-CLIPPED exempt row has its rest fetched, untapped and once — the fold and the
//      auto-fetch reading the same predicate is the whole point of there being one predicate. A row
//      rendered unfolded and clipped at 4000 chars has no tap left to read the rest, which is the
//      trap webapp/CLAUDE.md states for the newest REPLY and which this change extends the reach of.
//   5. GUARDS: the last-reply exemption is untouched, and a buried long user message still folds.
//
//   node userfold.mjs [page]
//
// The CONTROL is the pinned commit before this change, rendered from git — never HEAD, which becomes
// a copy of the page under test the moment this is committed and then measures nothing forever.
// STATE checks must FAIL there; GUARDS must pass on both.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const BASELINE = process.env.USERFOLD_BASELINE || "22cf65b";
const BASE = join(mkdtempSync(join(tmpdir(), "userfold-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

const CLIP_MAX = 268;   // .msg.clip's max-height — the height a FOLDED message shows
const ts = 1785200000000;
// Comfortably past LONG_MSG (700), so a fold is a fold and not a rounding argument.
const long = n => `Paragraph ${n}. ` + "This message is well past the 700-character fold threshold, so the client collapses it behind a tap-to-expand bar unless something exempts it. ".repeat(6);
// The server's clamp: what the poll carries is cut, and the tail exists only behind
// /api/session/message. Claim 4 is that the tail arrives with no tap.
const CLIPPED_SEEN = long(7);
const CLIPPED_FULL = CLIPPED_SEEN + " AND THE TAIL THE POLL NEVER CARRIED.";

const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
const feedOf = items => ({ sid: "abc", name: "cc-bridge", working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high", items });
// Scrollback: long rows of both roles, far enough back that nothing here is ever exempt.
const history = [
  { role: "user", uuid: "h1", text: "short one", ts },
  { role: "assistant", uuid: "h2", text: long(1), ts },
  { role: "user", uuid: "h3", text: long(2), ts },
  { role: "assistant", uuid: "h4", text: long(3), ts },
];
const filler = n => Array.from({ length: n }, (_, i) => ({ role: "assistant", uuid: `f${i}`, text: "later row " + i, ts }));

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();

const open = async path => {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  // One stub for the whole run. Every /api/session/message read is RECORDED, so "fetched once,
  // without a tap" is measured rather than assumed.
  await p.evaluate(({ session, full }) => {
    window.__feed = null;
    window.__fetches = [];
    window.api = async (path, body) => {
      if (path.includes("session/feed")) return window.__feed;
      if (path.includes("session/message")) { window.__fetches.push(body.uuid); return { text: full }; }
      if (path.includes("sessions")) return { sessions: [session] };
      return {};
    };
  }, { session: SESSION, full: CLIPPED_FULL });
  return p;
};

// Drive the app the way the poll does — set the snapshot, let renderDrill() fetch and paint, idle
// past the repaint (README rule 2) before anything is read.
const drive = async (p, items) => {
  await p.evaluate(f => { window.__feed = f; }, feedOf(items));
  await p.evaluate(() => (window.drillSid ? renderDrill() : openDrill("abc", "cc-bridge")));
  await p.waitForTimeout(900);
};
const read = p => p.evaluate(() => [...document.getElementById("dfeed").querySelectorAll(".msg")].map(el => ({
  uuid: el.dataset.uuid || null,
  role: [...el.classList].includes("user") ? "user" : [...el.classList].includes("assistant") ? "assistant" : "other",
  clip: el.classList.contains("clip"),
  more: !!el.querySelector(".more"),
  h: +el.getBoundingClientRect().height.toFixed(1),
  // The sentence that exists ONLY in the server's full copy. A length comparison would pass on the
  // pre-change page, whose folded row renders the clamp PLUS its "tap to expand" bar.
  tail: /THE TAIL THE POLL NEVER CARRIED/.test(el.textContent),
})));
const rowOf = (rows, uuid) => rows.find(r => r.uuid === uuid);

async function measure(page, label, sink) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);   // the feature — must FAIL on the baseline
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);   // unchanged behaviour — passes on both

  // ---- 1. The newest user message is not folded ------------------------------------------------
  await drive(page, [...history, { role: "user", uuid: "mine", text: long(9), ts }]);
  let rows = await read(page);
  let mine = rowOf(rows, "mine");
  if (!mine) return state(false, "the fixture renders the user message");
  state(!mine.clip && !mine.more, `the newest user message is not folded (fold bar ${mine.more})`);
  state(mine.h > CLIP_MAX + 20, `…and renders at its own height, ${mine.h}px, past the ${CLIP_MAX}px fold`);
  // The scrollback is the control that says this is about POSITION and not about the role.
  guard(rowOf(rows, "h3")?.clip && Math.abs(rowOf(rows, "h3").h - CLIP_MAX) <= 1,
    `an old long user message in the same feed still folds (${rowOf(rows, "h3")?.h}px)`);

  // ---- 2. …until three rows have landed on top of it -------------------------------------------
  // One, two, three: "it eventually folds" is true of a page with no exemption at all, so the shape
  // of the boundary is the claim. The rule is positional and has no on-screen guard of its own —
  // that guard belongs to a HAND-opened fold (openMsgs), which is a different state.
  for (const n of [1, 2]) {
    await drive(page, [...history, { role: "user", uuid: "mine", text: long(9), ts }, ...filler(n)]);
    mine = rowOf(await read(page), "mine");
    state(!mine.clip, `${n} row${n > 1 ? "s" : ""} after it is not yet buried (${mine.h}px)`);
  }
  await drive(page, [...history, { role: "user", uuid: "mine", text: long(9), ts }, ...filler(3)]);
  mine = rowOf(await read(page), "mine");
  guard(mine.clip && Math.abs(mine.h - CLIP_MAX) <= 1, `the third row buries it and it folds again (${mine.h}px)`);

  // ---- 3. A newer message of yours takes the exemption with it ----------------------------------
  await drive(page, [...history,
    { role: "user", uuid: "mine", text: long(9), ts },
    { role: "assistant", uuid: "reply", text: "on it", ts },
    { role: "user", uuid: "newer", text: long(10), ts }]);
  rows = await read(page);
  guard(rowOf(rows, "mine")?.clip, `an older long user message keeps its fold (${rowOf(rows, "mine")?.h}px)`);
  state(!rowOf(rows, "newer")?.clip, `…while the newer one is the open one (${rowOf(rows, "newer")?.h}px)`);

  // ---- 4. A clipped exempt row fetches its own rest ---------------------------------------------
  await page.evaluate(() => { window.__fetches.length = 0; });
  await drive(page, [...history, { role: "user", uuid: "cut", text: CLIPPED_SEEN, clipped: true, ts }]);
  await page.waitForTimeout(400);
  const fetches = await page.evaluate(() => window.__fetches.slice());
  const cut = rowOf(await read(page), "cut");
  state(fetches.length === 1 && fetches[0] === "cut", `the clamped rest of an exempt user row is fetched once, untapped (${JSON.stringify(fetches)})`);
  state(!!cut?.tail, `…and the full text is what renders — the server-only tail is on screen (${cut?.h}px)`);

  // ---- 5. The reply exemption is untouched ------------------------------------------------------
  await drive(page, [...history,
    { role: "user", uuid: "mine", text: long(9), ts },
    { role: "assistant", uuid: "reply", text: long(11), ts }]);
  rows = await read(page);
  guard(!rowOf(rows, "reply")?.clip && rowOf(rows, "reply")?.h > CLIP_MAX + 20,
    `the last reply is still exempt (${rowOf(rows, "reply")?.h}px)`);
  // Both exemptions at once, which is the state every turn ends in: your message and the answer to
  // it, neither folded. On the baseline the user half of this is what fails.
  state(!rowOf(rows, "mine")?.clip, `…and your message under it stays open too (${rowOf(rows, "mine")?.h}px)`);
}

const p = await open(PAGE);
await measure(p, "page", (_kind, ok, l) => check(ok, l));

// ---- The control -------------------------------------------------------------------------------
const control = [];
const c = await open(BASE);
await measure(c, `control(${BASELINE})`, (kind, ok, l) => { control.push({ kind, ok, l }); console.log(`${ok ? "pass" : "fail"}  ${l}`); });
const vacuous = control.filter(f => f.kind === "state" && f.ok);
const brokenGuards = control.filter(f => f.kind === "guard" && !f.ok);
const states = control.filter(f => f.kind === "state");
check(states.length > 0 && vacuous.length === 0,
  `every state check FAILS on the control — ${states.length - vacuous.length}/${states.length}`
  + (vacuous.length ? `; measuring nothing: ${vacuous.map(f => f.l).join(" | ")}` : ""));
check(brokenGuards.length === 0,
  `and every guard still holds there — ${control.filter(f => f.kind === "guard").length - brokenGuards.length}/${control.filter(f => f.kind === "guard").length}`
  + (brokenGuards.length ? `; broken: ${brokenGuards.map(f => f.l).join(" | ")}` : ""));

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
