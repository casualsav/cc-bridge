// A session card's LOWER HALF: the task line clamps to ONE line, and the foot carries the SESSION's
// numbers — the 5h window not being one of them.
//
//   node cardfoot.mjs [pagePath] [outdir]
//
// The owner's ruling: the 5h reading is account-level, identical on every card, so repeating it per
// session said nothing about the session. Two claims, and the second is the one a removal creates:
//   1. No card renders it, however the payload arrives — including a session whose payload still
//      carries `h5Pct`, which is the only version of this check that can fail. (The field is left on
//      the wire on purpose: a proper 5h/weekly display belongs to the sessions page, later.)
//   2. No card carries the GAP it leaves. `.sess .foot` has a margin-top, so an empty foot is 8px of
//      air under the task line — and after this removal a session with no branch and no ctx has an
//      empty foot for the first time.
// Everything else on the card holds still: the title row, the task line, the branch and the ctx
// reading with its bar, and the height of a card that still has all of them.
//
// CONTROL: pass a pre-change page (`git show HEAD:webapp/index.html > /tmp/old.html`). The 5h checks
// and both gap checks must FAIL there; the holds-still checks pass on both, since the change is a
// removal and nothing else was meant to move.
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const PAGE = process.argv[2] || "/home/ubuntu/projects/cc-bridge/webapp/index.html";
const OUT = process.argv[3] || "cardfoot-shots";
mkdirSync(OUT, { recursive: true });

// Four cards, one per shape these two changes touch: the redundancy case (everything), the card whose
// foot the 5h reading was HOLDING OPEN, one that had nothing in the foot to begin with, and the
// fullest card there is — whose task line is what the one-line clamp has to bite on. Order matters:
// the checks below read them positionally.
const SESSIONS = [
  { sid: "a", name: "cc-bridge", alive: true, working: true, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high",
    task: "Folding the working row into the composer", subagents: 0, branch: "main", ctxPct: 41, h5Pct: 68, state: "working" },
  { sid: "b", name: "five-h-only", alive: true, working: false, cwd: "~/x", model: "Sonnet 5", effort: "medium",
    task: "Waiting on a review", subagents: 0, branch: null, ctxPct: null, h5Pct: 68, state: "idle" },
  { sid: "c", name: "nothing-in-the-foot", alive: true, working: false, cwd: "~/y", model: "Sonnet 5", effort: "low",
    task: "Nothing to report", subagents: 0, branch: null, ctxPct: null, h5Pct: null, state: "idle" },
  // The FULLEST card there is: everything populated and a task line long enough to have wrapped to two
  // lines before this change — which is what makes the clamp measurable rather than assumed.
  { sid: "d", name: "a-considerably-longer-session-name-than-fits", alive: true, working: true, cwd: "~/projects/x",
    model: "Sonnet 5", effort: "high", subagents: 2, branch: "feat/two-row-composer", ctxPct: 62, h5Pct: 68, state: "working",
    task: "Reading the transcript back and folding the working row into the composer, then measuring every box it moved" },
];

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(sessions => {
  window.api = async path => path.includes("sessions") ? { sessions } : {};
  showTab("sessions");
  renderSessions();
}, SESSIONS);
await p.waitForTimeout(600);

const cards = await p.evaluate(() => [...document.querySelectorAll("#tab-sessions .sess")].map(c => {
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { y: +b.y.toFixed(2), h: +b.height.toFixed(2), bottom: +b.bottom.toFixed(2) }; };
  const task = c.querySelector(".task");
  const title = c.querySelector(".top");
  const foot = c.querySelector(".foot");
  // The last row with INK in it, which an empty foot is not: measuring the air below a zero-height
  // foot from the foot itself reports the card's own padding and can never fail — the whole gap
  // being asked about lives in that box's margin, above its zero height.
  const inked = [...c.children].filter(e => e.getBoundingClientRect().height > 0.5);
  const lastRow = inked[inked.length - 1];
  return {
    name: c.querySelector(".nm")?.textContent, text: c.textContent,
    card: r(c), padBottom: parseFloat(getComputedStyle(c).paddingBottom),
    foot: r(foot), footHTML: foot ? foot.innerHTML : null,
    // The bar's fill is a <span> too, and an empty one — count the READINGS, not every span.
    footItems: foot ? [...foot.querySelectorAll("span")].filter(s => !s.closest(".bar")).map(s => s.textContent) : null,
    hasBar: !!c.querySelector(".foot .bar"),
    taskH: task ? +task.getBoundingClientRect().height.toFixed(2) : null,
    taskScrollH: task ? task.scrollHeight : null,
    lineBox: task ? Math.round(parseFloat(getComputedStyle(task).lineHeight)) : null,
    titleTop: title ? +(title.getBoundingClientRect().top - c.getBoundingClientRect().top).toFixed(2) : null,
    titleH: title ? +title.getBoundingClientRect().height.toFixed(2) : null,
    taskToFoot: (task && foot) ? +(foot.getBoundingClientRect().top - task.getBoundingClientRect().bottom).toFixed(2) : null,
    // The card's own floor: how far below its last painted row the box ends. Anything past its own
    // padding is a gap somebody left behind.
    tailAir: +((c.getBoundingClientRect().bottom - lastRow.getBoundingClientRect().bottom)).toFixed(2),
  };
}));

const checks = [];
const ok = (label, pass, detail) => checks.push({ label, pass, detail });
const near = (a, b, tol = 0.51) => a != null && b != null && Math.abs(a - b) <= tol;
const [A, B, C, D] = cards;

ok("FIXTURE: four cards rendered", cards.length === 4, cards.map(c => c.name).join(", "));
// ---- the task line is ONE line ----------------------------------------------------------------
ok("FIXTURE: the fullest card's task really is too long for one line", D.taskScrollH > D.taskH + 4,
  `wants ${D.taskScrollH}px in a ${D.taskH}px line`);
ok("the fullest card's task clamps to exactly one line", near(D.taskH, D.lineBox), `${D.taskH} vs one line ${D.lineBox}`);
ok("…and the shortest card's task is that same one line", near(A.taskH, A.lineBox), `${A.taskH} vs ${A.lineBox}`);
ok("so a long task costs the card NO extra height", near(D.card.h, A.card.h), `fullest ${D.card.h} vs short ${A.card.h}`);
ok("nothing above the task moved: the title row sits where it did",
  near(D.titleTop, A.titleTop) && near(D.titleH, A.titleH), `${D.titleTop}/${D.titleH} vs ${A.titleTop}/${A.titleH}`);
ok("nothing below it moved either: the same gap to the foot",
  near(D.taskToFoot, A.taskToFoot), `${D.taskToFoot} vs ${A.taskToFoot}`);
// 1. gone, on every card, with the payload still carrying it
ok("the card with everything shows no 5h reading", !/5h/.test(A.text), A.footItems?.join(" · "));
ok("…nor does the one whose only number WAS the 5h", !/5h/.test(B.text), B.text.trim().slice(0, 60));
ok("no card anywhere shows one", !cards.some(c => /5h/.test(c.text)), cards.filter(c => /5h/.test(c.text)).map(c => c.name).join(",") || "none");
// 2. …and no card carries the gap it leaves
ok("a card with nothing to foot renders NO foot", B.foot === null && C.foot === null, `b=${B.foot ? "present" : "absent"} c=${C.foot ? "present" : "absent"}`);
ok("…so its box ends at its own padding, not 8px past it", near(B.tailAir, B.padBottom) && near(C.tailAir, C.padBottom), `b=${B.tailAir} c=${C.tailAir} vs padding ${B.padBottom}`);
// 3. everything else holds still
ok("the branch is still there", /🌿 main/.test(A.text), A.footItems?.[0]);
ok("the ctx reading is still there", A.footItems?.some(t => /^ctx 41%$/.test(t)), A.footItems?.join(" · "));
ok("…with its bar", A.hasBar, `${A.hasBar}`);
ok("the foot is exactly those two", A.footItems?.length === 2, A.footItems?.join(" · "));
ok("each card still names its session", cards.every((c, i) => c.name === SESSIONS[i].name), cards.map(c => c.name).join(", "));
ok("each card still carries its task line", cards.every((c, i) => c.text.includes(SESSIONS[i].task)), "");

for (const [i, c] of cards.entries()) {
  const box = await p.locator("#tab-sessions .sess").nth(i).boundingBox();
  await p.screenshot({ path: `${OUT}/card-${c.name}.png`, clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } });
}

console.log(`page: ${PAGE}`);
for (const c of cards) console.log(` ${String(c.name).slice(0, 20).padEnd(20)} h=${String(c.card.h).padEnd(7)} task=${String(c.taskH).padEnd(6)}(wants ${c.taskScrollH}) foot=${c.footItems ? c.footItems.join(" · ") : "—"}`);
console.log();
let bad = 0;
for (const c of checks) { if (!c.pass) bad++; console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label.padEnd(52)} ${c.detail}`); }
console.log(`\n${checks.length - bad}/${checks.length} pass  ·  shots in ${OUT}/`);
await b.close();
process.exit(bad ? 1 : 0);
