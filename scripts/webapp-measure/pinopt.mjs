import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The top-pin's `feed.lastElementChild` read, against the fold's `items[all.length - 1]` model read —
// six states, printed side by side for whichever page you point it at. It is a PROBE, not a check
// suite: it prints numbers and returns 0, because the question it was written to answer was "which of
// these two reads is right", and that is not a pass/fail.
//
//   node pinopt.mjs <abs/path/to/page.html> <label>          (absolute paths — file:// needs one)
//
// WHAT IT ESTABLISHED (v0.4.184, both pages measured — see CLAUDE.md's paragraph on the pin):
//   • The claim that an optimistic bubble makes the pin mis-fire does NOT reproduce (C, C2). The DOM
//     read bottom-pins, which keeps the message you just sent on screen; the model read scrolls it
//     2579px off a 812px viewport for the whole window and snaps it back when the echo lands.
//   • The two reads diverge in exactly ONE reachable state: a GHOST optimistic bubble — one whose
//     echo never matched, alive for the 120s valve — sitting under a reply that has just arrived (E).
//     There the DOM read loses the top-pin and the model read keeps it.
//   • F is E with a cause rather than a hypothesis: the feed's payload clamp (CONVO_CAP = 4000)
//     truncates a long sent message, so `i.text.trim() === o.text` can never match it. Over 4000
//     chars the ghost is not a rare mismatch, it is guaranteed — and it is a visible duplicate
//     bubble for two minutes before it is anything to do with scrolling.
//
// SINCE FIXED (the retirement predicate learned to read `clipped`; see `echoes()` and
// ghostecho.mjs): F now retires and F2 top-pins, with the PIN's own code untouched — which is what
// says the pin was never the bug. E still prints NOT top-pinned and that is correct and expected: it
// hand-builds a ghost whose text matches no transcript item at all, so it demonstrates the mechanism
// rather than a reachable state. It stays as the falsifier — if a future change makes E pass, ask
// what it did to the pin.
//
// INSTRUMENT NOTE: state changes go through `lastDrill = …; feedSig = ""; paintFeed()`, NEVER through
// a helper that calls openDrill() — openDrill RESETS `optimistic`, so a harness that re-opens the
// drill to change the snapshot destroys the very fixture it is trying to build. (`window.drillSid`
// is undefined whatever the app's state: it is a top-level `let`, which never lands on window. A
// `window.drillSid ? renderDrill() : openDrill()` helper therefore re-opens EVERY time.)
const PAGE = process.argv[2];
const LABEL = process.argv[3] || "page";
const ts = 1785200000000;
const long = n => `Paragraph ${n}. ` + "Past the fold threshold so the client collapses it. ".repeat(10);
const huge = "Paragraph 1. " + "A reply long enough to outrun the screen on its own, so the feed has to choose which of its ends to show you. ".repeat(40);
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/p", model: "Opus 5", effort: "high" };
const feedOf = items => ({ sid: "abc", name: "cc-bridge", working: false, cwd: "~/p", model: "Opus 5", effort: "high", items });
const history = [
  { role: "user", text: "short one", ts },
  { role: "assistant", text: "Short reply.", ts },
  ...Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: long(i + 1), ts })),
];
const TALL = { role: "assistant", text: huge, ts, uuid: "u-tall" };
const MINE = "what about the second case?";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(s => {
  window.__feed = null;
  window.api = async path => path.includes("session/feed") ? window.__feed
    : path.includes("sessions") ? { sessions: [s] } : {};
}, SESSION);
// One open, then every later snapshot is applied the way a poll applies it.
const open = async items => {
  await p.evaluate(f => { window.__feed = f; }, feedOf(items));
  await p.evaluate(() => openDrill("abc", "cc-bridge"));
  await p.waitForTimeout(700);
};
const snap = async items => {
  await p.evaluate(f => { lastDrill = f; feedSig = ""; paintFeed(); }, feedOf(items));
  await p.waitForTimeout(400);
};
const read = () => p.evaluate(mine => {
  const feed = document.getElementById("dfeed");
  const fr = feed.getBoundingClientRect();
  const rowOf = el => el && { top: el.getBoundingClientRect().top - fr.top, bottom: el.getBoundingClientRect().bottom - fr.top,
    h: el.getBoundingClientRect().height };
  const msgs = [...feed.querySelectorAll(".msg")];
  const tall = msgs.find(m => m.dataset.uuid === "u-tall") || msgs.find(m => m.getBoundingClientRect().height > feed.clientHeight);
  const own = msgs.filter(m => m.textContent.includes(mine)).pop();
  const vis = el => { const r = rowOf(el); return !!r && r.bottom > 0 && r.top < feed.clientHeight; };
  return { padTop: parseFloat(getComputedStyle(feed).paddingTop) || 0, clientH: feed.clientHeight,
    tall: rowOf(tall), own: rowOf(own), ownVisible: vis(own), nOpt: optimistic.length, rows: msgs.length,
    lastCls: feed.lastElementChild ? [...feed.lastElementChild.classList].filter(c => c !== "msg").join(" ") : null };
}, MINE);
const pinned = m => Math.abs(m.tall.top - m.padTop) <= 2;

console.log(`\n=== ${LABEL} ===`);
// A. the tall reply is newest, nothing sent — the documented top-pin.
await open([...history, TALL]);
let m = await read();
console.log(`A  no optimistic:            tall top=${m.tall.top.toFixed(1)} (padTop ${m.padTop.toFixed(0)}) → ${pinned(m) ? "TOP-PINNED ✓" : "not top-pinned ✗"}`);

// B. the user sends: the real handler pushes the bubble, paints, then forces the bottom.
await p.evaluate(t => { optimistic.push({ text: t, at: Date.now(), state: "pending" }); feedSig = ""; paintFeed();
  const f = document.getElementById("dfeed"); f.scrollTop = f.scrollHeight; }, MINE);
await p.waitForTimeout(400);
m = await read();
console.log(`B  just sent:                own visible=${m.ownVisible} top=${m.own.top.toFixed(1)}  lastRow=.${m.lastCls}  opt=${m.nOpt}`);

// C. THE WINDOW. The POST resolves, the stamp flips pending→sent, html changes, paintFeed re-pins.
await p.evaluate(() => { optimistic[optimistic.length - 1].state = "sent"; feedSig = ""; paintFeed(); });
await p.waitForTimeout(400);
m = await read();
console.log(`C  the ~2s window:           own visible=${m.ownVisible} top=${m.own.top.toFixed(1)}  tall top=${m.tall.top.toFixed(1)} h=${m.tall.h.toFixed(0)}  opt=${m.nOpt}`);

// C2. …and a poll arriving DURING the window, with the transcript still unchanged.
await snap([...history, TALL]);
m = await read();
console.log(`C2 poll during the window:   own visible=${m.ownVisible} top=${m.own.top.toFixed(1)}  tall top=${m.tall.top.toFixed(1)}  opt=${m.nOpt}`);

// D. the echo lands: the transcript's own user row replaces the optimistic one.
await snap([...history, TALL, { role: "user", text: MINE, ts: ts + 1 }]);
m = await read();
console.log(`D  after the echo:           own visible=${m.ownVisible} top=${m.own.top.toFixed(1)}  tall h=${m.tall.h.toFixed(0)} (folded=${m.tall.h < 300})  opt=${m.nOpt}`);

// E. THE OTHER DIVERGENCE: a GHOST optimistic bubble (never matches; lives 120s) still on screen when
//    a tall reply lands. Here the DOM's last row is the ghost, so the reply is not seen as newest.
await open([...history, { role: "user", text: "asking", ts }]);
await p.evaluate(() => { optimistic.push({ text: "a ghost that never matched", at: Date.now(), state: "sent" }); feedSig = ""; paintFeed();
  const f = document.getElementById("dfeed"); f.scrollTop = f.scrollHeight; });
await p.waitForTimeout(300);
await snap([...history, { role: "user", text: "asking", ts }, TALL]);
m = await read();
console.log(`E  ghost + tall reply lands: tall top=${m.tall.top.toFixed(1)} h=${m.tall.h.toFixed(0)} → ${pinned(m) ? "TOP-PINNED ✓" : "NOT top-pinned ✗ (lands on its last line)"}  lastRow=.${m.lastCls}  opt=${m.nOpt}`);

// F. E's concrete cause: the feed's payload clamp (CONVO_CAP = 4000) truncates a long SENT message,
//    so its echo can never equal the text the optimistic bubble holds. The bubble is a ghost by
//    construction for the full 120s valve — and a reply landing in that window loses its top-pin.
const BIG = "A very long brief pasted into the composer. ".repeat(120);   // ~5.2k chars
console.log(`   (F fixture: ${BIG.length} chars sent, echo clamped to 4000)`);
await open([...history, { role: "user", text: "earlier", ts }]);
await p.evaluate(t => { optimistic.push({ text: t, at: Date.now(), state: "sent" }); feedSig = ""; paintFeed();
  const f = document.getElementById("dfeed"); f.scrollTop = f.scrollHeight; }, BIG);
await p.waitForTimeout(300);
await snap([...history, { role: "user", text: "earlier", ts }, { role: "user", text: BIG.slice(0, 4000), ts: ts + 1, uuid: "u-big", clipped: true }]);
let f1 = await read();
console.log(`F1 clamped echo arrives:     bubble survived it=${f1.nOpt === 1} ${f1.nOpt === 1 ? "→ a DUPLICATE on screen" : "→ retired, one row"}`);
await snap([...history, { role: "user", text: "earlier", ts }, { role: "user", text: BIG.slice(0, 4000), ts: ts + 1, uuid: "u-big", clipped: true }, TALL]);
let f2 = await read();
console.log(`F2 then the tall reply lands: tall top=${f2.tall.top.toFixed(1)} → ${Math.abs(f2.tall.top - f2.padTop) <= 2 ? "TOP-PINNED ✓" : "NOT top-pinned ✗"}  opt=${f2.nOpt}`);
await b.close();
