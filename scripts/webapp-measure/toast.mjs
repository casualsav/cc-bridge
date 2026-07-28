import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// The toast, in the ONE view where it was invisible. #err is declared before #drill in the source
// and #drill is `position: fixed; inset: 0` with an opaque --bg at z-index 5, so a toast left in the
// page flow is painted over by the transcript. Two different slash refusals reached the owner as
// nothing happening at all, and the same silence covered upload failures, the mic's errors and every
// showOk. The fix re-hosts the element into #drill while the chat is open (see toast()/rehostToast).
//
//   node toast.mjs [page]
//
// HIT-TESTED, not rect-compared, and that is the whole reason this file exists: the covered box
// reported a perfectly good 375x57 rect at y=58 in both states. Only "what would a tap at its own
// centre hit first" tells them apart.
//
// Control: node toast.mjs /abs/path/to/pre-change.html — the chat-view checks must FAIL there
// (topmost reads `msg user`), or the probe is measuring nothing.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const ts = 1785200000000;
const S = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
const FEED = { ...S, items: [{ role: "user", text: "hi", ts }, { role: "assistant", text: "hello", ts }] };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(({ feed, session }) => {
  window.api = async path => path.includes("session/feed") ? feed : path.includes("sessions") ? { sessions: [session] } : {};
}, { feed: FEED, session: S });
await p.waitForTimeout(400);

const probe = async ok => {
  const d = await p.evaluate(isOk => {
    (isOk ? showOk : showErr)("/new is a bridge command, not a session command.");
    const e = document.getElementById("err");
    const r = e.getBoundingClientRect();
    const stack = [...document.elementsFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))];
    const dock = document.getElementById("ddock");
    return {
      shown: getComputedStyle(e).display !== "none",
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      topmost: stack.length ? (stack[0].id || stack[0].className || stack[0].tagName) : null,
      dockTop: dock && dock.offsetParent ? +dock.getBoundingClientRect().top.toFixed(1) : null,
      parent: e.parentNode.id || e.parentNode.tagName,
      pos: getComputedStyle(e).position,
    };
  }, ok);
  await p.evaluate(() => document.getElementById("err").classList.remove("show", "ok"));
  return d;
};

// 1. The tabs view is the surface that already worked, and it has to stay byte-identical: in flow,
//    full width, directly under the tab bar. A fix that floats it everywhere would pass every
//    chat-view check below while quietly covering the nav on the home screen.
const tabs = await probe(false);
console.log("  tabs :", JSON.stringify(tabs));
check(tabs.topmost === "err", `tabs view: the toast is what a tap would hit (${tabs.topmost})`);
check(tabs.parent === "BODY" && tabs.rect.x === 0 && tabs.rect.w === 375,
  `tabs view: still the in-flow full-width banner (${tabs.parent}, x ${tabs.rect.x}, w ${tabs.rect.w})`);

await p.evaluate(() => openDrill("abc", "cc-bridge"));
await p.waitForTimeout(900);

// 2. The chat view — the defect. Both severities, because showOk went the same way as showErr and a
//    fix applied to one of them would leave the other silent.
for (const [label, ok] of [["error", false], ["confirmation", true]]) {
  const d = await probe(ok);
  console.log(`  chat ${label}:`, JSON.stringify(d));
  check(d.topmost === "err", `chat view: the ${label} toast is what a tap would hit (${d.topmost})`);
  // It stays in the BODY and floats. Hosting it inside #drill also passes the hit test above and is
  // still wrong: #drill is a stacking context at z 5, so a child of it can never clear a root-level
  // sheet — which is what the sheet cases below catch and this check states up front.
  check(d.parent === "BODY" && d.pos === "fixed",
    `chat view: the ${label} toast floats from the body, not from inside #drill (${d.parent}, ${d.pos})`);
  // Anchored to the dock, because everything that raises one in here is a composer action. Above it
  // and clear of it — the composer is what the user is about to correct.
  check(d.dockTop != null && d.rect.y + d.rect.h <= d.dockTop + 0.5,
    `chat view: the ${label} toast sits above the dock (bottom ${(d.rect.y + d.rect.h).toFixed(1)} vs dock ${d.dockTop})`);
}

// 2b. THE SHEETS. Carved out of the parked class list because an error nobody can see is the same
//     harm whichever surface is on top of it — and the first fix, which re-hosted the toast into
//     #drill, cleared the transcript and left these behind. Two are live: the dial raises a toast
//     from applyDial() while its own backdrop is still transitioning out (closeDial then sessionAct,
//     180ms), and the spawn sheet's failures used to land in the body-flow banner under its z 9.
//     Driven through the app's OWN openers, never by adding .show by hand — the sheets set .show and
//     .up on separate frames, and a hand-set class tests a state the app never actually paints.
for (const [id, open] of [
  ["dial", () => document.getElementById("ddial").click()],
  ["addctx", () => document.getElementById("datt").click()],
]) {
  await p.evaluate(fn => (new Function(`return (${fn})`))()(), open.toString());
  await p.waitForTimeout(300);
  const d = await probe(false);
  console.log(`  sheet ${id}:`, JSON.stringify(d));
  check(d.topmost === "err", `#${id} open over the chat: the toast still wins the tap (${d.topmost})`);
  await p.evaluate(i => { const e = document.getElementById(i); e.classList.remove("show", "up"); }, id);
  await p.waitForTimeout(250);
}

// 3. And back: leaving the chat returns the element to the page flow, or the home screen inherits a
//    floating box anchored to a dock that is no longer on screen.
await p.evaluate(() => closeDrill && closeDrill());
await p.waitForTimeout(400);
const back = await probe(false);
console.log("  back :", JSON.stringify(back));
check(back.parent === "BODY" && back.topmost === "err",
  `back on the tabs view: the toast is in flow again and visible (${back.parent}, ${back.topmost})`);
check(back.pos === "static", `back on the tabs view: and back in the FLOW, not floating over the nav (${back.pos})`);

// 4. The second live instance, and the one with no chat view involved at all: the spawn sheet sits
//    over the SESSIONS tab at z 9, where the toast was the body-flow banner. Its failure path is
//    real — spgo's writeOp surfaces the daemon's reason. No dock on this screen, so the toast must
//    float WITHOUT the dock offset or it hangs 60px up for a surface that isn't there.
await p.evaluate(() => openSpawnSheet());
await p.waitForTimeout(300);
const spawn = await probe(false);
console.log("  spawn:", JSON.stringify(spawn));
check(spawn.topmost === "err", `#spawn open over the tabs: the toast wins the tap (${spawn.topmost})`);
check(spawn.pos === "fixed" && spawn.rect.y + spawn.rect.h <= 812 - 8 + 0.5,
  `#spawn open: floating off the viewport's own floor, no dock offset (bottom ${(spawn.rect.y + spawn.rect.h).toFixed(1)} of 812)`);

await b.close();
console.log(`\n${bad ? `${bad} FAILED` : "all checks passed"}`);
process.exit(bad ? 1 : 0);
