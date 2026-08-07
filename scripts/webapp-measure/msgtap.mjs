import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Taps on a feed bubble: the body COPIES, the fold bar EXPANDS, and burial collapses.
//
//   node msgtap.mjs [page]
//
// The interaction (owner, 2026-08-07): a collapsed message expands ONLY from its "tap to expand"
// bar; a tap anywhere else on any bubble raises a copy pill that copies the WHOLE message; there is
// no manual collapse left, and an opened message collapses itself once it is buried.
//
// Pre-change control: `node msgtap.mjs /path/to/old/index.html`. §1–§6 must FAIL there — the old
// page toggles the fold from anywhere on a long bubble and has no copy pill, no burial and no tap
// at all on a short one. §7 is the GUARD half and passes on BOTH pages on purpose: links, buttons
// and a live text selection keep their own taps, and turn rows and command cards were never in
// scope. A guard that only started holding after the change would mean the change caused what it
// guards against.
//
// The copy claim is measured at the CLIPBOARD API — writeText is spied on, argument recorded, then
// called through. What that proves is the text this page hands the platform. Whether Telegram's
// Android WebView lets the write land is a device question this harness cannot answer.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const ts = 1785200000000;
// Past LONG_MSG (700) so the bubble folds; well past it, so the fold is unambiguous.
const LONG = "The deploy came back on the new version. ".repeat(40);
const SHORT = "ack";
// A payload-CLIPPED row: what the poll carries is the server's clamp, and the whole message is only
// ever reachable through /api/session/message. Copying the clamp is the failure §4 exists to catch.
const CLIPPED_SEEN = "First half of a very long report. ".repeat(30);
const CLIPPED_FULL = CLIPPED_SEEN + "AND THE TAIL THE POLL NEVER CARRIED.";

const base = [
  { role: "user", uuid: "u1", text: SHORT, ts },
  { role: "user", uuid: "u2", text: LONG, ts },
  { role: "assistant", uuid: "a1", text: LONG, ts },
  { role: "assistant", uuid: "a2", text: CLIPPED_SEEN, clipped: true, ts },
  { role: "turn", uuid: "t1", ts, blocks: [
    { t: "p", text: "Narration inside a turn row." },
    { t: "chip", kind: "run", label: "Ran 2 commands", calls: [{ verb: "Ran", target: "bun test" }] },
  ] },
  { role: "assistant", uuid: "a3", text: "Link check: [the docs](https://example.com/docs) inline.", ts },
  // Image-only: the renderer strips the CLI's "(photo)" placeholder, so this row has NO text of its
  // own — the whole reason §8 refuses it a pill. A captioned photo is a different row and keeps one.
  { role: "user", uuid: "i1", img: "/tmp/shot.png", text: "(photo)", ts },
  { role: "user", uuid: "i2", img: "/tmp/shot.png", text: "the crop you asked for", ts },
  // Last reply — never folded (bubble()'s `newest`), so it is the EXPANDED case §3 needs.
  { role: "assistant", uuid: "a4", text: LONG, ts },
];

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
const open = async (items = base) => {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.evaluate(([its, full]) => {
    window.__copied = [];
    const real = navigator.clipboard && navigator.clipboard.writeText;
    // Spy, not stub: the argument is recorded and the platform call still runs, so a page that
    // stopped calling the API at all cannot pass by writing to the spy.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: t => { window.__copied.push(t); return real ? real.call(navigator.clipboard, t).catch(() => {}) : Promise.resolve(); } } });
    window.__feed = { sid: "abc", name: "cc-bridge", working: false, cwd: "~/p/cc-bridge", items: its };
    window.api = async (u, body) => {
      if (u.includes("/api/session/message")) return { text: body && body.uuid === "a2" ? full : "" };
      if (u.includes("feed")) return window.__feed;
      return { sessions: [] };
    };
    openDrill(window.__feed.sid, window.__feed.name);
  }, [items, CLIPPED_FULL]);
  await p.waitForTimeout(900);
  return p;
};

// Tap a bubble's TEXT, deliberately away from the fold bar at its floor — and centred in the
// viewport first, because the header and the dock float OVER this scroller and a tap that lands on
// one of them reads exactly like a tap the page ignored.
const tapBody = async (p, uuid) => {
  await p.evaluate(u => document.querySelector(`.msg[data-uuid="${u}"]`).scrollIntoView({ block: "center" }), uuid);
  await p.waitForTimeout(150);
  const box = await p.locator(`.msg[data-uuid="${uuid}"]`).boundingBox();
  // Above the fold bar on a tall bubble; a SHORT bubble has no bar and its own centre is 8px down.
  await p.mouse.click(box.x + box.width / 2, box.y + Math.max(8, Math.min(box.height / 2, box.height - 40)));
  await p.waitForTimeout(250);
};
const tapMore = async (p, uuid) => {
  await p.locator(`.msg[data-uuid="${uuid}"] .more`).click();
  await p.waitForTimeout(400);
};
// Tap the pill if it is there. A control page has none, and every §4 claim below then fails on its
// own terms rather than aborting the run — a control that stops early measures nothing after it.
const tapPill = async (p, uuid) => {
  const l = p.locator(`.msg[data-uuid="${uuid}"] .copyb`);
  if (await l.count() === 0) return false;
  await l.click(); await p.waitForTimeout(500); return true;
};
const state = (p, uuid) => p.evaluate(u => {
  const el = document.querySelector(`.msg[data-uuid="${u}"]`);
  return el && { open: el.classList.contains("open"), clip: el.classList.contains("clip"),
    pill: !!el.querySelector(".copyb"), h: el.getBoundingClientRect().height };
}, uuid);

// ---- 1. A collapsed bubble's body copies and does NOT expand -----------------------------------
{
  const p = await open();
  const before = await state(p, "a1");
  check(!!before && before.clip && !before.open, "a1 starts collapsed (the fixture folds)");
  await tapBody(p, "a1");
  const after = await state(p, "a1");
  check(!!after && after.pill, "§1 tap on a collapsed body raises the copy pill");
  check(!!after && !after.open, "§1 tap on a collapsed body does NOT expand it");
  check(!!after && Math.abs(after.h - before.h) < 2, "§1 …and the bubble's height did not move");
  // The pill is the page's own chip vocabulary, not a new one.
  const cls = await p.evaluate(() => { const e = document.querySelector(".copyb"); return e ? e.className : ""; });
  check(/\bchip\b/.test(cls), "§1 the pill carries the shared .chip class");
  await p.close();
}

// ---- 2. Only the fold bar expands --------------------------------------------------------------
{
  const p = await open();
  await tapMore(p, "a1");
  const s = await state(p, "a1");
  check(!!s && s.open, "§2 tapping the fold bar expands the message");
  check(!!s && !s.pill, "§2 …and raises no copy pill");
  // Survives the 3s repaint — the open state lives outside the DOM by rule.
  await p.evaluate(() => paintFeed());
  await p.waitForTimeout(100);
  check((await state(p, "a1")).open, "§2 the open state survives a repaint");
  await p.close();
}

// ---- 3. An expanded bubble, and a short one, copy from anywhere ---------------------------------
{
  const p = await open();
  // a4 is the last reply: never folded, i.e. permanently expanded.
  await tapBody(p, "a4");
  check((await state(p, "a4")).pill, "§3 tap on an unfolded (newest) reply raises the pill");
  await tapBody(p, "u1");
  check((await state(p, "u1")).pill, "§3 tap on a SHORT bubble raises the pill");
  check(!(await state(p, "a4")).pill, "§3 …and the previous bubble's pill is dismissed");
  await tapBody(p, "u1");
  check(!(await state(p, "u1")).pill, "§3 a second tap on the same bubble dismisses the pill");
  await p.close();
}

// ---- 4. The copy is the FULL message, not the clamped portion -----------------------------------
{
  const p = await open();
  await tapBody(p, "a2");                       // the payload-clipped row
  check((await state(p, "a2")).pill, "§4 a clipped bubble raises the pill");
  await tapPill(p, "a2");
  const got = await p.evaluate(() => window.__copied);
  check(got.length === 1, "§4 exactly one clipboard write");
  check(got[0] === CLIPPED_FULL, "§4 the copied text is the FULL message, not the payload clamp");
  check(!(await state(p, "a2")).pill, "§4 the pill clears itself after copying");
  // A whole short message, verbatim.
  await tapBody(p, "u1");
  await tapPill(p, "u1");
  check((await p.evaluate(() => window.__copied))[1] === SHORT, "§4 a short message copies verbatim");
  await p.close();
}

// ---- 5. There is no manual collapse -------------------------------------------------------------
{
  const p = await open();
  await tapMore(p, "a1");
  check((await state(p, "a1")).open, "§5 expanded to begin with");
  await tapBody(p, "a1");
  const s = await state(p, "a1");
  check(s.open, "§5 tapping an expanded body does NOT collapse it");
  check(s.pill, "§5 …it raises the pill instead");
  await p.close();
}

// ---- 6. Burial collapses it; being on screen does not ------------------------------------------
{
  const p = await open();
  await tapMore(p, "a1");
  check((await state(p, "a1")).open, "§6 open before burial");
  // Two new rows is not yet buried (the rule is three since the open).
  const push = async n => {
    await p.evaluate(k => {
      for (let i = 0; i < k; i++) window.__feed.items.push({ role: "assistant", uuid: "n" + Math.random(), text: "later row", ts: Date.now() });
      window.__feed = { ...window.__feed, items: window.__feed.items.slice() };
    }, n);
    await p.evaluate(async () => { lastDrill = await api("/api/session/feed"); paintFeed(); });
    await p.waitForTimeout(150);
  };
  // Scroll the opened bubble off screen first, so the rule and its guard are measured separately.
  await p.evaluate(() => { const f = $("dfeed"); f.scrollTop = f.scrollHeight; });
  await p.waitForTimeout(150);
  await push(2);
  check((await state(p, "a1")).open, "§6 two rows since the open is not yet buried");
  await push(1);
  check(!(await state(p, "a1")).open, "§6 the third row since the open collapses it");

  // The guard: a bubble the reader can still see is never collapsed under them.
  const q = await open();
  await tapMore(q, "a1");
  await q.evaluate(() => { document.querySelector('.msg[data-uuid="a1"]').scrollIntoView({ block: "center" }); });
  await q.waitForTimeout(150);
  for (let i = 0; i < 5; i++) {
    await q.evaluate(() => {
      window.__feed.items.push({ role: "assistant", uuid: "g" + Math.random(), text: "later row", ts: Date.now() });
      window.__feed = { ...window.__feed, items: window.__feed.items.slice() };
    });
    await q.evaluate(async () => { lastDrill = await api("/api/session/feed"); paintFeed(); });
    await q.waitForTimeout(120);
  }
  const vis = await q.evaluate(() => {
    const el = document.querySelector('.msg[data-uuid="a1"]'), f = $("dfeed").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { onScreen: r.bottom > f.top && r.top < f.bottom, open: el.classList.contains("open") };
  });
  check(vis.onScreen, "§6 control: the bubble is still on screen");
  check(vis.open, "§6 an on-screen bubble is NOT collapsed however many rows arrive");
  await p.close(); await q.close();
}

// ---- 7. Guards — these pass on the pre-change page too ------------------------------------------
{
  const p = await open();
  // A link inside a reply keeps its own tap. md() renders NO anchors today (it has no link rule at
  // all), so the anchor is injected: this measures the bail-out against the day md() grows one,
  // which is the only way a bubble can contain a link. Injection survives here because paintFeed
  // returns early while the payload is unchanged.
  check(await p.locator('.msg[data-uuid="a3"] a').count() === 0, "§7 control: md() renders no anchors of its own");
  await p.evaluate(() => {
    const el = document.querySelector('.msg[data-uuid="a3"]');
    const a = document.createElement("a"); a.href = "#"; a.textContent = "the docs"; a.id = "__a";
    a.addEventListener("click", e => { e.preventDefault(); window.__link = 1; });
    el.appendChild(a);
  });
  const link = p.locator("#__a");
  await link.click();
  await p.waitForTimeout(200);
  check(await p.evaluate(() => window.__link === 1), "§7 a link inside a message still receives its tap");
  check(!(await state(p, "a3")).pill, "§7 …and raises no copy pill");

  // A live text selection's release is not a tap.
  await p.evaluate(() => {
    const el = document.querySelector('.msg[data-uuid="u2"]');
    const r = document.createRange(); r.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await tapBody(p, "u2");
  check(!(await state(p, "u2")).pill, "§7 releasing a text selection raises no copy pill");
  await p.evaluate(() => getSelection().removeAllRanges());

  // A turn row's chip keeps its tap, and turn rows are out of scope entirely.
  await p.locator('.msg.turn .chip').first().click();
  await p.waitForTimeout(250);
  check(await p.evaluate(() => $("calls").classList.contains("show")), "§7 a turn row's tool chip still opens the calls sheet");
  check(await p.evaluate(() => !document.querySelector(".msg.turn .copyb")), "§7 a turn row gets no copy pill");
  await p.evaluate(() => closeCalls());
  await p.waitForTimeout(250);

  // Command cards are out of scope: their own file-list fold owns their taps.
  await p.evaluate(() => addCard({ kind: "health", command: "/health",
    rows: [["🩺 Instance", "tg · v0.4.397"], ["🖥 Panes", "6"]], panes: [], crash: null, others: [] }));
  await p.waitForTimeout(200);
  check(await p.evaluate(() => !document.querySelector(".msg.bcard .copyb")), "§7 a command card gets no copy pill");
  await p.close();
}

// ---- 8. An image-only bubble has nothing to copy, so it is offered nothing --------------------
// The renderer strips the CLI's "(photo)" placeholder before deciding `imgonly`, so the row's only
// text IS that placeholder — a pill there would hand the clipboard "(photo)" or an empty string. A
// captioned photo is not imgonly and keeps the pill: the caption is real text somebody wrote.
{
  const p = await open();
  check(await p.evaluate(() => document.querySelector('.msg[data-uuid="i1"]').classList.contains("imgonly")),
    "§8 control: the fixture's photo row renders as imgonly");
  await tapBody(p, "i1");
  check(!(await state(p, "i1")).pill, "§8 an image-only bubble raises NO copy pill");
  await tapBody(p, "i2");
  const s = await state(p, "i2");
  check(!!s && s.pill, "§8 a CAPTIONED photo keeps its pill");
  // It must sit over the picture, not off it — the caption bubble is the only ground the pill has.
  const fit = await p.evaluate(() => {
    const el = document.querySelector('.msg[data-uuid="i2"]'), c = el.querySelector(".copyb");
    if (!c) return { inside: false, w: 0, h: 0 };          // the control page has no pill to place
    const a = el.getBoundingClientRect(), r = c.getBoundingClientRect();
    return { inside: r.top >= a.top - 1 && r.right <= a.right + 1 && r.bottom <= a.bottom + 1, w: r.width, h: r.height };
  });
  check(fit.inside && fit.w > 20 && fit.h > 12, `§8 …and the pill sits inside the bubble (${Math.round(fit.w)}x${Math.round(fit.h)})`);
  await tapPill(p, "i2");
  check((await p.evaluate(() => window.__copied)).slice(-1)[0] === "the crop you asked for", "§8 the caption is what it copies");
  await p.close();
}

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
