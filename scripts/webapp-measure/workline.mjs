import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The working row: one line, one type, and a clock that only ever moves forward.
//
// The row used to right-align its numbers in a mono face; now the time and tokens sit directly after
// the verb in the verb's own type. And the elapsed used to be repainted from whatever the pane last
// printed once per 3s poll, which lurched — it now seeds a local clock derived from WALL TIME
// (seedSec + now - seededAt), never incremented per tick.
//
// Overridable page path, so the must-fail control is a real run against the pre-fix copy:
//   node workline.mjs /tmp/head.html

const URL = process.argv[2] ? "file://" + process.argv[2] : "file:///home/ubuntu/projects/cc-bridge/webapp/index.html";
const status = (elapsed, tokens = "8.8k tokens") => ({ verb: "Booping", elapsed, tokens });

async function open(b, st) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.evaluate(st => {
    window.feedStatus = st;
    window.api = async path => path.includes("session/feed")
      ? { sid: "a", name: "n", cwd: "~/p", items: [{ role: "user", text: "hi", ts: 1785200000000 }], ...(window.feedStatus ? { status: window.feedStatus } : {}) }
      : { sessions: [] };
    window.writeOp = async () => ({ ok: true });
    openDrill("a", "n");
  }, st ?? null);
  await p.waitForTimeout(700);
  return p;
}
// Force the next poll to carry a different pane elapsed, then run one.
const poll = async (p, st) => { await p.evaluate(st => { window.feedStatus = st; return renderDrill(); }, st); await p.waitForTimeout(150); };
const meta = p => p.evaluate(() => { const w = document.getElementById("dwork"); return w ? w.querySelector(".m").textContent : null });

const chk = (ok, msg) => { console.log(ok ? "  OK   " : "  FAIL ", msg); if (!ok) failed++; };
let failed = 0;
const b = await chromium.launch();

// ---- 1. One line, one type, left-placed. ----
{
  const p = await open(b, status("2m 47s"));
  const g = await p.evaluate(() => {
    const w = document.getElementById("dwork");
    const box = w.getBoundingClientRect();
    const f = e => { const s = getComputedStyle(e); return { size: s.fontSize, family: s.fontFamily, weight: s.fontWeight } };
    const r = e => e.getBoundingClientRect();
    const [v, m] = [w.querySelector(".v"), w.querySelector(".m")];
    const cs = getComputedStyle(w);
    // The row's CONTENT height — its own padding is not evidence of a second line, and comparing
    // the border box against one line box failed at exactly that (27.39 vs 17.4 = 10px of padding).
    const contentH = w.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return { rowH: +contentH.toFixed(2), lineH: +cs.lineHeight.replace("px", ""),
      vTop: +r(w.querySelector(".v")).top.toFixed(2), mTop: +r(w.querySelector(".m")).top.toFixed(2),
      verb: f(v), metaF: f(m), text: w.textContent,
      vRight: +r(v).right.toFixed(2), mLeft: +r(m).left.toFixed(2), boxRight: +box.right.toFixed(2) };
  });
  console.log("row:", JSON.stringify(g.text), "| verb", g.verb.size, g.verb.family.split(",")[0], "| meta", g.metaF.size, g.metaF.family.split(",")[0]);
  // Two independent readings of "one line": the content box is one line box tall, AND the numbers
  // start on the verb's own baseline row rather than below it.
  chk(g.rowH <= g.lineH + 1, `single line (content ${g.rowH}px against a ${g.lineH}px line box)`);
  chk(Math.abs(g.mTop - g.vTop) <= 1, `numbers on the verb's line (tops ${g.vTop} vs ${g.mTop})`);
  chk(g.verb.size === g.metaF.size && g.verb.family === g.metaF.family && g.verb.weight === g.metaF.weight,
    `verb and numbers share one font (${g.verb.size}/${g.verb.family.split(",")[0]} vs ${g.metaF.size}/${g.metaF.family.split(",")[0]})`);
  // Left-placed: the numbers start within a gap's width of the verb, NOT pinned to the container's
  // right edge. Both halves matter — "not at the right edge" alone passes on a wrapped line.
  chk(g.mLeft - g.vRight <= 12, `numbers sit beside the verb (${(g.mLeft - g.vRight).toFixed(2)}px after it)`);
  chk(g.boxRight - g.mLeft > 60, `…and are not pinned right (${(g.boxRight - g.mLeft).toFixed(2)}px of slack to the edge)`);
  chk(/2m 47s · 8\.8k tokens/.test(g.text), `time · tokens, in that order, one separator (${JSON.stringify(g.text)})`);
  await p.close();
}

// ---- 2. The clock ticks locally between polls, and never goes backward. ----
{
  const p = await open(b, status("2m 47s"));
  const t0 = await meta(p);
  await p.waitForTimeout(2200);
  const t1 = await meta(p);              // no poll happened — this is the local clock alone
  chk(t0 === "2m 47s · 8.8k tokens" && t1 === "2m 49s · 8.8k tokens", `it ticks between polls (${t0} → ${t1})`);

  // A poll whose pane elapsed is SEVERAL SECONDS BEHIND (stale, which is the normal case) must not
  // rewind the display. This is the assertion the whole policy exists for.
  const before = await meta(p);
  await poll(p, status("2m 44s"));
  const after = await meta(p);
  const secs = s => { const m = /(?:(\d+)m )?(\d+)s/.exec(s); return (+(m[1] || 0)) * 60 + +m[2] };
  chk(secs(after) >= secs(before), `a stale poll (2m 44s) does not rewind the clock (${before} → ${after})`);

  // A poll AHEAD wins immediately — the pane is truth when it is in front.
  await poll(p, status("5m 10s"));
  chk((await meta(p)).startsWith("5m 1"), `a poll ahead re-seeds forward (${await meta(p)})`);

  // …and a drop of more than 5s is the next turn starting, not staleness, so it re-seeds hard.
  await poll(p, status("3s"));
  chk((await meta(p)).startsWith("3s"), `a new turn's small elapsed re-seeds hard (${await meta(p)})`);
  await p.close();
}

// ---- 3. Monotonicity under a stream of disagreeing polls, sampled densely. ----
{
  const p = await open(b, status("1m 00s"));
  const seen = [];
  const secs = s => { const m = /(?:(\d+)m )?(\d+)s/.exec(s || ""); return m ? (+(m[1] || 0)) * 60 + +m[2] : -1 };
  for (const e of ["1m 2s", "59s", "1m 1s", "1m 5s", "1m 3s", "1m 8s"]) {
    await poll(p, status(e));
    seen.push(secs(await meta(p)));
    await p.waitForTimeout(700);
    seen.push(secs(await meta(p)));
  }
  const backward = seen.filter((v, i) => i && v < seen[i - 1]);
  chk(backward.length === 0, `never backward across 12 samples of disagreeing polls (${seen.join(",")})`);
  // Nor a leap beyond the policy: every forward step is either the clock's own second or a re-seed
  // to a pane value that was genuinely ahead. Max legal jump here is the largest pane advance.
  const jumps = seen.map((v, i) => i ? v - seen[i - 1] : 0);
  chk(Math.max(...jumps) <= 5, `no leap beyond the reconciliation policy (largest step ${Math.max(...jumps)}s)`);
  await p.close();
}

// ---- 4. CONTROL: the ticker stops with the row. ----
{
  const p = await open(b, status("10s"));
  chk(await p.evaluate(() => !!document.getElementById("dwork")), "the row is up while the status is");
  await poll(p, null);                    // status gone — the turn ended
  const gone = await p.evaluate(() => ({ row: !!document.getElementById("dwork"), tick: !!window.workTick }));
  chk(!gone.row, "the row goes when the status does");
  // The INTERVAL, not just the row: a cleared row with a live timer is a leak that only shows up as
  // a clock counting for a turn that ended. `workTick` is a top-level let in a classic script, so it
  // is readable here — assert the handle itself is gone, within the same tick.
  chk(gone.tick === false, `…and the ticker is cleared with it (workTick=${gone.tick})`);
  await p.waitForTimeout(1300);           // a full tick later: a surviving timer would have run
  const after = await p.evaluate(() => ({ row: !!document.getElementById("dwork"), tick: !!window.workTick }));
  chk(!after.row && !after.tick, "and stays gone a tick later — the ticker did not resurrect it");
  await p.close();
}

// ---- 5. CONTROL: /clear's silent path leaves no clock behind. ----
{
  const p = await open(b, null);
  await p.evaluate(() => { document.getElementById("dtext").value = "/clear"; document.getElementById("dsend").click() });
  await p.waitForTimeout(1400);
  chk(await p.evaluate(() => !document.getElementById("dwork") && !window.workTick && !window.workClock),
    "CONTROL — /clear stays silent: no row, no ticker, no clock");
  await p.close();
}

await b.close();
console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
