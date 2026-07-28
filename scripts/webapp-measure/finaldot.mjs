import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// A FINAL message carries a dot on its first line, and nothing else in the feed does.
//
//   node finaldot.mjs [page] [outdir]
//
// Pre-change control: `node finaldot.mjs /path/to/old/index.html` — the four presence checks must
// FAIL there. The EXCLUSION checks (narration, user bubbles, agent cards and command rows carry no
// dot) pass on both pages on purpose: they are the guard that this marking stays where it was aimed,
// not a control. A guard that only started holding after the change would mean the change caused
// what it guards against.
//
// THE BOUNDARY THIS UNIT MUST NOT CROSS: narration is unmarked by the owner's ruling (see
// thoughts.mjs, whose count of differing box properties between narration and the reply must stay at
// zero). The dot is an inline CHILD of the reply's run for exactly that reason, and §4 re-measures
// that count here so the two units cannot drift apart quietly.
//
// KNOWN AND ACCEPTED, measured in §5 rather than hidden: a first word too long to sit beside the dot
// leaves the dot alone on its line. It was disclosed on the contact sheet and chosen with that cost
// on the table, so the check ASSERTS the behaviour instead of forbidding it — if someone "fixes" it
// with a no-wrap wrapper, this fails and asks them to take that decision deliberately.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3];
const ts = 1785200000000;
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
// Every row kind the feed can paint, so the exclusions are measured rather than assumed.
const items = [
  { role: "user", text: "did the deploy come back on the new version?", ts },
  { role: "assistant", text: "Yes — the daemon respawned on 0.4.187 and the watchdog confirmed it.", ts },
  { role: "turn", ts, blocks: [
    { t: "p", text: "I want the answer off the wire rather than off the rendered page, so I will read the feed endpoint directly." },
    { t: "chip", kind: "run", label: "Ran 2 commands", calls: [{ verb: "Ran", target: "curl /api/session/feed" }] },
    { t: "p", text: "That comes back clean, and the unit tests agree with it." },
  ] },
  { role: "assistant", text: "It passed. The transcript check reads the same values off the live endpoint that the harness asserts, and all 987 unit tests are still green.", ts },
  { role: "command", name: "/context", text: "Context: 42k/200k tokens", ts },
  { role: "agent", agent: "verifier", status: "completed", text: "Ran the suite: 987 pass, 0 fail.", ts },
  { role: "assistant", text: "Nothing blocking — the tree is clean and the version files are already stamped.", ts },
];
const feed = { sid: "abc", name: "cc-bridge", working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high", items };
const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
  "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
const open = async vars => {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  // A fixture injecting theme variables must re-run the chrome pin, or the page keeps a dark-pinned
  // --bg under light type and every colour read is of a screen nobody sees.
  if (vars) await p.evaluate(v => { for (const [k, val] of Object.entries(v))
    document.documentElement.style.setProperty("--tg-theme-" + k, val); pinChromeColour(); }, vars);
  await p.evaluate(f => { window.api = async u => u.includes("feed") ? f : { sessions: [] }; openDrill(f.sid, f.name); }, feed);
  await p.waitForTimeout(900);
  return p;
};

const p = await open(null);

// ---- 1. Presence, and only on replies ----------------------------------------------------------
const m = await p.evaluate(() => {
  const q = s => [...document.querySelectorAll(s)];
  const dotsIn = s => q(s).map(e => e.querySelectorAll(".fin").length);
  const rep = q("#dfeed .msg.assistant");
  const first = rep[0];
  const dot = first && first.querySelector(".fin");
  // The dot must be the reply's FIRST child — a mark on the first line, not somewhere in the run.
  const isFirst = !!dot && first.firstElementChild === dot;
  const c = dot ? getComputedStyle(dot) : null;
  return {
    replies: rep.length, dotsPerReply: dotsIn("#dfeed .msg.assistant"),
    inUser: dotsIn("#dfeed .msg.user").reduce((a, x) => a + x, 0),
    inTurn: dotsIn("#dfeed .msg.turn").reduce((a, x) => a + x, 0),
    inAgent: dotsIn("#dfeed .msg.agent").reduce((a, x) => a + x, 0),
    inCommand: dotsIn("#dfeed .msg.command").reduce((a, x) => a + x, 0),
    isFirst,
    size: dot ? [dot.getBoundingClientRect().width, dot.getBoundingClientRect().height] : null,
    colour: c?.color, marginRight: c ? parseFloat(c.marginRight) : null,
    hint: getComputedStyle(document.documentElement).getPropertyValue("--hint").trim(),
  };
});
check(m.replies === 3, `the fixture carries ${m.replies} replies (3)`);
check(m.dotsPerReply.every(n => n === 1), `every reply carries exactly ONE dot (${JSON.stringify(m.dotsPerReply)})`);
check(m.isFirst, "…as the row's first element, so it opens the first line");
check(m.size && Math.abs(m.size[0] - 5) < 0.6 && Math.abs(m.size[1] - 5) < 0.6, `…drawn at 5×5 (${m.size?.map(v => v.toFixed(1)).join("×")})`);
// The EXCLUSIONS — the guard half. These pass on the pre-change page too, and that is the claim.
check(m.inUser === 0, `no dot on a user bubble (${m.inUser})`);
check(m.inTurn === 0, `NO DOT ON NARRATION — the owner's ruling holds (${m.inTurn})`);
check(m.inAgent === 0, `no dot on an agent card (${m.inAgent})`);
check(m.inCommand === 0, `no dot on a command row (${m.inCommand})`);

// ---- 2. It is PAINTED, in both themes ----------------------------------------------------------
// getComputedStyle proves the CSS parsed. The dot is 5px of --hint on the page ground, so a colour
// that resolved to the ground would pass every declared-value check and be invisible — the same trap
// the quote bar fell into at 9/255. Sample the render.
for (const [theme, vars] of [["dark", null], ["light", LIGHT]]) {
  const pg = theme === "dark" ? p : await open(vars);
  const r = await pg.evaluate(() => {
    const d = document.querySelector("#dfeed .msg.assistant .fin");
    if (!d) return null;
    const b = d.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  if (!r) { check(false, `${theme}: no dot to measure`); continue; }
  const shot = await pg.screenshot({ clip: { x: r.x - 6, y: r.y - 1, width: 12, height: 2 } });
  const px = await pg.evaluate(async data => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const at = x => { const d = ctx.getImageData(x, Math.floor(img.height / 2), 1, 1).data; return [d[0], d[1], d[2]]; };
    // dpr 2, clip 6 CSS px left of the dot's centre: device 12 is the centre, device 1 is ground.
    return { ink: at(12), ground: at(1) };
  }, shot.toString("base64"));
  const delta = Math.max(...px.ink.map((v, i) => Math.abs(v - px.ground[i])));
  check(delta >= 30, `${theme}: the dot is PAINTED and visible — ${delta}/255 (ink ${px.ink}, ground ${px.ground})`);
  if (theme === "light" && !OUT) await pg.close();
}

// ---- 3. It costs the reply no height -----------------------------------------------------------
// The reason A was picked over the label and the lede: the mark rides the existing line box.
// Guarded on the dot existing, because this file is also run against a page that has none — a
// control that THROWS reports nothing and is not a control.
const h = await p.evaluate(() => {
  const r = document.querySelector("#dfeed .msg.assistant");
  const d = r && r.querySelector(".fin");
  if (!d) return null;
  const before = r.getBoundingClientRect().height;
  const parent = d.parentNode; d.remove();
  const after = r.getBoundingClientRect().height;
  parent.insertBefore(d, parent.firstChild);
  return { before, after };
});
check(h !== null && Math.abs(h.before - h.after) < 0.5,
  h ? `the dot adds no height to its reply (${h.before.toFixed(0)}px with, ${h.after.toFixed(0)}px without)` : "the dot adds no height to its reply (NO DOT on this page)");

// ---- 4. The narration boundary, re-measured HERE ------------------------------------------------
// thoughts.mjs owns this claim; it is restated in this file so the two units cannot drift apart in
// silence. Zero of the seven properties may differ between narration and a reply.
const nb = await p.evaluate(() => {
  const box = e => { const s = getComputedStyle(e); return { bar: parseFloat(s.borderLeftWidth), padLeft: parseFloat(s.paddingLeft),
    size: s.fontSize, weight: s.fontWeight, style: s.fontStyle, colour: s.color, opacity: s.opacity }; };
  const q = document.querySelector(".msg.turn .tq"), r = document.querySelector(".msg.assistant");
  if (!q || !r) return ["missing"];
  return Object.keys(box(q)).filter(k => box(q)[k] !== box(r)[k]);
});
check(nb.length === 0, `narration still measures byte-identical to the reply — the dot is a child, not a property (differs on: ${nb.join(", ") || "NOTHING"})`);

// ---- 5. The accepted cost, asserted rather than hidden ------------------------------------------
const orphan = await p.evaluate(() => {
  const r = document.querySelector("#dfeed .msg.assistant");
  const clone = r.cloneNode(true);
  const tn = (function w(n) { for (const k of n.childNodes) { if (k.nodeType === 3 && k.textContent.trim()) return k;
    if (k.nodeType === 1) { const f = w(k); if (f) return f; } } return null; })(clone);
  if (!tn) return null;
  tn.textContent = "supercalifragilisticexpialidociousantidisestablishmentarianism " + tn.textContent;
  r.parentNode.insertBefore(clone, r);
  const d = clone.querySelector(".fin");
  if (!d) { clone.remove(); return null; }
  const rg = document.createRange(); rg.selectNodeContents(tn);
  const t1 = rg.getClientRects()[0], d1 = d.getBoundingClientRect();
  const v = t1 ? Math.round(t1.top - d1.top) : null;
  clone.remove();
  return v;
});
check(orphan !== null && orphan > 0,
  orphan === null ? "ACCEPTED COST: (NO DOT on this page)" : `ACCEPTED COST: a first word too long to sit beside the dot wraps under it, leaving the dot on its own line (${orphan}px). Disclosed on the contact sheet and chosen; a no-wrap "fix" changes which design was picked and fails here.`);

// ---- Shots -------------------------------------------------------------------------------------
if (OUT) {
  mkdirSync(OUT, { recursive: true });
  for (const [name, vars] of [["dark", null], ["light", LIGHT]]) {
    const s = await open(vars);
    await s.evaluate(() => { document.getElementById("dfeed").scrollTop = 0; });
    await s.waitForTimeout(300);
    await s.screenshot({ path: join(OUT, `finaldot-${name}.png`) });
    await s.close();
  }
  console.log(`\nshots → ${OUT}`);
}

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
