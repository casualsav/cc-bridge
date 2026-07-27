import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The subagent report card. A background task notifies its parent as a USER entry whose body is a
// machine payload, so before this it wore the owner's blue bubble and showed its own XML.
//
// The items are NOT hand-written here: a fixture transcript goes through the real recentConversation
// and the client renders whatever that returns, so a parse that regressed would show up as raw
// markup on screen exactly as it did on the owner's phone. The known-truth control (README rule 1)
// is the last row — one row deliberately left in the OLD shape, whose tags the checks below MUST
// report. If the control comes back clean, the tag detector is broken and every OK above it is void.

const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
                "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };
const REPO = "/home/ubuntu/projects/cc-bridge";
const NOTIFICATION = `<task-notification>
<task-id>ad483af346e3ed2e3</task-id>
<tool-use-id>toolu_01V9wPXt1E5YSfnecJLLRJsJ</tool-use-id>
<output-file>/tmp/claude-1001/-home-ubuntu-test/f4817bd4/tasks/ad483af346e3ed2e3.output</output-file>
<status>completed</status>
<summary>Agent "Parse CLI working line into feed" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>
<result>## Conclusion

The working line is parsed in \`transcript.ts\`, and it awaits &lt;N&gt; sessions in sequence.

- one
- two

\`\`\`sh
# not a heading
- not a bullet
\`\`\`</result>
</task-notification>`;
// A human message that must survive VERBATIM: the entity decoding is scoped to the parsed path, and
// this is what proves it. If it ever renders as a tag, the decode leaked.
const TYPED = "use &lt;div&gt; not &amp;lt;div&amp;gt;";

// ---- Build the feed the daemon would build, through the real parser. ----
const dir = mkdtempSync(join(tmpdir(), "agentcard-"));
const jsonl = join(dir, "session.jsonl");
const entry = (text, uuid) => JSON.stringify({ type: "user", uuid, timestamp: "2026-07-27T10:00:00.000Z", message: { content: text } });
writeFileSync(jsonl, [
  entry(`<tg 1>${TYPED}</tg>`, "u1"),
  entry(NOTIFICATION, "u2"),
  entry("<local-command-stdout>Set model to claude-opus-4-8</local-command-stdout>", "u3"),
].join("\n") + "\n");
const items = JSON.parse(execFileSync("bun", ["-e",
  `import {recentConversation} from '${REPO}/transcript.ts'; console.log(JSON.stringify(recentConversation(${JSON.stringify(jsonl)}, 9)))`,
], { encoding: "utf8" }).trim());
// The control row, appended AFTER the parse: the payload exactly as the old code passed it through.
items.push({ role: "user", text: NOTIFICATION, ts: 1785200000000, uuid: "ctrl" });
// LEAK CONTROL for the block-markdown widening: the same two constructs in an ASSISTANT reply,
// which must still render literally. Widening md() itself would have moved this row too.
items.push({ role: "assistant", text: "## x\n- y", ts: 1785200000000, uuid: "asst" });

const FEED = { sid: "abc", name: "cc-bridge", items };
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, cwd: "~/projects/cc-bridge" };

async function open(b, vars) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto("file://" + REPO + "/webapp/index.html", { waitUntil: "domcontentloaded" });
  if (vars) await p.evaluate(v => { for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty("--tg-theme-" + k, val); }, vars);
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed
      : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed: FEED, session: SESSION });
  await p.waitForTimeout(700);   // README rule 2: idle past the first repaint
  return p;
}

const TAGS = ["<task-notification", "<task-id", "<tool-use-id", "<output-file", "<status>", "<summary>", "<note>", "<result>", "toolu_01", "/tmp/claude-1001"];
const chk = (ok, msg) => { console.log(ok ? "  OK   " : "  FAIL ", msg); if (!ok) failed++; };
let failed = 0;

const b = await chromium.launch();
const p = await open(b);

// What a reader actually sees, row by row (textContent, not HTML — the question is what is VISIBLE).
const rows = await p.evaluate(() => [...document.querySelectorAll("#dfeed .msg")].map(m => ({
  cls: m.className, text: m.textContent,
  bg: getComputedStyle(m).backgroundColor,
  headName: m.querySelector(".ah .nm") ? m.querySelector(".ah .nm").textContent : null,
  status: m.querySelector(".ah .st") ? m.querySelector(".ah .st").textContent : null,
  statusColored: m.querySelector(".ah .st.bad") != null,
  mh: [...m.querySelectorAll(".mh")].map(e => e.textContent), code: !!m.querySelector("code"),
  pre: m.querySelector("pre") ? m.querySelector("pre").textContent : null,
  divs: m.querySelectorAll("div div").length,
})));
console.log("rows rendered:", rows.length);
for (const r of rows) console.log("   ", JSON.stringify(r.cls), "|", JSON.stringify(r.text.slice(0, 64)));

const card = rows.find(r => r.cls.includes("agent"));
const userRow = rows.find(r => r.cls.includes("user") && r.text.includes("&lt;div&gt;"));
const cmdRow = rows.find(r => r.cls.includes("cmd"));
const control = rows.find(r => r.cls.includes("user") && r.text.includes("task-notification"));
const seen = t => TAGS.filter(g => t.includes(g));

console.log("");
chk(!!card, "the notification renders as .msg.agent, not as the owner's bubble");
chk(card && seen(card.text).length === 0, `zero payload markup visible in the card${card ? " (found: " + JSON.stringify(seen(card.text)) + ")" : ""}`);
chk(card && card.headName === "Agent · Parse CLI working line into feed", `header names the agent (got ${JSON.stringify(card && card.headName)})`);
chk(card && card.status === "completed" && !card.statusColored, "status is stated, and not coloured when it is the expected one");
// The card body takes BLOCK markdown too — an agent report is a structured document. Headings lose
// their hashes and bullets become real bullets; inline md is unchanged.
chk(card && card.code, "inline markdown still renders in the card (code span)");
chk(card && card.mh.length === 1 && card.mh[0] === "Conclusion" && !card.text.includes("## "),
  `the heading renders as a heading, hashes gone (got ${card ? JSON.stringify(card.mh) : "no card"})`);
chk(card && card.text.includes("• one") && card.text.includes("• two") && !card.text.includes("- one"),
  "list markers render as bullets");
// Fenced code is split out before the line rules, so a shell comment stays a shell comment.
chk(card && card.pre && card.pre.includes("# not a heading") && card.pre.includes("- not a bullet"),
  `inside a code fence, # and - are left alone (${card ? JSON.stringify(card.pre) : "no card"})`);
// LEAK CONTROL: the widening is scoped to the card. An assistant reply with the same two constructs
// must be byte-identical to today — if this row ever renders a heading, md() itself was widened.
const asst = rows.find(r => r.cls.includes("assistant"));
chk(asst && asst.mh.length === 0 && asst.text.includes("## x") && asst.text.includes("- y"),
  `CONTROL — an assistant reply still renders ## and - literally (${asst ? JSON.stringify(asst.text.trim().slice(0, 12)) : "missing"})`);
// The three voices must be three different fills. Blue for the user is today's value, unchanged.
chk(userRow && userRow.bg === "rgb(82, 136, 193)", `a genuine user message keeps today's blue (${userRow && userRow.bg})`);
chk(card && card.bg === "rgb(35, 46, 60)", `the card takes the raised surface (${card && card.bg})`);
const asstBg = await p.evaluate(() => getComputedStyle(document.querySelector("#dfeed .msg.cmd") || document.body).backgroundColor);
chk(card && userRow && card.bg !== userRow.bg && card.bg !== asstBg, "three distinct treatments — user fill, agent fill, unbubbled");
chk(userRow && userRow.text.trim().startsWith(TYPED) && userRow.divs === 0,
  "a user who TYPES entity text still sees those characters, and no tag is built from them");
chk(!!cmdRow && cmdRow.text === "Set model to claude-opus-4-8", `slash output renders as a command line (${cmdRow && JSON.stringify(cmdRow.text)})`);
// CONTROL: this row was never parsed. It must come back dirty, or the detector above proves nothing.
chk(control && seen(control.text).length >= 5,
  `CONTROL (unparsed row) — the checks DO see raw markup when it is there: ${control ? seen(control.text).length : 0} tags`);

// Contrast of the header on its own fill. CLAUDE.md records that --hint on the raised surface falls
// to 3.94:1 at 12px, which is why the card uses --hint-raised; that is a number, so it is measured.
for (const [name, vars] of [["dark", null], ["light", LIGHT]]) {
  const pg = name === "dark" ? p : await open(b, vars);
  const r = await pg.evaluate(() => {
    const el = document.querySelector("#dfeed .msg.agent .ah .lb");
    // A color-mix() resolves to `color(srgb 0.58 0.62 0.67)` — 0-1 floats, NOT the 0-255 of rgb().
    // Dividing those by 255 reported 1.52:1 for a line that measures 5.15:1, which is the shape of
    // instrument bug README rule 1 is about: a plausible number in the direction you feared.
    const lum = c => { const raw = c.match(/[\d.]+/g).slice(0, 3).map(Number);
      const [r, g, b] = raw.map(v => (c.startsWith("color(") ? v : v / 255))
        .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const fg = lum(getComputedStyle(el).color), bg = lum(getComputedStyle(el.closest(".msg")).backgroundColor);
    return +(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05))).toFixed(2);
  });
  // KNOWN-TRUTH CONTROL for this instrument: CLAUDE.md records plain --hint on the raised surface
  // at 3.94:1, which is why --hint-raised exists. The meter has to reproduce that number before its
  // reading of the real line means anything.
  if (name === "dark") {
    const ctl = await pg.evaluate(() => {
      const el = document.querySelector("#dfeed .msg.agent .ah .lb");
      el.style.color = getComputedStyle(document.documentElement).getPropertyValue("--hint");
      const lum = c => { const raw = c.match(/[\d.]+/g).slice(0, 3).map(Number);
        const [r, g, b] = raw.map(v => (c.startsWith("color(") ? v : v / 255))
          .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const fg = lum(getComputedStyle(el).color), bg = lum(getComputedStyle(el.closest(".msg")).backgroundColor);
      el.style.color = "";
      return +(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05))).toFixed(2);
    });
    chk(Math.abs(ctl - 3.94) < 0.05, `CONTROL — the meter reproduces the documented 3.94:1 for plain --hint on this fill (${ctl}:1)`);
  }
  // 4.5:1 is AA for body text; this line is 12px meta, so the bar applies in full.
  chk(r >= 4.5, `header contrast on the card, ${name} theme: ${r}:1`);
  if (pg !== p) await pg.close();
}

await b.close();
console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
