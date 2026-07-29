import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The LAST REPLY is not folded — and it stays that way until the NEXT reply, not until the next row.
//
// Four claims, and the last two are the ones that make the first useful rather than merely true:
//   1. the last assistant message renders at its full height with no fold bar, however long it is;
//   2. every OLDER long message still folds at 268px, and a user bubble folds even when it is newest
//      (the owner scoped this to the session's own replies — you know what you wrote). His own
//      message landing under a reply does NOT fold it, and neither does the activity of the turn that
//      follows — 2026-07-29: "it should stay expanded until your next final message, not right away
//      when I message or while you're working". The next REPLY is what folds it.
//   2c. a message OPENED BY HAND stays open across the 3s repaint — including one the transcript
//      wrote with no uuid, which had no key at all and so lost the tap on the next poll (the owner:
//      "when I expand a message manually, it re-collapses after 3 seconds");
//   3. a PAYLOAD-clipped newest reply (the server clamps at 4000 chars) gets its rest fetched, once,
//      without a tap — unfolding it takes away the only control that used to do that;
//   4. a reply taller than the screen lands on its FIRST line, not its last. Pinning the feed's
//      bottom is right for a message that fits and is precisely wrong for one that does not: you
//      would arrive at the end of the text and scroll up to start reading, which is worse than the
//      fold this replaced.
//
//   node newest.mjs [page] [outdir]
//
// Pre-change control: node newest.mjs /path/to/old.html — the SEVEN claim checks must fail there,
// while the fixture precondition and the two no-regression checks (an older message and a user
// bubble still fold) pass on both pages. That is how this was written.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "newest-"));

const CLIP_MAX = 268;   // .msg.clip's max-height — the height a FOLDED message must show
const ts = 1785200000000;
const long = n => `Paragraph ${n}. ` + "This message is comfortably past the 700-character fold threshold, so the client collapses it behind a tap-to-expand fold. ".repeat(6);
// Taller than the 812px viewport on its own, which is the state claim 4 is about.
const huge = "Paragraph 1. " + "A reply long enough to outrun the screen on its own, so the feed has to choose which of its ends to show you. ".repeat(40);
const FULL = huge + " …and this tail only exists in the server's full copy, never in the polled snapshot.";

const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
const feedOf = items => ({ sid: "abc", name: "cc-bridge", working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high", items });
const history = [
  { role: "user", text: "short one", ts },
  { role: "assistant", text: "Short reply.", ts },
  ...Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: long(i + 1), ts })),
];

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });

// One stub for the whole run: `feed` is swapped between states, and every /api/session/message read
// is recorded so "fetched once, without a tap" is measured rather than assumed.
await p.evaluate(({ session, full }) => {
  window.__feed = null;
  window.__fetches = [];
  window.api = async (path, body) => {
    if (path.includes("session/feed")) return window.__feed;
    if (path.includes("session/message")) { window.__fetches.push(body.uuid); return { text: full }; }
    if (path.includes("sessions")) return { sessions: [session] };
    return {};
  };
}, { session: SESSION, full: FULL });

// Drive the app the way the poll does — set the snapshot, then let renderDrill() fetch and paint.
const state = async items => {
  await p.evaluate(f => { window.__feed = f; }, feedOf(items));
  await p.evaluate(() => (window.drillSid ? renderDrill() : openDrill("abc", "cc-bridge")));
  await p.waitForTimeout(900);   // README rule 2: idle past the repaint before reading pixels
};
const read = () => p.evaluate(() => {
  const feed = document.getElementById("dfeed");
  const msgs = [...feed.querySelectorAll(".msg")];
  const row = el => ({
    cls: [...el.classList].filter(c => c !== "msg").join(" "),
    clip: el.classList.contains("clip"),
    h: el.getBoundingClientRect().height,
    more: !!el.querySelector(".more"),
    chars: el.textContent.length,
    // The sentence that exists ONLY in the server's full copy. Comparing lengths instead would pass
    // on the pre-change page, whose folded row renders the clamped text PLUS its "tap to expand"
    // bar and so measures longer than the snapshot it was given.
    tail: /only exists in the server's full copy/.test(el.textContent),
    // Where this row sits in the scroller's own frame, so "landed on its first line" is a number.
    top: el.getBoundingClientRect().top - feed.getBoundingClientRect().top,
    bottom: el.getBoundingClientRect().bottom - feed.getBoundingClientRect().bottom,
  });
  return {
    rows: msgs.map(row),
    padTop: parseFloat(getComputedStyle(feed).paddingTop) || 0,
    clientH: feed.clientHeight,
    fetches: window.__fetches.slice(),
  };
});

// ---- 1 + 2: the newest reply is open, everything older is folded ------------------------------
await state([...history, { role: "assistant", text: long(9), ts }]);
let m = await read();
await p.screenshot({ path: join(OUT, "newest-open.png") });
const last = m.rows[m.rows.length - 1];
const older = m.rows.slice(0, -1).filter(r => r.chars > 400);
check(older.length === 4, `the fixture carries ${older.length} older long messages behind the newest (4)`);
check(!last.clip && !last.more, `the newest reply is not folded (class "${last.cls}", fold bar ${last.more})`);
check(last.h > CLIP_MAX + 20, `…and renders at its own height, ${last.h.toFixed(1)}px, past the ${CLIP_MAX}px fold`);
check(older.every(r => r.clip && Math.abs(r.h - CLIP_MAX) <= 1), `every older long message still folds at ${CLIP_MAX}px (${older.map(r => r.h.toFixed(0)).join(", ")})`);

// ---- 2b: what lands under it, and which of those folds it -------------------------------------
// His own message: the answer he is reading must not fold because he replied to it.
await state([...history, { role: "assistant", text: long(9), ts }, { role: "user", text: long(10), ts }]);
m = await read();
await p.screenshot({ path: join(OUT, "buried.png") });
const [replyUnderUser, newestUser] = m.rows.slice(-2);
check(newestUser.clip && Math.abs(newestUser.h - CLIP_MAX) <= 1, `a long USER message folds even as the newest row (${newestUser.h.toFixed(1)}px)`);
check(!replyUnderUser.clip && replyUnderUser.h > CLIP_MAX + 20, `…and it does NOT fold the reply above it (${replyUnderUser.h.toFixed(1)}px)`);
// The turn that follows: narration and tool rows are the session WORKING, not a new answer.
await state([...history, { role: "assistant", text: long(9), ts }, { role: "user", text: "go on", ts },
  { role: "turn", ts, blocks: [{ t: "p", text: "reading the transcript back" }] }]);
m = await read();
const replyUnderWork = m.rows[m.rows.length - 3];
check(!replyUnderWork.clip && replyUnderWork.h > CLIP_MAX + 20, `nor does the activity of the turn that follows (${replyUnderWork.h.toFixed(1)}px)`);
// The NEXT reply: this is the one that folds it, and it takes the exemption for itself.
await state([...history, { role: "assistant", text: long(9), ts }, { role: "user", text: "go on", ts },
  { role: "assistant", text: long(8), ts }]);
m = await read();
await p.screenshot({ path: join(OUT, "next-reply.png") });
const [prevReply, , nextReply] = [m.rows[m.rows.length - 3], m.rows[m.rows.length - 2], m.rows[m.rows.length - 1]];
check(prevReply.clip && Math.abs(prevReply.h - CLIP_MAX) <= 1, `the NEXT reply is what folds it (${prevReply.h.toFixed(1)}px)`);
check(!nextReply.clip && nextReply.h > CLIP_MAX + 20, `…and that one is now the open one (${nextReply.h.toFixed(1)}px)`);

// ---- 2c: a hand-opened message survives the repaint, with a uuid and without one ---------------
// The tap sets a class; the poll rebuilds the feed's innerHTML from the payload. Anything the open
// state is keyed by has to exist for EVERY bubble, or the repaint quietly throws the tap away.
await state([...history, { role: "assistant", text: long(9), ts }]);
const opened = await p.evaluate(() => {
  const rows = [...document.querySelectorAll("#dfeed .msg.clip")];
  rows.forEach(r => onBubbleTap(r));
  return rows.map(r => ({ key: r.dataset.key || null, uuid: r.dataset.uuid || null, open: r.classList.contains("open") }));
});
check(opened.length >= 2 && opened.every(o => o.open), `the fixture opens ${opened.length} folded messages by hand`);
check(opened.every(o => o.key), `every bubble carries an open-state key (${opened.filter(o => !o.key).length} without one)`);
check(opened.some(o => !o.uuid), `…including ones the transcript gave no uuid (${opened.filter(o => !o.uuid).length} of ${opened.length})`);
// Force the repaint the poll would do: a new row changes the feed's signature.
await state([...history, { role: "assistant", text: long(9), ts }, { role: "user", text: "still reading", ts }]);
const stillOpen = await p.evaluate(() => [...document.querySelectorAll("#dfeed .msg.open")].length);
check(stillOpen >= opened.length, `all ${opened.length} stay open across a repaint (${stillOpen} open)`);

// ---- 3: payload-clipped newest — the rest arrives without a tap --------------------------------
await state([...history, { role: "assistant", text: huge, ts, uuid: "u-1", clipped: true }]);
m = await read();
const clipped = m.rows[m.rows.length - 1];
check(m.fetches.length === 1 && m.fetches[0] === "u-1", `the clamped rest is fetched once, untapped (${JSON.stringify(m.fetches)})`);
check(clipped.tail, `…and the full text is what renders — the server-only tail is on screen (${clipped.chars} chars of a ${huge.length}-char snapshot)`);

// ---- 4: a screen-taller reply lands on its FIRST line ------------------------------------------
await p.screenshot({ path: join(OUT, "tall-landing.png") });
check(clipped.h > m.clientH, `the fixture reply is ${clipped.h.toFixed(0)}px in a ${m.clientH}px scroller — the state this is about`);
// Its top sits at the ceiling scrim's floor: below the ramp, so the line is not the one dissolving,
// and NOT off the bottom of the screen, which is where a bottom-pin would have left it.
check(Math.abs(clipped.top - m.padTop) <= 2, `it lands on its first line, at the feed's own ${m.padTop.toFixed(0)}px content top (top ${clipped.top.toFixed(1)}px)`);
check(clipped.bottom > 0, `…rather than on its last (its bottom is ${clipped.bottom.toFixed(0)}px past the scroller's, i.e. still below the fold)`);

// FULLSCREEN, and be exact about what this is: it sets `html.fs` and an inset by hand, which the
// app's own handler would do alongside a DOM move of the pause button. That fake is worthless for
// the header's layout and adequate here — the number the landing reads is pure CSS, and it GROWS in
// this mode (the feed reserves the client's chrome band). What it proves is that the line lands on
// the reserved footprint in both layouts; where the pause button sits is headerup.mjs's job, driven
// through the real SDK.
await p.evaluate(() => {
  document.documentElement.classList.add("fs");
  document.documentElement.style.setProperty("--safe-top", "93px");
  // Back to the bottom before the repaint, or this measures a STALE scroll: the landing only runs
  // for a feed that was pinned, and after the first landing we are 2000px from the bottom. (Setting
  // the position under test is safe in this direction — the check is that the paint moves it OFF
  // the bottom. A page that ignores the newest reply leaves it exactly where this put it.)
  const feed = document.getElementById("dfeed");
  feed.scrollTop = feed.scrollHeight;
  feedSig = ""; paintFeed();
});
await p.waitForTimeout(400);
const fs = await read();
await p.screenshot({ path: join(OUT, "tall-landing-fs.png") });
const fsRow = fs.rows[fs.rows.length - 1];
check(fs.padTop > m.padTop, `in fullscreen the feed reserves more — ${fs.padTop.toFixed(0)}px against ${m.padTop.toFixed(0)}px`);
check(Math.abs(fsRow.top - fs.padTop) <= 2, `…and the reply still lands on it (top ${fsRow.top.toFixed(1)}px)`);
await p.evaluate(() => {
  document.documentElement.classList.remove("fs");
  document.documentElement.style.removeProperty("--safe-top");
});

await b.close();
console.log(`shots → ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
