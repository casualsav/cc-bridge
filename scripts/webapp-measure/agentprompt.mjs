import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The prompt tap-through on subagent surfaces: an agent report card carries "Prompt ›" and a
// Delegated call row is a button, both opening the prompt the subagent was handed.
//
// The server half is REAL: the report-card items go through recentConversation (which resolves the
// notification's <tool-use-id> against the Task tool_use) and the chip blocks go through
// currentTurnFeed → turnParts. Known-truth controls (README rule 1): a notification whose
// tool-use-id matches NOTHING must render no button, a non-agent call row must stay a plain div,
// and the prompt text must be INVISIBLE before the tap — otherwise "visible after tap" is vacuous.

const REPO = "/home/ubuntu/projects/cc-bridge";
// Optional page path, so the run can be pointed at a pre-change copy — where every non-control
// check here must FAIL (the button, the sheet, the chip label all postdate it).
const PAGE = process.argv[2] || REPO + "/webapp/index.html";
const PROMPT_A = "PROMPT-ALPHA: read every file under webapp/ and report the feed shape.";
// The markup is the escaping control: it must render as text, never as an element.
const PROMPT_B = "PROMPT-BETA: fix the failing test. Do not touch <b>anything</b> else.";
const TUID = "toolu_01MeasurePromptLinkage00";

const note = (tuid, name) => `<task-notification>
<task-id>ad483af346e3ed2e3</task-id>
<tool-use-id>${tuid}</tool-use-id>
<status>completed</status>
<summary>Agent "${name}" finished</summary>
<result>## Done

All mapped.</result>
</task-notification>`;

// ---- Build both server payloads through the real parsers. ----
const dir = mkdtempSync(join(tmpdir(), "agentprompt-"));
const cards = join(dir, "cards.jsonl");
const turn = join(dir, "turn.jsonl");
const user = (text, uuid) => JSON.stringify({ type: "user", uuid, timestamp: "2026-08-12T10:00:00.000Z", message: { content: text } });
const spawn = (id, type, prompt) => JSON.stringify({ type: "assistant", uuid: "a-" + id, timestamp: "2026-08-12T10:00:01.000Z",
  message: { stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "Task", input: { subagent_type: type, prompt } }] } });
writeFileSync(cards, [
  spawn(TUID, "explorer", PROMPT_A),
  user(note(TUID, "Map the feed"), "u1"),
  user(note("toolu_01NoSuchSpawnAnywhere000", "Orphan report"), "u2"),   // control: resolves to nothing
].join("\n") + "\n");
writeFileSync(turn, [user("<tg 1>go</tg>", "u1"), spawn("toolu_x", "coder", PROMPT_B),
  JSON.stringify({ type: "assistant", uuid: "a2", timestamp: "2026-08-12T10:00:02.000Z",
    message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_y", name: "Bash", input: { command: "ls" } }] } }),
].join("\n") + "\n");
const { items, blocks } = JSON.parse(execFileSync("bun", ["-e", `
  import { recentConversation, currentTurnFeed } from '${REPO}/transcript.ts'
  import { turnParts } from '${REPO}/turn-summary.ts'
  console.log(JSON.stringify({
    items: recentConversation(${JSON.stringify(cards)}, 9),
    blocks: turnParts(currentTurnFeed(${JSON.stringify(turn)})),
  }))`], { encoding: "utf8" }).trim());

const SESSION = { sid: "abc", name: "cc-bridge", alive: true, cwd: "~/projects/cc-bridge" };
async function open(b, extraItems) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed
      : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed: { sid: "abc", name: "cc-bridge", items: [...items, ...extraItems] }, session: SESSION });
  await p.waitForTimeout(700);   // README rule 2: idle past the first repaint
  return p;
}
const chk = (ok, msg) => { console.log(ok ? "  OK   " : "  FAIL ", msg); if (!ok) failed++; };
let failed = 0;

const b = await chromium.launch();
// Page 1: a LIVE turn (chips visible) after the two report cards.
const p = await open(b, [{ role: "turn", ts: Date.now(), blocks }]);

// ---- The report card ----
const cardsSeen = await p.evaluate(() => [...document.querySelectorAll("#dfeed .msg.agent")].map(m => ({
  name: m.querySelector(".ah .nm")?.textContent ?? "", pv: !!m.querySelector(".ah .pv"),
})));
chk(cardsSeen.length === 2, `two report cards rendered (${cardsSeen.length})`);
// The linked card is headed by the agent TYPE (the owner, 2026-08-12), the orphan by the summary's
// task description — the only name it has.
const linked = cardsSeen.find(c => c.name.includes("explorer"));
const orphan = cardsSeen.find(c => c.name.includes("Orphan report"));
chk(linked && linked.pv, "the card whose Task call exists shows the Prompt › button and the TYPE as its name");
chk(orphan && !orphan.pv, "CONTROL — a notification resolving to no spawn shows NO button and keeps the summary name");
chk(!(await p.evaluate(t => document.body.innerText.includes(t), PROMPT_A)),
  "CONTROL — the prompt text is invisible before the tap");
await p.evaluate(() => document.querySelector("#dfeed .msg.agent .ah .pv")?.click());
await p.waitForTimeout(250);
let sheet = await p.evaluate(() => ({
  up: document.getElementById("calls").classList.contains("up"),
  title: document.getElementById("calltitle").textContent,
  body: document.querySelector("#calllist .pbody")?.textContent ?? "",
}));
chk(sheet.up, "tapping Prompt › opens the sheet");
chk(sheet.title === "Agent · explorer", `the sheet is titled for the agent (${JSON.stringify(sheet.title)})`);
chk(sheet.body.includes(PROMPT_A), "…and shows the prompt the agent was handed");
await p.evaluate(() => closeCalls());
await p.waitForTimeout(250);
// The card BODY keeps its own tap (copy), and it must not open the sheet.
await p.evaluate(() => document.querySelector("#dfeed .msg.agent").click());
await p.waitForTimeout(150);
chk(await p.evaluate(() => !document.getElementById("calls").classList.contains("up") && !!document.querySelector("#dfeed .copyb")),
  "a tap on the card BODY still copies and opens no sheet");

// ---- The live turn's chip → the prompt in ONE tap (a single-spawn chip skips the list) ----
const chipLabels = await p.evaluate(() => [...document.querySelectorAll("#dfeed .msg.turn .chip .cl")].map(e => e.textContent));
chk(chipLabels.includes("Delegated coder"), `the spawn's chip names the agent type (${JSON.stringify(chipLabels)})`);
await p.evaluate(() => [...document.querySelectorAll("#dfeed .msg.turn .chip")]
  .find(c => c.textContent.includes("Delegated"))?.click());
await p.waitForTimeout(250);
sheet = await p.evaluate(() => ({
  title: document.getElementById("calltitle").textContent,
  body: document.querySelector("#calllist .pbody")?.textContent ?? "",
  bolds: document.querySelectorAll("#calllist .pbody b").length,
  listRows: document.querySelectorAll("#calllist .row").length,
}));
chk(sheet.listRows === 0 && sheet.body.includes(PROMPT_B),
  "one tap from the feed lands ON the prompt — no list in between");
chk(sheet.title === "Delegated coder", `the prompt view is titled for the spawn (${JSON.stringify(sheet.title)})`);
chk(sheet.bolds === 0 && sheet.body.includes("<b>anything</b>"),
  "markup in a prompt renders as TEXT, never as elements");
await p.evaluate(() => closeCalls());
await p.waitForTimeout(250);
// CONTROL: a non-agent call row stays a plain div.
await p.evaluate(() => [...document.querySelectorAll("#dfeed .msg.turn .chip")]
  .find(c => c.textContent.includes("Ran a command"))?.click());
await p.waitForTimeout(250);
chk(await p.evaluate(() => { const r = document.querySelector("#calllist .row"); return r && r.tagName === "DIV" && !r.querySelector(".cv"); }),
  "CONTROL — a shell call row is a plain div with no chevron");
await p.close();

// ---- Page 2: the CONCLUDED turn — the flattened Worked-for list keeps the tap-through ----
const p2 = await open(b, [{ role: "turn", ts: Date.now(), workedSec: 42, blocks }]);
await p2.evaluate(() => [...document.querySelectorAll("#dfeed .msg.turn .chip")]
  .find(c => c.textContent.includes("Worked for"))?.click());
await p2.waitForTimeout(250);
chk(await p2.evaluate(() => !![...document.querySelectorAll("#calllist button.row")].find(r => r.textContent.includes("coder"))),
  "after the turn concludes, the flattened list still offers the Delegated row as a button");
await p2.evaluate(() => document.querySelector("#calllist button.row")?.click());
await p2.waitForTimeout(150);
chk(await p2.evaluate(t => (document.querySelector("#calllist .pbody")?.textContent ?? "").includes(t), PROMPT_B),
  "…and its prompt still opens");
await p2.close();

await b.close();
console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
