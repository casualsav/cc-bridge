import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// AN EMPTY CONVERSATION SHOWS THE CLAUDE CODE GLYPH (the owner, 2026-08-08), where "No conversation
// yet." used to be: 40% of the chat's width, CENTRED in it — vertically too, his amendment to the
// first build, which anchored the mark where that sentence's first line started — and it leaves
// upward on the first send.
//
// The claims, and what each is worth:
//
//   1. The empty feed renders the glyph and NOT the sentence. Both halves, because a page that
//      renders both would pass either one alone.
//   2. Its width is 40% of the FEED's own content width, measured — a percentage declared against an
//      inset box is a different number and no computed-style check can tell them apart.
//   3. It is centred in the VISIBLE chat area, which is that same content box: the band between the
//      header's footprint and the dock, both of which the feed reserves as its own padding. Centring
//      on the feed's border box instead would sit it low by half the difference and pass any
//      "margin-inline: auto" reading of the CSS.
//   4. The first send takes it away, and what animates is a CLONE — the real element is wiped by
//      paintFeed's innerHTML swap in the same tick. The clone is proven to have existed (a
//      MutationObserver, not a race against a 250ms transition), proven to be PARKED where the real
//      one stood (the resting element is a full-height flex box, so a clone that shrink-wraps centres
//      the glyph in nothing and jumps to the feed's top before it flies), and proven gone afterwards.
//   5. Reduced motion gets no clone at all and the glyph still leaves.
//   6. GUARDS: a feed with rows renders no glyph, and the sessions list's own "No live sessions."
//      notice is untouched — `.notice` is shared vocabulary and this change must not have reached it.
//
//   node emptyglyph.mjs [page]
//
// The CONTROL is the pinned commit before this change, rendered from git — never HEAD, which becomes
// a copy of the page under test the moment this is committed. STATE checks must FAIL there; GUARDS
// must pass on both. Nothing here is an INK claim: the harness's font is not the device's, and every
// number below is a box.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const BASELINE = process.env.EMPTYGLYPH_BASELINE || "22cf65b";
const BASE = join(mkdtempSync(join(tmpdir(), "emptyglyph-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

// The silhouette the Coding Sessions label carries. Compared as the PATH, not as "an svg is there":
// one mark for one product, and a second drawing of it is what this catches.
const GLYPH_PATH = "M2 0h12v4h2v2h-2v2h-1v2h-1V8h-1v2h-1V8H6v2H5V8H4v2H3V8H2V6H0V4h2V0Zm2 2v2h1V2H4Zm7 0v2h1V2h-1Z";
const WIDTH_FRACTION = 0.40;
const ts = 1785200000000;
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
const feedOf = items => ({ sid: "abc", name: "cc-bridge", working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high", items });
const CHAT = [{ role: "user", uuid: "m1", text: "are we there yet", ts }, { role: "assistant", uuid: "m2", text: "Nearly.", ts }];

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();

const open = async (path, { reduce = false } = {}) => {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, ...(reduce ? { reducedMotion: "reduce" } : {}) });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(session => {
    window.__feed = null;
    window.__sessions = [session];
    window.api = async path => path.includes("session/feed") ? window.__feed
      : path.includes("sessions") ? { sessions: window.__sessions } : {};
    // writeOp goes through `fetch`, not api() — stubbing api would leave the send unable to happen.
    const realFetch = window.fetch;
    window.fetch = async (u, o) => {
      const url = String((u && u.url) || u);
      if (url.includes("/api/session/act")) return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      return realFetch(u, o);
    };
  }, SESSION);
  return p;
};

// The poll's own path — set the snapshot, let renderDrill() fetch and paint, then idle past the
// repaint (README rule 2) before reading anything.
const drive = async (p, items) => {
  await p.evaluate(f => { window.__feed = f; }, feedOf(items));
  await p.evaluate(() => (window.drillSid ? renderDrill() : openDrill("abc", "cc-bridge")));
  await p.waitForTimeout(900);
};

const readEmpty = p => p.evaluate(pathD => {
  const feed = document.getElementById("dfeed");
  const cs = getComputedStyle(feed);
  const fr = feed.getBoundingClientRect();
  // The CONTENT box — the band the reader can actually see. The feed reserves the header's footprint
  // and the dock's height as its own padding, so its border box is not the chat area and centring in
  // it would be a different (wrong) answer that looks identical in the stylesheet.
  const box = {
    top: fr.top + parseFloat(cs.paddingTop),
    bottom: fr.bottom - parseFloat(cs.paddingBottom),
    left: fr.left + parseFloat(cs.paddingLeft),
    right: fr.right - parseFloat(cs.paddingRight),
  };
  const wrap = feed.querySelector(".emptyglyph");
  const svg = wrap && wrap.querySelector("svg");
  const sr = svg && svg.getBoundingClientRect();
  return {
    contentW: box.right - box.left,
    contentH: box.bottom - box.top,
    text: feed.textContent.trim(),
    hasGlyph: !!svg,
    pathOk: !!svg && [...svg.querySelectorAll("path")].some(p => p.getAttribute("d") === pathD),
    ariaHidden: !!svg && svg.getAttribute("aria-hidden") === "true",
    glyphW: sr ? +sr.width.toFixed(2) : null,
    // Signed offsets of the glyph's own centre from the content box's centre, so a miss reads as a
    // direction rather than as two coordinates to subtract by hand.
    dy: sr ? +((sr.top + sr.bottom) / 2 - (box.top + box.bottom) / 2).toFixed(2) : null,
    dx: sr ? +((sr.left + sr.right) / 2 - (box.left + box.right) / 2).toFixed(2) : null,
  };
}, GLYPH_PATH);

// Type into the real composer and press the real send button — the optimistic paint is the thing
// under test, so nothing about it is simulated.
const send = async (p, text) => {
  await p.evaluate(t => { document.getElementById("dtext").value = t; syncComposerMode(); }, text);
  await p.waitForTimeout(120);
  await p.click("#dsend", { timeout: 2000 });
};

async function measure(page, label, sink) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);

  // ---- 1 + 2: what an empty conversation shows --------------------------------------------------
  await drive(page, []);
  const m = await readEmpty(page);
  state(m.hasGlyph && m.pathOk, `an empty conversation renders the glyph (svg ${m.hasGlyph}, silhouette ${m.pathOk})`);
  state(!m.text.includes("No conversation yet"), `…and not the sentence it replaced (feed text ${JSON.stringify(m.text.slice(0, 40))})`);
  state(m.hasGlyph && m.ariaHidden, "…decorative, so a screen reader is not read an empty screen twice");
  const want = m.contentW * WIDTH_FRACTION;
  state(m.glyphW !== null && Math.abs(m.glyphW - want) <= 1,
    `it is ${WIDTH_FRACTION * 100}% of the feed's content width — ${m.glyphW} against ${want.toFixed(2)} of ${m.contentW.toFixed(2)}`);
  // ---- 3: centred in the visible chat area ------------------------------------------------------
  state(m.dy !== null && Math.abs(m.dy) <= 2, `it is centred VERTICALLY in the ${m.contentH?.toFixed(0)}px chat area (off by ${m.dy})`);
  state(m.dx !== null && Math.abs(m.dx) <= 2, `…and horizontally (off by ${m.dx})`);

  // ---- 6a. GUARD: a feed with rows renders no glyph ----------------------------------------------
  await drive(page, CHAT);
  const filled = await readEmpty(page);
  guard(!filled.hasGlyph, `a feed with rows renders no glyph (${filled.hasGlyph})`);

  // ---- 4. The first send takes it away, and a CLONE is what flies -------------------------------
  await drive(page, []);
  await page.evaluate(() => {
    window.__cloneSeen = 0;
    window.__cloneAt = null;
    // An observer, not a race against a 250ms transition: the clone is removed on transitionend and
    // a sample taken a moment late would report the same "absent" a page that never made one does.
    // It also reads the clone's glyph AT PARK — the callback is a microtask on the mutation, so it
    // always runs before the rAF that arms the transform, which no wall-clock sample can promise.
    new MutationObserver(rs => rs.forEach(r => r.addedNodes.forEach(n => {
      if (n.nodeType === 1 && n.classList && n.classList.contains("flyaway")) {
        window.__cloneSeen++;
        const s = n.querySelector("svg");
        if (s) { const b = s.getBoundingClientRect(); window.__cloneAt = { top: +b.top.toFixed(2), left: +b.left.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; }
      }
    }))).observe(document.getElementById("drill"), { childList: true });
  });
  // The resting position, read before the send: the clone has to start exactly here or the journey
  // begins with a jump.
  const resting = await page.evaluate(() => {
    const s = document.querySelector("#dfeed .emptyglyph svg");
    if (!s) return null;
    const b = s.getBoundingClientRect();
    return { top: +b.top.toFixed(2), left: +b.left.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
  });
  const hadGlyph = await page.evaluate(() => !!document.querySelector("#dfeed .emptyglyph"));
  await send(page, "first message");
  await page.waitForTimeout(150);
  const afterSend = await page.evaluate(() => ({
    inFeed: !!document.querySelector("#dfeed .emptyglyph"),
    bubbles: document.querySelectorAll("#dfeed .msg.user").length,
    seen: window.__cloneSeen,
    at: window.__cloneAt,
  }));
  // Compound with "there was one to begin with", or a page that never renders a glyph passes this
  // for the wrong reason — which is exactly what the control reported before the term was added.
  state(hadGlyph && afterSend.bubbles > 0 && !afterSend.inFeed,
    `the first send takes the glyph off the feed (had one ${hadGlyph}, ${afterSend.bubbles} bubble(s) painted, glyph present ${afterSend.inFeed})`);
  state(afterSend.seen === 1, `…and exactly one clone was raised to fly it away (${afterSend.seen})`);
  // The jump this guards: the resting element is a full-height flex box, so a clone given only a
  // width shrink-wraps, centres the glyph in nothing and starts from the feed's top edge.
  const drift = resting && afterSend.at
    ? Math.max(...["top", "left", "w", "h"].map(k => Math.abs(afterSend.at[k] - resting[k]))) : null;
  state(drift !== null && drift <= 0.5,
    `…parked exactly where the real one stood, so the flight starts with no jump (worst axis ${drift}px; rest ${JSON.stringify(resting)} vs clone ${JSON.stringify(afterSend.at)})`);
  await page.waitForTimeout(800);
  const parked = await page.evaluate(() => document.querySelectorAll(".flyaway").length);
  state(afterSend.seen === 1 && parked === 0, `…and nothing is left parked over the transcript (${parked} still there)`);

  // ---- 6b. GUARD: the sessions list's own notice is untouched -----------------------------------
  const listNotice = await page.evaluate(() => {
    window.__sessions = [];
    showTab("sessions");
    return new Promise(r => setTimeout(() => {
      const el = document.querySelector("#tab-sessions .notice");
      r(el ? { text: el.textContent.trim(), glyph: !!el.querySelector("svg") } : null);
    }, 500));
  });
  guard(listNotice?.text === "No live sessions." && !listNotice.glyph,
    `an empty fleet still reads "No live sessions." (${JSON.stringify(listNotice)})`);
}

const p = await open(PAGE);
await measure(p, "page", (_kind, ok, l) => check(ok, l));

// ---- 5. Reduced motion: no clone, and the glyph still goes -------------------------------------
{
  const q = await open(PAGE, { reduce: true });
  await drive(q, []);
  await q.evaluate(() => {
    window.__cloneSeen = 0;
    new MutationObserver(rs => rs.forEach(r => r.addedNodes.forEach(n => {
      if (n.nodeType === 1 && n.classList && n.classList.contains("flyaway")) window.__cloneSeen++;
    }))).observe(document.getElementById("drill"), { childList: true });
  });
  const had = await q.evaluate(() => !!document.querySelector("#dfeed .emptyglyph"));
  await send(q, "first message");
  await q.waitForTimeout(300);
  const r = await q.evaluate(() => ({ seen: window.__cloneSeen, inFeed: !!document.querySelector("#dfeed .emptyglyph") }));
  // Compound with "there was a glyph to begin with", or this passes on any page that never had one.
  check(had && r.seen === 0 && !r.inFeed,
    `reduced motion: the glyph was there, leaves on the send, and NO clone is animated (seen ${r.seen})`);
  await q.close();
}

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

// The cross-page comparison this file used to end on — the glyph starting where the notice's first
// line started — went with the owner's 2026-08-08 amendment: the mark is centred in the chat area
// now, which is a claim about the page under test alone and is checked inside measure() as such.

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
