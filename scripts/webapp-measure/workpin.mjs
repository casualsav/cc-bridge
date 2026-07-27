import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The working row is pinned to the bottom left of the feed AT EVERY TRANSCRIPT LENGTH.
//
// It used to be an ordinary last-child of #dfeed, so with two messages on screen it rendered just
// under the lowest bubble, halfway up the page, and only reached the bottom once the transcript was
// long enough to fill the scroller. Same element, two different places, depending on nothing the
// reader cares about.
//
// Everything here is measured from getBoundingClientRect, because "the CSS says bottom" and "the
// pixels are at the bottom" are different claims. The two states are rendered in the SAME browser
// against the SAME page, so the comparison is not against a remembered number.
// Pre-fix control:  node workpin.mjs old.html  — the SHORT-state checks must fail there.

const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
                "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "workpin-"));

const STATUS = { verb: "Incubating", elapsed: "2m 11s", tokens: "4.7k tokens" };
const base = { sid: "abc", name: "cc-bridge", working: true, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high", status: STATUS };
const ts = 1785200000000;
// (a) a chat with one or two short messages — the state that was broken.
const SHORT = { ...base, items: [
  { role: "user", text: "pin the working line", ts },
  { role: "assistant", text: "On it.", ts },
] };
// (b) a transcript long enough to overflow the scroller several times over — the state that was
// already right and must stay byte-identical.
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
  const m = await p.evaluate(() => {
    const r = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
    const feedEl = document.getElementById("dfeed");
    const work = document.getElementById("dwork");
    const msgs = [...feedEl.querySelectorAll(".msg")];
    const user = msgs.find(m => m.classList.contains("user"));
    const asst = msgs.find(m => m.classList.contains("assistant"));
    return {
      feed: r(feedEl), work: work ? r(work) : null,
      first: msgs.length ? r(msgs[0]) : null,
      last: msgs.length ? r(msgs[msgs.length - 1]) : null,
      user: user ? r(user) : null, asst: asst ? r(asst) : null,
      // A flex item with an auto margin and an `auto` cross size is sized to its CONTENT. That is
      // how a column layout silently shrink-wraps every short user bubble, so the width is measured
      // against the cap the bubble is supposed to be filling rather than left to the eye.
      // getComputedStyle hands back the SPECIFIED percentage for max-width, not a used px value, so
      // the cap is resolved here against the feed's own content width.
      userMax: (() => {
        if (!user) return 0;
        const cs = getComputedStyle(feedEl);
        const content = feedEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const mw = getComputedStyle(user).maxWidth;
        return mw.endsWith("%") ? content * parseFloat(mw) / 100 : parseFloat(mw);
      })(),
      // The last message's OWN bottom margin — the long-state gap below is measured against this
      // rather than against zero, because that margin is the rhythm every reply already carries.
      lastGap: msgs.length ? parseFloat(getComputedStyle(msgs[msgs.length - 1]).marginBottom) : 0,
      overflow: feedEl.scrollHeight - feedEl.clientHeight,
      padBottom: parseFloat(getComputedStyle(feedEl).paddingBottom),
      padLeft: parseFloat(getComputedStyle(feedEl).paddingLeft),
    };
  });
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

  // The fixtures have to actually BE the two states, or every check below is measuring one thing twice.
  check(s.overflow <= 0, `FIXTURE: the short transcript does not overflow (${Math.round(s.overflow)}px)`);
  check(l.overflow > 200, `FIXTURE: the long transcript overflows several screens (${Math.round(l.overflow)}px)`);

  check(!!s.work && !!l.work, "the row renders in both states");
  // THE ASK, stated as one number: same place, both states.
  check(!!s.work && !!l.work && near(s.work.bottom, l.work.bottom) && near(s.work.left, l.work.left),
    `same position in both states  (short bottom ${s.work?.bottom.toFixed(1)} left ${s.work?.left.toFixed(1)} · long bottom ${l.work?.bottom.toFixed(1)} left ${l.work?.left.toFixed(1)})`);
  // …and that place is the bottom left of the feed's own content box, not merely "equal to itself".
  for (const [name, m] of [["short", s], ["long", l]]) {
    check(!!m.work && near(m.feed.bottom - m.work.bottom, m.padBottom),
      `${name}: the row sits on the feed's bottom padding  (${m.work ? (m.feed.bottom - m.work.bottom).toFixed(1) : "-"} vs ${m.padBottom})`);
    check(!!m.work && near(m.work.left - m.feed.left, m.padLeft),
      `${name}: the row sits on the feed's left padding  (${m.work ? (m.work.left - m.feed.left).toFixed(1) : "-"} vs ${m.padLeft})`);
  }
  // The long state was already right, and the fix must not have bought the short case with it: in a
  // full transcript the row still follows the last message immediately, with nothing pushed between.
  check(!!l.work && !!l.last && near(l.work.top - l.last.bottom, l.lastGap, 1),
    `long: the row still follows the last message, separated only by that message's own margin  (${l.work && l.last ? (l.work.top - l.last.bottom).toFixed(1) : "-"} vs ${l.lastGap})`);
  // The counterpart, and the guard against "fixing" this by bottom-aligning the whole feed: a short
  // transcript's messages still START at the top. Only the row moved.
  check(!!s.first && near(s.first.top - s.feed.top, 12, 1),
    `short: the messages still start at the top  (first message ${s.first ? (s.first.top - s.feed.top).toFixed(1) : "-"}px below the feed top)`);
  check(!!s.work && !!s.last && s.work.top - s.last.bottom > 200,
    `short: the row is genuinely detached from the last message  (${s.work && s.last ? (s.work.top - s.last.bottom).toFixed(0) : "-"}px of free space)`);
  // Column layout is what pins the row, so the two bubble alignments are re-measured rather than
  // assumed: the user's bubble stays right, the session's reply stays full-width left.
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
