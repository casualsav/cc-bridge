#!/usr/bin/env node
// A killed session leaves the fleet list even when it was BUSY — the case deadcard.mjs does not cover.
// `tg kill` types /exit, and a session mid-turn does not read that /exit until the turn ends, so the
// pane stays genuinely alive and genuinely working for as long as the tool call runs. The card reads the
// pane, so it kept pulsing green with the killed session's task on it.
//
//   node busykill.mjs
//
// Driven end to end against the LIVE daemon: spawn a probe, give it a ~160s shell loop so it is really
// working, kill it, then poll /api/sessions every second until its row is gone.
//
// Pre-fix control, measured 2026-07-29 on v0.4.253: **37.2s** of `alive:true working:true state:working`
// with the task line "🧑‍💻 Bash for i in $(seq 1 40)…" — the pane died at ~36s (two 8s /exit waits, an esc,
// then `tmux kill-pane`) and the row went with it. Post-fix the row must be gone inside one poll cycle,
// which is what makes the owner's kill land on the card he is looking at.
//
// The control is the same one deadcard.mjs uses and for the same reason: some OTHER live session must
// stay listed throughout, or a filter that drops everything would pass this.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const env = Object.fromEntries(readFileSync("/home/ubuntu/.claude/channels/telegram/.env", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const BASE = `http://127.0.0.1:${env.TELEGRAM_WEBAPP_PORT || "8795"}`;
const OWNER = process.env.BUSYKILL_USER || "837047563";
const NAME = "busykillprobe";

const sh = (c, a) => execFileSync(c, a, { encoding: "utf8" }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++ };
const initData = () => {
  const p = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "busykill",
    user: JSON.stringify({ id: Number(OWNER), first_name: "harness" }) };
  const dcs = Object.keys(p).sort().map(k => `${k}=${p[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
  return new URLSearchParams({ ...p, hash: createHmac("sha256", secret).update(dcs).digest("hex") }).toString();
};
const cards = async () => {
  const r = await fetch(new URL("/api/sessions", BASE), { headers: { Authorization: "tma " + initData() } });
  return (await r.json()).sessions ?? [];
};

sh("mkdir", ["-p", `/tmp/${NAME}`]);
console.log(sh("tg", ["spawn", NAME, "--dir", `/tmp/${NAME}`, "--model", "haiku",
  "Run this exact command with Bash and then report its last line: for i in $(seq 1 40); do echo tick $i; sleep 4; done"]));

let probe = null;
for (let i = 0; i < 25 && !probe; i++) { await sleep(3000); probe = (await cards()).find(s => s.name === NAME) ?? null }
if (!probe) { console.log("FAIL  the probe never reached /api/sessions"); process.exit(1) }
const sid = probe.sid;
// Really working, not merely spawned: the whole point is a kill that arrives mid-turn.
let working = false;
for (let i = 0; i < 40 && !working; i++) { working = !!(await cards()).find(s => s.sid === sid)?.working; if (!working) await sleep(3000) }
check(working, "the probe is genuinely working when the kill arrives");
const control = (await cards()).find(s => s.sid !== sid && s.alive);
if (!control) { console.log("FAIL  no second live session to use as the control"); process.exit(1) }
console.log(`probe sid=${sid} · control "${control.name}" ${control.sid.slice(0, 8)}`);

const t0 = Date.now();
console.log(sh("bash", ["-lc", `tg kill ${NAME} --force`]));
let goneMs = null, activeLookMs = 0, lastActive = null;
for (let i = 0; i < 90 && goneMs === null; i++) {
  const ss = await cards();
  const row = ss.find(s => s.sid === sid);
  const ms = Date.now() - t0;
  if (row) { if (row.working || row.state === "working") { activeLookMs = ms; lastActive = row } }
  else goneMs = ms;
  if (!ss.some(s => s.sid === control.sid && s.alive)) { check(false, `the control left /api/sessions at t+${(ms / 1000).toFixed(1)}s`); break }
  if (goneMs === null) await sleep(1000);
}
const paneLeft = sh("bash", ["-lc", `tmux list-panes -a -F '#{pane_id} #{@tg_session}' | awk '$2 ~ /^${sid}/ {print $1}' | head -1 || true`]) || "gone";
console.log(`row gone after ${goneMs === null ? "NEVER" : (goneMs / 1000).toFixed(1) + "s"} · last active-looking frame at t+${(activeLookMs / 1000).toFixed(1)}s`
  + (lastActive ? ` (${lastActive.state}, task=${JSON.stringify((lastActive.task || "").slice(0, 40))})` : "")
  + ` · pane ${paneLeft === "gone" ? "already gone" : "still up (" + paneLeft + ")"}`);

check(goneMs !== null && goneMs <= 5000, `the killed session's card is gone within one poll (${goneMs === null ? "never" : (goneMs / 1000).toFixed(1) + "s"}, want ≤5s)`);
check(activeLookMs <= 5000, `it never keeps a working look past that (last seen working at t+${(activeLookMs / 1000).toFixed(1)}s)`);
check(!!(await cards()).find(s => s.sid === control.sid && s.alive), "the control card is untouched by the kill");
// The kill itself must still land — a card that merely stops being served while the session runs on
// would pass every check above and be a worse bug than the one this fixes.
for (let i = 0; i < 40 && paneLeft !== "gone"; i++) {
  await sleep(2000);
  if (!sh("bash", ["-lc", `tmux list-panes -a -F '#{pane_id}' | grep -Fx '${paneLeft}' || true`])) break;
}
const paneNow = sh("bash", ["-lc", `tmux list-panes -a -F '#{pane_id}' | grep -Fx '${paneLeft}' || true`]);
check(paneLeft === "gone" || !paneNow, `the pane really did die (${paneLeft === "gone" ? "before the row went" : "after the row went"})`);

console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
