import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The working row sits in a STATIC place: just above the composer, at the feed's left gutter, and it
// does not move when the transcript is scrolled or when the transcript is a different length.
//
// REDESIGNED for that spec. It previously proved "pinned to the bottom-left of the FEED", which was
// a real property this file established, so the replacement is spelled out rather than quietly
// rewritten:
//   · DROPPED "the row sits on the feed's bottom padding" — the row is no longer inside #dfeed, so
//     the feed's padding is not what it rests on. Replaced by: a fixed gap above the COMPOSER.
//   · DROPPED "long: the row still follows the last message, separated only by that message's own
//     margin" — that WAS the old behaviour and is now precisely the defect: following the last
//     message is what made it scroll away. Replaced by the scroll-invariance check.
//   · DROPPED "short: the row is genuinely detached from the last message" — it is detached in every
//     state by construction now, which the position checks already say.
//   · KEPT unchanged: both fixtures, "renders in both states", "same position in both states",
//     "short: the messages still start at the top", and all three bubble-geometry controls
//     (right-aligned user bubble, its 88% cap, left-aligned reply) — those guard the layout change
//     underneath this one, and none of them is about where the row lives.
//   · KEPT but RE-AIMED: the left-gutter check now measures the GLYPH rather than the row's border
//     box. Same claim, and it has to be: inside the feed the row's box began at the gutter, while as
//     a sibling strip its box spans the full width and the gutter is its own padding. Measuring the
//     box would have reported 0 and called a correct layout broken.
//   · ADDED: identical viewport position at the top, middle and bottom of a long transcript; the
//     feed's box ends above the row (nothing can be occluded); the last message clears the row when
//     scrolled to the very bottom.
//
// Everything here is measured from getBoundingClientRect, because "the CSS says above the composer"
// and "the pixels are above the composer" are different claims.
// Pre-fix control:  node workpin.mjs old.html  — the scroll-invariance checks must FAIL there.

const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
                "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "workpin-"));

const STATUS = { verb: "Incubating", elapsed: "2m 11s", tokens: "4.7k tokens" };
const base = { sid: "abc", name: "cc-bridge", working: true, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high", status: STATUS };
const ts = 1785200000000;
// (a) a chat with one or two short messages.
const SHORT = { ...base, items: [
  { role: "user", text: "pin the working line", ts },
  { role: "assistant", text: "On it.", ts },
] };
// (b) a transcript long enough to overflow the scroller several times over — the only state that can
// scroll at all, and therefore the only one in which "does not move when scrolled" means anything.
const LONG = { ...base, items: Array.from({ length: 24 }, (_, i) => i % 2
  ? { role: "assistant", text: `Reply ${i}. ` + "Long enough to wrap onto a second line so the feed really overflows. ".repeat(2), ts }
  : { role: "user", text: `Question ${i}, also long enough to wrap across more than one line in the bubble.`, ts }) };
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: true, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

async function measure(b, feed, vars, shot) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  if (vars) await p.evaluate(v => { for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty("--tg-theme-" + k, val); }, vars);
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed
      : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed, session: SESSION });
  await p.waitForTimeout(900);   // README rule 2: idle past the first repaint and the glyph timer
  if (shot) await p.screenshot({ path: shot });
  const read = () => p.evaluate(() => {
    const r = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
    const feedEl = document.getElementById("dfeed");
    const work = document.getElementById("dwork");
    const msgs = [...feedEl.querySelectorAll(".msg")];
    const user = msgs.find(m => m.classList.contains("user"));
    const asst = msgs.find(m => m.classList.contains("assistant"));
    return {
      feed: r(feedEl), work: work ? r(work) : null, composer: r(document.querySelector(".composer")),
      // WHERE THE ROW READS, not where its box starts. The row used to sit inside the feed's padded
      // content box, so its border box began at the gutter; as a sibling strip its box spans the full
      // width and the gutter is its own padding. The glyph is the first ink either way, so measuring
      // it is what makes "the same horizontal spot" the same claim before and after.
      glyph: work && work.querySelector(".g") ? r(work.querySelector(".g")) : null,
      first: msgs.length ? r(msgs[0]) : null,
      last: msgs.length ? r(msgs[msgs.length - 1]) : null,
      user: user ? r(user) : null, asst: asst ? r(asst) : null,
      // A flex item with an auto margin and an `auto` cross size is sized to its CONTENT. That is how
      // a column layout silently shrink-wrapped every short user bubble once, so the width is
      // measured against the cap the bubble is supposed to be filling rather than left to the eye.
      // getComputedStyle hands back the SPECIFIED percentage for max-width, not a used px value, so
      // the cap is resolved here against the feed's own content width.
      userMax: (() => {
        if (!user) return 0;
        const cs = getComputedStyle(feedEl);
        const content = feedEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const mw = getComputedStyle(user).maxWidth;
        return mw.endsWith("%") ? content * parseFloat(mw) / 100 : parseFloat(mw);
      })(),
      overflow: feedEl.scrollHeight - feedEl.clientHeight,
      scrollTop: feedEl.scrollTop,
      padBottom: parseFloat(getComputedStyle(feedEl).paddingBottom),
      padLeft: parseFloat(getComputedStyle(feedEl).paddingLeft),
      padTop: parseFloat(getComputedStyle(feedEl).paddingTop),
    };
  });
  const at = async where => {
    await p.evaluate(w => {
      const f = document.getElementById("dfeed");
      f.scrollTop = w === "top" ? 0 : w === "mid" ? Math.round((f.scrollHeight - f.clientHeight) / 2) : f.scrollHeight;
    }, where);
    await p.waitForTimeout(250);   // let the scroll settle before reading pixels (README rule 2)
    // The MIDDLE of a long transcript is the state that tells the two designs apart on sight: the row
    // is on screen above the composer here, and was somewhere off in the scrollback before. Shot for
    // that reason — the bottom-scrolled state looks identical either way and proves nothing visually.
    if (shot && where === "mid") await p.screenshot({ path: shot.replace(/\.png$/, "-mid.png") });
    return read();
  };
  const m = await read();
  m.scroll = { top: await at("top"), mid: await at("mid"), bottom: await at("bottom") };
  if (shot) await p.screenshot({ path: shot.replace(/\.png$/, "-scrolled.png") });
  await p.close();
  return m;
}

const b = await chromium.launch();
for (const [theme, vars] of [["dark", null], ["light", LIGHT]]) {
  const s = await measure(b, SHORT, vars, join(OUT, `workpin-short-${theme}.png`));
  const l = await measure(b, LONG, vars, join(OUT, `workpin-long-${theme}.png`));
  console.log(`\n--- ${theme} ---`);
  console.log("  short:", JSON.stringify(s.work), "overflow", Math.round(s.overflow));
  console.log("  long: ", JSON.stringify(l.work), "overflow", Math.round(l.overflow));
  console.log("  long scrolled:", ["top", "mid", "bottom"].map(k => `${k}@${Math.round(l.scroll[k].scrollTop)} → bottom ${l.scroll[k].work ? l.scroll[k].work.bottom.toFixed(1) : "-"}`).join(" · "));

  // The fixtures have to actually BE the two states, or every check below is measuring one thing twice.
  check(s.overflow <= 0, `FIXTURE: the short transcript does not overflow (${Math.round(s.overflow)}px)`);
  check(l.overflow > 200, `FIXTURE: the long transcript overflows several screens (${Math.round(l.overflow)}px)`);
  check(l.scroll.top.scrollTop === 0 && l.scroll.bottom.scrollTop > 200,
    `FIXTURE: the long transcript really scrolled (${Math.round(l.scroll.top.scrollTop)} → ${Math.round(l.scroll.bottom.scrollTop)})`);

  check(!!s.work && !!l.work, "the row renders in both states");
  // THE ASK, as two numbers: same place at every scroll position, same place in both states.
  const at = l.scroll;
  check(!!at.top.work && !!at.mid.work && !!at.bottom.work
    && near(at.top.work.bottom, at.mid.work.bottom) && near(at.top.work.bottom, at.bottom.work.bottom)
    && near(at.top.glyph.left, at.bottom.glyph.left),
    `the row does not move when the transcript is scrolled  (top ${at.top.work ? at.top.work.bottom.toFixed(1) : "-"} · mid ${at.mid.work ? at.mid.work.bottom.toFixed(1) : "-"} · bottom ${at.bottom.work ? at.bottom.work.bottom.toFixed(1) : "-"})`);
  check(!!s.work && !!l.work && near(s.work.bottom, l.work.bottom) && near(s.glyph.left, l.glyph.left),
    `same position in both states  (short bottom ${s.work ? s.work.bottom.toFixed(1) : "-"} left ${s.work ? s.work.left.toFixed(1) : "-"} · long bottom ${l.work ? l.work.bottom.toFixed(1) : "-"} left ${l.work ? l.work.left.toFixed(1) : "-"})`);

  for (const [name, m] of [["short", s], ["long", l]]) {
    // Where "static" actually is: a small gap above the composer, outside the scroller.
    check(!!m.work && m.work.bottom <= m.composer.top + 0.5 && m.composer.top - m.work.bottom < 20,
      `${name}: the row sits just above the composer  (${m.work ? (m.composer.top - m.work.bottom).toFixed(1) : "-"}px gap)`);
    // No message INK under the row at rest. Re-aimed twice as the layout moved, and the reason is
    // worth keeping: first from the feed's box to its content edge (the box became the whole screen
    // when the dock started floating), and now from the content edge to the last message's own box.
    // The content edge overhangs the row by design — the owner's resting position leaves ~6px between
    // the newest message and the dock's first ink, and the 16px that message carries as its bottom
    // MARGIN is what fills the rest. A margin cannot be occluded; only ink can.
    check(!!m.work && !!m.last && m.last.bottom <= m.work.top + 0.5,
      `${name}: no message ink under the row at rest  (last message bottom ${m.last ? m.last.bottom.toFixed(1) : "-"} vs row top ${m.work ? m.work.top.toFixed(1) : "-"})`);
    // TWO horizontal claims since the row became a pill, and it takes both — one number could not
    // tell a correctly-aligned pill from a misaligned one. The pill's BOX keeps the feed's gutter
    // (12), and its first ink lands on the MESSAGE column (the gutter plus a bubble's own 11px
    // padding), which is where the text of every message beside it sits. Before the pill the ink was
    // at the gutter itself — aligned with the bubbles' edges and 11px left of their text.
    check(!!m.work && near(m.work.left - m.feed.left, m.padLeft),
      `${name}: the row's pill keeps the feed's left gutter  (${m.work ? (m.work.left - m.feed.left).toFixed(1) : "-"} vs ${m.padLeft})`);
    // Against the ASSISTANT row, not a user bubble: a user bubble is right-aligned, so its left edge
    // is wherever its 88% cap puts it and has nothing to do with the column.
    check(!!m.glyph && !!m.asst && near(m.glyph.left, m.asst.left + 11, 1),
      `${name}: …and its text lands on the message column  (${m.glyph ? m.glyph.left.toFixed(1) : "-"} vs ${m.asst ? (m.asst.left + 11).toFixed(1) : "-"})`);
  }
  // Scrolled to the very bottom is where an overlay treatment would collide with the newest message.
  check(!!at.bottom.last && !!at.bottom.work && at.bottom.last.bottom <= at.bottom.work.top + 0.5,
    `scrolled to the bottom, the last message still clears the row  (${at.bottom.last && at.bottom.work ? (at.bottom.work.top - at.bottom.last.bottom).toFixed(1) : "-"}px)`);
  // The guard against "fixing" this by bottom-aligning the whole feed: a short transcript's messages
  // still START at the top. Only the row moved.
  // Measured against the feed's OWN top padding rather than the 12 it used to be: the chat header
  // now floats over the scroller, so that padding is the header's footprint plus the gutter (64) and
  // a literal here would fail on a correct page. The guard is unchanged — bottom-aligning the feed
  // puts the first message hundreds of pixels down, not one padding down.
  check(!!s.first && near(s.first.top - s.feed.top, s.padTop, 1),
    `short: the messages still start at the top  (first message ${s.first ? (s.first.top - s.feed.top).toFixed(1) : "-"}px below the feed top)`);
  // The layout underneath the row changed with it, so the bubble geometry is re-measured rather than
  // assumed: the user's bubble stays right, at its cap, and the session's reply stays left.
  check(!!s.user && near(s.user.right, s.feed.right - s.padLeft, 1),
    `short: the user bubble is still right-aligned  (${s.user ? (s.feed.right - s.user.right).toFixed(1) : "-"}px from the edge)`);
  check(!!s.user && near(s.user.right - s.user.left, s.userMax, 1),
    `short: a SHORT user bubble still fills its 88% cap rather than shrink-wrapping  (${s.user ? (s.user.right - s.user.left).toFixed(1) : "-"} vs ${s.userMax.toFixed(1)})`);
  check(!!s.asst && near(s.asst.left, s.feed.left + s.padLeft, 1),
    `short: the session's reply is still left-aligned  (${s.asst ? (s.asst.left - s.feed.left).toFixed(1) : "-"}px from the edge)`);
}
await b.close();
console.log(`\n${bad ? `${bad} FAILED` : "all checks passed"} — screenshots in ${OUT}`);
process.exit(bad ? 1 : 0);
