import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// A collapsed long message keeps its height. Both kinds: the user-side bubble and the unbubbled
// prose reply.
//
// `.msg.clip` asks for `max-height: 268px; overflow: hidden`. In a flex COLUMN — which #dfeed became
// when the working row was pinned — `overflow: hidden` sets a flex item's automatic minimum size to
// ZERO, and flex items shrink by default. So once the transcript overflows the scroller, the flex
// algorithm crushes exactly the clipped messages (the ones that can shrink) to a sliver, while the
// short ones (overflow visible → min-height:auto → content) keep their size. The absolutely
// positioned fold bar then paints over what is left of the text. That is the whole defect, and it is
// why the two things this measures are HEIGHT and OVERLAP rather than anything about the fold.
//
//   node squash.mjs [page] [outdir]
//
// Pre-fix control: node squash.mjs /path/to/old.html — every height check must FAIL there, which is
// how this was written (the shipped page was the failing control).

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "squash-"));

const CLIP_MAX = 268;   // .msg.clip's own max-height — the height a collapsed card must reach
const ts = 1785200000000;
const long = n => `Paragraph ${n}. ` + "This message is comfortably past the 700-character fold threshold, so the client collapses it behind a tap-to-expand fold and gives it the clip class. ".repeat(6);
// A transcript that OVERFLOWS the scroller — the squash only appears once the flex column has more
// content than height, because that is when the shrink algorithm runs at all. A fixture that fits on
// screen renders perfectly on a broken page.
const FEED = {
  sid: "abc", name: "cc-bridge", working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high",
  items: [
    { role: "user", text: "short one", ts },
    { role: "assistant", text: "Short reply.", ts },
    // Eight long ones, because the crush is shared out across every shrinkable item: with two the
    // cards land at ~150px and the fold still clears the text, which reads as "a bit short" rather
    // than as the defect. The owner's screen had this many, and at this count the bar lands ON the
    // text exactly as it does there.
    ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: long(i + 1), ts })),
    // A short row LAST, and it is load-bearing: the newest reply is deliberately never folded
    // (newest.mjs owns that claim), so ending on the eighth long assistant message would leave this
    // fixture with seven clipped cards and fail the count for a reason that has nothing to do with
    // the squash. Anything that buries the last long one does; a short line is the cheapest.
    { role: "user", text: "ok", ts },
  ],
};
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(({ feed, session }) => {
  window.api = async path => path.includes("session/feed") ? feed
    : path.includes("sessions") ? { sessions: [session] } : {};
  openDrill(session.sid, session.name);
}, { feed: FEED, session: SESSION });
await p.waitForTimeout(900);   // README rule 2: idle past the first repaint before reading pixels
await p.screenshot({ path: join(OUT, "feed.png") });

const m = await p.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height } };
  const feed = document.getElementById("dfeed");
  const clips = [...feed.querySelectorAll(".msg.clip")];
  const read = el => {
    const more = el.querySelector(".more");
    return {
      user: el.classList.contains("user"), h: box(el).h,
      // How much of the card is text ABOVE the fold bar. The squash's visible signature is this
      // going to zero or negative: the bar is position:absolute at the bottom, so it keeps its own
      // height while the card collapses under it and the two overlap.
      textAbove: more ? box(more).top - box(el).top : null,
      moreH: more ? box(more).h : null,
      scrollH: el.scrollHeight,
    };
  };
  return {
    clips: clips.map(read),
    shortH: box(feed.querySelector(".msg:not(.clip)")).h,
    // NOT `feed.scrollHeight > clientHeight`: a squashed page does not overflow — the items were
    // crushed until they fit, which is the defect wearing the precondition's clothes. The honest
    // precondition is what the content WANTS: every message at its own collapsed height.
    wants: [...feed.querySelectorAll(".msg")].reduce((n, el) => n + Math.min(el.scrollHeight, 268), 0),
    clientH: feed.clientHeight,
    scrolls: feed.scrollHeight > feed.clientHeight,
    display: getComputedStyle(feed).display, dir: getComputedStyle(feed).flexDirection,
    // Can this feed shrink its children AT ALL? That — not any particular layout — is the condition
    // the squash needs. A block container has no shrink algorithm; a flex one does unless every
    // child opts out. Written as the invariant rather than as "the feed is a flex column", which is
    // what this check said while the column existed and would have had to be silently rewritten the
    // day the column left.
    shrinkable: /flex/.test(getComputedStyle(feed).display)
      && [...feed.children].some(el => getComputedStyle(el).flexShrink !== "0"),
  };
});

console.log(JSON.stringify(m, null, 1));
// The fixture has to actually reproduce the conditions, or every check below passes vacuously.
check(!m.shrinkable, `the feed cannot shrink its children (${m.display}${/flex/.test(m.display) ? "/" + m.dir : ""}) — the condition the squash needs`);
check(m.wants > m.clientH * 2, `the fixture wants ${Math.round(m.wants)}px in a ${m.clientH}px scroller — the state in which flex shrinking happens at all`);
check(m.clips.length === 8, `eight long messages collapsed behind a fold (${m.clips.length})`);
// A healthy feed SCROLLS. A squashed one doesn't have to — it shrank until it fitted — so this is
// the other half of the same claim and it fails on the pre-fix page for the right reason.
check(m.scrolls, "the feed scrolls rather than absorbing the content by crushing it");
const users = m.clips.filter(c => c.user), prose = m.clips.filter(c => !c.user);
for (const [kind, set] of [["user bubble", users], ["prose reply", prose]]) {
  for (const [i, c] of set.entries()) {
    // The card must reach its own max-height. Anything less is the flex algorithm, not the CSS.
    check(Math.abs(c.h - CLIP_MAX) <= 1, `collapsed ${kind} ${i + 1} is ${CLIP_MAX}px tall, not squashed (${c.h.toFixed(1)})`);
    // …and there must be readable text above the fold bar rather than the bar sitting on top of it.
    check(c.textAbove > CLIP_MAX / 2, `collapsed ${kind} ${i + 1} shows text above its fold (${c.textAbove?.toFixed(1)}px of ${c.h.toFixed(1)})`);
  }
}
// The control: a message that was never clipped has overflow:visible, so it was never shrinkable and
// must be untouched by the fix as it was by the bug.
check(m.shortH > 20 && m.shortH < 80, `a short message keeps its natural height (${m.shortH.toFixed(1)})`);

await b.close();
console.log(`shot → ${join(OUT, "feed.png")}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
