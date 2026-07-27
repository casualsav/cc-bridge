import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// A local slash command in the feed: its invocation over its own output, as ONE row, in prose.
//
// Like agentcard.mjs, the items are NOT hand-written: a fixture transcript goes through the real
// recentConversation, so a parse or a fold that regressed shows up here as it would on the phone.
// Every stdout string below is a real <local-command-stdout> body from this box's transcripts.
//
// The known-truth control (README rule 1) is the LAST row: one <local-command-stdout> appended after
// the parse, still carrying its escapes, exactly as the old code passed them through. The leak check
// MUST report it. If the control comes back clean the detector is broken and every OK above is void.
// Run against a pre-fix copy of the page and every check here has to fail:  node slashcmd.mjs old.html

const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
                "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };
// import.meta.dir is Bun-only and these scripts run under node — see the README.
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "slashcmd-"));

// `[1m]` is the 1-million-context suffix in a model id, and it is NOT an escape. The obvious strip
// (/\[[0-9;]*m/, no ESC required) eats it and renames the model in the one message whose job is to
// say which model you are on. This row is the control for that.
const MODEL_ID = "Set permissionMode to \x1b[1mauto\x1b[22m\nSet model to \x1b[1mopus[1m] (claude-opus-4-8[1m])\x1b[22m";
const MODEL = "Set model to \x1b[1mFable 5\x1b[22m and saved as your default for new sessions";
const MODEL_MULTI = "Set model to \x1b[1mFable 5\x1b[22m and saved as your default for new sessions\x1b[2m\n\x1b[2m     .claude/settings.json pins \x1b[1mOpus 5\x1b[22m\x1b[2m - that applies on restart\x1b[22m";
const COMPACT = "\x1b[2mCompacted (ctrl+o to see full summary)\x1b[22m";
const CONTEXT = `## Context Usage

**Model:** claude-opus-4-8
**Tokens:** 105.5k / 1m (11%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.4k | 0.2% |
| System tools | 12.3k | 1.2% |
| Messages | 90.8k | 9.1% |`;
// What /context prints on CLI 2.1.220 — captured off a live probe session, colours and all. It is
// NOT a pipe table: it is a two-column layout with an occupancy grid, and the last three rows hold
// their column with whitespace alone once the grid runs out. Proportional type destroys it, so the
// whole block has to land in one <pre>. Only driving a real session surfaced this shape.
const CONTEXT_GRID = " \x1b[1mContext Usage\x1b[22m\n"
  + "\x1b[38;5;244m⛁ \x1b[38;5;246m⛁ ⛀ \x1b[38;5;153m⛀ \x1b[38;5;220m⛁ \x1b[38;5;246m⛶ ⛶ ⛶ \x1b[39m  Sonnet 5\n"
  + "\x1b[38;5;246m⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ \x1b[39m  38.5k/967k tokens (4%)\n"
  + "\x1b[38;5;246m⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛝ ⛝ \x1b[39m  ⛁ Skills: 10k tokens (1.0%)\n"
  + "                    ⛁ Messages: 156 tokens (0.0%)\n"
  + "                    ⛝ Autocompact buffer: 33k tokens (3.4%)\n"
  + "\n\x1b[1mCustom agents\x1b[22m · .claude/agents/\n└ 9 agents · 1.1k tokens";

const dir = mkdtempSync(join(tmpdir(), "slashcmd-fx-"));
const jsonl = join(dir, "session.jsonl");
const entry = (text, uuid) => JSON.stringify({ type: "user", uuid, timestamp: "2026-07-27T10:00:00.000Z", message: { content: text } });
const invoke = (name, uuid) => entry(`<command-name>${name}</command-name><command-args></command-args>`, uuid);
const stdout = (text, uuid) => entry(`<local-command-stdout>${text}</local-command-stdout>`, uuid);
writeFileSync(jsonl, [
  entry("<tg 1>switch to fable and clear</tg>", "u0"),
  invoke("/clear", "u1"),                       // no output at all: the one-line case
  invoke("/model", "u2"), stdout(MODEL, "u3"),  // the fold
  invoke("/model", "u4"), stdout(MODEL_MULTI, "u5"),
  invoke("/permissions", "u6"), stdout(MODEL_ID, "u7"),
  invoke("/context", "u8"), stdout(CONTEXT, "u9"),
  entry("<command-name>/context</command-name><command-args>all</command-args>", "u14"), stdout(CONTEXT_GRID, "u15"),
  invoke("/compact", "u10"), stdout(COMPACT, "u11"),
  entry("<bash-input>git status</bash-input>", "u12"),   // `!` bash keeps its monospace chip
  entry("<bash-stdout>nothing to commit</bash-stdout>", "u13"),
].join("\n") + "\n");
const items = JSON.parse(execFileSync("bun", ["-e",
  `import {recentConversation} from '${REPO}/transcript.ts'; console.log(JSON.stringify(recentConversation(${JSON.stringify(jsonl)}, 20)))`,
], { encoding: "utf8" }).trim());
items.push({ role: "assistant", text: "Done. Running on Fable 5 with a fresh context.", ts: 1785200000000 });
// THE CONTROL, appended after the parse: the payload exactly as the old code passed it through.
items.push({ role: "command", name: "/control", text: MODEL, ts: 1785200000000 });

const SESSION = { sid: "abc", name: "chat", alive: true, cwd: "/srv/chat" };
let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

async function open(b, vars) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  if (vars) await p.evaluate(v => { for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty("--tg-theme-" + k, val); }, vars);
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed
      : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed: { sid: "abc", name: "chat", items }, session: SESSION });
  await p.waitForTimeout(1200);   // README rule 2: idle before reading
  return p;
}

const b = await chromium.launch();
for (const [theme, vars] of [["dark", null], ["light", LIGHT]]) {
  const p = await open(b, vars);
  await p.screenshot({ path: join(OUT, `slashcmd-${theme}.png`) });
  const seen = await p.evaluate(() => {
    const rows = [...document.querySelectorAll("#dfeed .msg")];
    const row = sel => rows.find(r => r.querySelector(".cn")?.textContent === sel);
    const cs = el => el && getComputedStyle(el);
    const ctrl = row("/control");
    const cmds = rows.filter(r => r.classList.contains("command"));
    const bash = rows.find(r => r.classList.contains("cmd"));
    const sub = getComputedStyle(document.documentElement).getPropertyValue("--t-sub").trim();
    return {
      // The leak checks read the PARSED rows only. The control is read separately, and has to leak.
      parsed: rows.filter(r => r !== ctrl).map(r => r.innerText).join("\n"),
      control: ctrl ? ctrl.innerText : "",
      commands: cmds.map(r => r.querySelector(".cn")?.textContent ?? ""),
      // /clear draws its name and NOTHING else — no empty output box under it.
      clearKids: row("/clear")?.children.length ?? -1,
      // The output is prose: it must inherit the page text colour and --t-msg, not --hint/--t-mono.
      out: (o => o && { color: cs(o).color, size: cs(o).fontSize, font: cs(o).fontFamily })(row("/model")?.querySelector(".co")),
      body: (x => x && { color: cs(x).color, size: cs(x).fontSize, font: cs(x).fontFamily })(rows.find(r => r.classList.contains("assistant"))),
      name: (n => n && { color: cs(n).color, size: cs(n).fontSize })(row("/model")?.querySelector(".cn")),
      sub,
      // The value the CLI emphasised has to come through as real emphasis.
      bolds: [...(row("/model")?.querySelectorAll("b") ?? [])].map(x => x.textContent),
      // A table keeps its columns: a fenced <pre>, still monospace, inside an otherwise-prose row.
      pre: (pre => pre && { mono: /mono/i.test(cs(pre).fontFamily), text: pre.textContent.trim() })(row("/context")?.querySelector("pre.code")),
      heads: [...(row("/context")?.querySelectorAll("b.mh") ?? [])].map(x => x.textContent),
      // The 2.1.220 grid: one <pre> holding the whole two-column block, its whitespace-held tail
      // included, with the "└ 9 agents" footnote left outside as prose.
      grid: (pre => pre && { mono: /mono/i.test(cs(pre).fontFamily), lines: pre.textContent.replace(/\n$/, "").split("\n").length })(row("/context all")?.querySelector("pre.code")),
      gridFoot: (r => r && !!r.textContent.includes("└ 9 agents") && !r.querySelector("pre.code")?.textContent.includes("└ 9 agents"))(row("/context all")),
      // `!` bash mode must NOT have moved: still monospace, still pushed into the owner's column.
      // margin-left:auto computes to a used px value, so the column is read from geometry.
      bash: bash && { mono: /mono/i.test(cs(bash).fontFamily), left: bash.getBoundingClientRect().left },
      cmdLeft: cmds.length ? Math.max(...cmds.map(r => r.getBoundingClientRect().left)) : -1,
      // The SESSION's column, read off a real reply rather than off #dfeed (whose own padding makes
      // the feed's left edge the wrong reference by 12px).
      asstLeft: (a => a ? a.getBoundingClientRect().left : -1)(rows.find(r => r.classList.contains("assistant"))),
    };
  });
  await p.close();

  // A leaked escape is "[1m" / "[22m" with nothing closing it. The trailing "]" is what tells it
  // apart from a model id's 1-million-context suffix, "opus[1m]" — which must NOT match, or this
  // check would fire on the one string the whole change exists to protect.
  const CSI_FRAGMENT = /\[\d+(;\d+)*m(?!\])/;
  console.log(`\n--- ${theme} ---`);
  check(!/\x1b/.test(seen.parsed), "no raw ESC byte anywhere in the rendered feed");
  check(!CSI_FRAGMENT.test(seen.parsed), "no bare CSI fragment ([1m / [22m) in the rendered feed");
  // Without this the two checks above are unfalsifiable: they would also pass on a page that renders
  // nothing at all.
  check(/\x1b/.test(seen.control) && CSI_FRAGMENT.test(seen.control), "CONTROL: the unparsed row DOES leak, so the two checks above can fail");
  check(seen.parsed.includes("opus[1m] (claude-opus-4-8[1m])"), "CONTROL: the literal [1m] model id survived intact");
  check(seen.commands.join(",") === "/clear,/model,/model,/permissions,/context,/context all,/compact,/control",
    `one row per command, invocation folded with its output  (${seen.commands.join(" ")})`);
  check(seen.clearKids === 1, "/clear renders its name and nothing else");
  check(!!seen.out && !!seen.body && seen.out.color === seen.body.color && seen.out.size === seen.body.size && seen.out.font === seen.body.font,
    `the output reads as prose: same colour/size/face as a reply  (${JSON.stringify(seen.out)})`);
  check(!!seen.name && seen.name.size === seen.sub && seen.name.color !== seen.body?.color,
    `the name line takes the chip's type: --t-sub (${seen.sub}), --hint  (${JSON.stringify(seen.name)})`);
  check(seen.bolds.includes("Fable 5"), `the emphasised value is really bold  (${JSON.stringify(seen.bolds)})`);
  check(!!seen.pre && seen.pre.mono && seen.pre.text.split("\n").length === 5 && seen.pre.text.startsWith("| Category"),
    `/context's table keeps its columns in a mono block  (${JSON.stringify(seen.pre?.text.slice(0, 40))})`);
  check(seen.heads.length === 2, `/context's two headings render as headings  (${JSON.stringify(seen.heads)})`);
  check(!!seen.grid && seen.grid.mono && seen.grid.lines === 5,
    `the live /context grid is ONE mono block, whitespace-held tail included  (${JSON.stringify(seen.grid)})`);
  check(seen.gridFoot === true, "the one-glyph footnote under the grid stays prose, outside the block");
  check(!!seen.bash && seen.bash.mono && seen.bash.left > seen.asstLeft + 1,
    `! bash mode still the mono chip in the owner's column  (${JSON.stringify(seen.bash)})`);
  check(Math.abs(seen.cmdLeft - seen.asstLeft) < 0.5, `no command row sits in the owner's column  (${seen.cmdLeft} vs ${seen.asstLeft})`);
}
await b.close();
console.log(`\n${bad ? `${bad} FAILED` : "all checks passed"} — screenshots in ${OUT}`);
process.exit(bad ? 1 : 0);
