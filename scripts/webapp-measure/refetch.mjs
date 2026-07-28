import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// Per-role probe: when a CLIPPED row is the transcript's last item, what route is there to its rest?
//
//   node refetch.mjs <abs page.html> <label>          (absolute path — file:// needs one)
//
// Two routes exist by design: paintFeed's auto-refetch (assistant-only) and the fold bar's tap. The
// question is whether every role has at least ONE. It is a PROBE, not a check suite — it prints a
// table and exits 0, because it was written to answer "is assistant-only wrong", and that is a
// question about design intent rather than a pass/fail.
//
// WHAT IT ESTABLISHED (v0.4.185):
//   • assistant → auto-refetch, NO fold bar. That is the whole reason the auto-refetch exists and
//     the whole reason it is assistant-only: the newest reply renders UNFOLDED (see bubble()'s
//     `newest`, whose predicate is `role === "assistant"` too), which removes the only control that
//     could fetch the rest. The two are one mechanism read from two places; if they ever disagree,
//     THAT is the bug, not the assistant-only scope.
//   • user, agent → no auto-refetch, but fold bar + tap. Nothing is missing. Extending the auto
//     refetch to them would add a POLL-triggered unbounded read to rows that already have a
//     deliberate one, which is the exact cost CONVO_CAP exists to avoid ("the one unbounded read
//     happens here, on a deliberate tap" — expandFull).
//   • command → no auto-refetch, no data-uuid, no fold bar, no tap: NO ROUTE AT ALL. `bubble()`'s
//     command branch returns before every piece of the fold machinery. The server had prepared for
//     this — `transcript.ts`'s foldCommands keeps the OUTPUT entry's uuid "because the output is the
//     half that can be long enough to clip and be re-fetched" — and the client never wired it.
//     LATENT, NOT ACTIVE: censused every transcript on this box (241 files carrying command output,
//     81 rows with a body) and NOT ONE exceeds the cap. Largest 2244 chars; eleven sit in the 2–4k
//     band, so the margin is one verbose command wide, but it has never fired. If it is ever worth
//     fixing, the fix is to give the command row the FOLD path, never to widen the auto-refetch.
//   • turn → a different mechanism entirely and out of this scope: turn blocks are cut by
//     THOUGHT_MAX, not by the payload clamp, and the item carries no uuid on the wire, so there is
//     nothing to re-fetch BY. Its truncation has no route either, and that is a separate question.
const PAGE = process.argv[2];
const LABEL = process.argv[3] || "page";
const ts = 1785200000000;
const CAP = 4000;
const body = tag => `${tag} `.repeat(30) + "MID-MARKER " + `${tag} `.repeat(700);
const clampd = s => s.slice(0, CAP) + "…";
const FULLTAIL = " …TAIL-ONLY-IN-FULL-COPY";

const SESSION = { sid: "abc", name: "cc", alive: true, working: false, cwd: "~/p", model: "Opus 5", effort: "high" };
const feedOf = items => ({ sid: "abc", name: "cc", working: false, cwd: "~/p", model: "Opus 5", effort: "high", items });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(s => {
  window.__feed = null; window.__fetches = [];
  window.api = async (path, q) => {
    if (path.includes("session/feed")) return window.__feed;
    if (path.includes("session/message")) { window.__fetches.push(q.uuid); return { text: "FULLTEXT" + " …TAIL-ONLY-IN-FULL-COPY" }; }
    if (path.includes("sessions")) return { sessions: [s] };
    return {};
  };
}, SESSION);

console.log(`\n=== ${LABEL} ===`);
console.log("role        | autoRefetch | data-uuid | fold bar | tappable | any route?");
console.log("------------|-------------|-----------|----------|----------|-----------");

for (const role of ["assistant", "user", "agent", "command"]) {
  const txt = body(role.toUpperCase());
  const item = { role, text: clampd(txt), ts, uuid: "u-" + role, clipped: true,
    ...(role === "agent" ? { agent: "worker", status: "completed" } : {}),
    ...(role === "command" ? { name: "/context" } : {}) };
  // A fresh drill per role: openDrill clears autoFull/optimistic, which is what a new case wants.
  await p.evaluate(f => { window.__feed = f; window.__fetches = []; }, feedOf([{ role: "user", text: "earlier", ts }, item]));
  await p.evaluate(() => { autoFull.clear(); for (const k in fullText) delete fullText[k]; openDrill("abc", "cc"); });
  await p.waitForTimeout(900);
  const r = await p.evaluate(() => {
    const rows = [...document.querySelectorAll("#dfeed .msg")];
    const el = rows[rows.length - 1];
    return { fetches: window.__fetches.slice(), uuid: el?.dataset.uuid || null,
      more: !!el?.querySelector(".more"), tap: !!el?.getAttribute("onclick"),
      cls: el ? [...el.classList].filter(c => c !== "msg").join(" ") : null };
  });
  const auto = r.fetches.length > 0;
  const route = auto || (r.more && r.tap);
  console.log(`${role.padEnd(11)} | ${String(auto).padEnd(11)} | ${String(!!r.uuid).padEnd(9)} | ${String(r.more).padEnd(8)} | ${String(r.tap).padEnd(8)} | ${route ? "yes" : "NO — unreachable"}`);
}

// The turn row, which is a different shape entirely: no uuid on the wire, truncated by THOUGHT_MAX
// rather than by the payload clamp, so there is nothing to re-fetch BY.
await p.evaluate(f => { window.__feed = f; window.__fetches = []; },
  feedOf([{ role: "user", text: "earlier", ts },
          { role: "turn", ts, blocks: [{ t: "p", text: "narration ".repeat(500) + "…" }, { t: "chip", label: "Bash ls", calls: [] }] }]));
await p.evaluate(() => { autoFull.clear(); openDrill("abc", "cc"); });
await p.waitForTimeout(900);
const t = await p.evaluate(() => {
  const rows = [...document.querySelectorAll("#dfeed .msg")];
  const el = rows[rows.length - 1];
  return { cls: [...el.classList].filter(c => c !== "msg").join(" "), uuid: el.dataset.uuid || null,
    more: !!el.querySelector(".more"), tap: !!el.getAttribute("onclick"), fetches: window.__fetches.length };
});
console.log(`turn        | ${String(t.fetches > 0).padEnd(11)} | ${String(!!t.uuid).padEnd(9)} | ${String(t.more).padEnd(8)} | ${String(t.tap).padEnd(8)} | ${t.fetches > 0 || (t.more && t.tap) ? "yes" : "n/a — no uuid on the wire, cut by THOUGHT_MAX not the clamp"}`);

await b.close();
