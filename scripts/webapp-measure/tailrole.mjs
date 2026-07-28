import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Does a measure script's answer depend on the ROLE its fixture ends on?
//
//   node tailrole.mjs <script.mjs> [more.mjs ...]      # default: all ten feed-fixture scripts
//
// Most fixtures here build their transcript as `Array.from({length: N}, (_, i) => ({ role: i % 2 ?
// "assistant" : "user", … }))`, and with an even N that always ends on an `assistant` row. workpin
// was once blind exactly there: both its fixtures ended assistant-last, which hid the newest message
// painting UNDER the working pill until a user-last PENDING fixture was added. This asks whether any
// other script carries the same blind spot, by re-running it against a page whose every feed gains
// one trailing short `user` row — the freshly-sent-message ending the alternating idiom never makes.
//
// It answered NO for nine of the ten (see the README). Kept because a refutation without a
// re-runnable instrument is an assertion, and because the next fixture added here can be checked in
// one command.
//
// newest.mjs is the POSITIVE CONTROL and must keep moving: it is the one script whose subject IS the
// ending role (it owns the newest-reply fold exemption), so the probe replaces the very row it is
// about and 9 of its 13 checks flip — starting with its own fixture-integrity guard. A run in which
// nothing at all moved would not be a refutation, it would be a blind tool.
//
// TWO things about the method, both learned the hard way:
//
//   - The interception is at paintFeed's single `items` read, NOT at window.api. `api` is a top-level
//     function declaration, so its global binding is non-configurable and cannot be wrapped — and
//     wrapping it would be pointless anyway, since every script assigns its own window.api over it.
//   - A script the probe never REACHES prints "identical" for the wrong reason, which reads as a
//     refutation and is not one. grow.mjs builds its rows with innerHTML and sessions.mjs never opens
//     a drill at all; neither renders through paintFeed, so neither can be measured this way. That is
//     reported as UNREACHED, never as a pass.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const HERE = join(REPO, "scripts", "webapp-measure");
const PAGE = join(REPO, "webapp", "index.html");
const OUT = mkdtempSync(join(tmpdir(), "tailrole-"));
const DEFAULT = ["batch5", "bleed", "header", "headerup", "newest", "pinopt", "scrim", "squash", "suite", "workpin"];
const targets = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT;

// The probe page: one expression at the only place a feed render reads its items.
const src = readFileSync(PAGE, "utf8");
const ANCHOR = "  const items = lastDrill ? lastDrill.items : [];";
if (src.split(ANCHOR).length !== 2) { console.error(`paintFeed's items read moved — re-anchor ANCHOR against ${PAGE}`); process.exit(2); }
const probePage = join(OUT, "tail-user.html");
writeFileSync(probePage, src.replace(ANCHOR,
  "  const items = (() => { const a = lastDrill ? lastDrill.items : []; if (!a.length) return a;\n" +
  "    const l = a[a.length - 1], r = { role: 'user', text: 'ok' };\n" +
  "    if ('ts' in l) r.ts = l.ts; if ('at' in l) r.at = l.at; if ('uuid' in l) r.uuid = 'probe-tail';\n" +
  "    return [...a, r]; })();   /* tailrole probe: every feed ends on a freshly-sent user row */"));

// §0 — the probe page must actually append a row before any "identical" below means anything.
{
  const b = await chromium.launch();
  const count = async page => {
    const p = await b.newPage({ viewport: { width: 375, height: 812 } });
    p.on("pageerror", () => {});
    await p.goto("file://" + page, { waitUntil: "domcontentloaded" });
    await p.evaluate(() => {
      window.api = async path => path.includes("feed")
        ? { working: false, items: Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "m" + i, ts: 1785200000000 })) } : {};
      openDrill("x", "x");
    });
    await p.waitForTimeout(600);
    const n = await p.evaluate(() => document.querySelectorAll("#dfeed > .msg").length);
    await p.close(); return n;
  };
  const [plain, probed] = [await count(PAGE), await count(probePage)];
  await b.close();
  if (probed !== plain + 1) { console.error(`[control] probe page did not append a row (${plain} → ${probed}) — nothing below is readable`); process.exit(2); }
  console.log(`[control] probe page appends a trailing user row (${plain} → ${probed} rows)\n`);
}

// A moved VERDICT is the question, not a moved number: appending a row legitimately grows the
// fixture's own reported scroll height (squash prints 2235px → 2269px and still passes). So compare
// on the OK/FAIL status plus the check's label with every digit stripped — an OK→FAIL flip survives
// that, a changed measurement does not.
const verdicts = out => out.split("\n").filter(l => /^(OK|FAIL)/.test(l))
  .map(l => l.replace(/\([^)]*\)/g, "").replace(/[\d.]+/g, "#"));
const run = (script, page) => {
  try { return execFileSync("node", [script, ...(page ? [page] : [])], { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }); }
  catch (e) { return (e.stdout || "") + (e.stderr || ""); }   // a non-zero exit is a result, not a crash
};

let moved = 0;
for (const t of targets) {
  const name = t.replace(/\.mjs$/, ""), script = join(HERE, name + ".mjs");
  const body = readFileSync(script, "utf8");
  // Reached ⟺ the fixture's rows render through paintFeed, i.e. it feeds `items` in through window.api.
  if (!/items/.test(body)) { console.log(`UNREACHED  ${name} — renders no feed through paintFeed; classify it by construction, not by this tool`); continue; }
  const base = verdicts(run(script, name === "pinopt" ? PAGE : ""));
  const tail = verdicts(run(script, probePage));
  if (!base.length) { console.log(`NO CHECKS  ${name} — prints numbers only; diff its output by hand`); continue; }
  const same = base.length === tail.length && base.every((l, i) => l === tail[i]);
  console.log(`${same ? "SAME      " : "MOVED     "} ${name} — ${base.length} checks${same ? "" : `, ${base.filter((l, i) => l !== tail[i]).length} differ`}`);
  if (!same) { moved++; base.forEach((l, i) => { if (l !== tail[i]) console.log(`             - ${l.trim()}\n             + ${(tail[i] || "«missing»").trim()}`); }); }
}

console.log(`\nprobe page: ${probePage}`);
// newest.mjs is expected in the MOVED column — see the positive-control note in the header. Anything
// else landing there is the finding this tool exists for.
console.log(moved ? `${moved} script(s) answer differently on a user-last feed` : "NOTHING moved — check the tool is not blind before reading that as a refutation");
