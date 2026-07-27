import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The composer's optimistic working row, and the commands that must NOT open it.
//
// A /clear answers from the client's own state and starts no turn, so no status ever arrives to
// replace the optimistic row and it sat there claiming "Working…" for the full 20s window. The tell
// that this is the OPTIMISTIC row and not a real status: the verb is the bare word "Working…" with
// an EMPTY meta — a real status renders its own verb plus elapsed · tokens.
//
// Both controls are the point. Deleting the row outright would satisfy the /clear check alone, so:
// /compact (real work, and every custom skill command with it) must still open the row, and a feed
// carrying a genuine status must still render its verb and meta.

// Overridable so the must-fail control can point at a pre-fix copy of the page:
//   node slashwork.mjs /tmp/head.html   → every silence check must FAIL there.
const URL = process.argv[2] ? "file://" + process.argv[2] : "file:///home/ubuntu/projects/cc-bridge/webapp/index.html";
const STATUS = { verb: "Incubating", elapsed: "2m 11s", tokens: "4.7k tokens" };

async function open(b, { status } = {}) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.evaluate(status => {
    window.api = async path => path.includes("session/feed")
      ? { sid: "a", name: "n", cwd: "~/p", items: [{ role: "user", text: "hi", ts: 1785200000000 }], ...(status ? { status } : {}) }
      : { sessions: [] };
    window.writeOp = async () => ({ ok: true });   // the send POST, always accepted
    openDrill("a", "n");
  }, status ?? null);
  await p.waitForTimeout(700);
  return p;
}

// What the row says, or null when there is no row at all.
const row = p => p.evaluate(() => {
  const w = document.getElementById("dwork");
  return w ? { verb: w.querySelector(".v").textContent, meta: w.querySelector(".m").textContent } : null;
});
const send = async (p, text) => {
  await p.evaluate(t => { document.getElementById("dtext").value = t; document.getElementById("dsend").click(); }, text);
  await p.waitForTimeout(400);
};

const chk = (ok, msg) => { console.log(ok ? "  OK   " : "  FAIL ", msg); if (!ok) failed++; };
let failed = 0;
const b = await chromium.launch();

for (const cmd of ["/clear", "/model opus", "/effort high", "/status"]) {
  const p = await open(b);
  await send(p, cmd);
  const r0 = await row(p);
  await p.waitForTimeout(4000);             // README rule 2: and the phantom used to survive this
  const r1 = await row(p);
  chk(r0 === null && r1 === null, `${cmd} is silent — no working row at t+0.4s or t+4.4s (got ${JSON.stringify(r0)}, ${JSON.stringify(r1)})`);
  // Not "a .msg exists" — the fixture ships one, so that check could not fail. The COMMAND has to
  // be on screen: silence means no working row, never a send that vanished.
  chk(await p.evaluate(t => [...document.querySelectorAll("#dfeed .msg")].some(m => m.textContent.includes(t)), cmd),
    `${cmd} still echoes into the feed`);
  await p.close();
}

// CONTROL 1: /compact really does work, and so does every custom skill command. Both keep the row.
for (const cmd of ["/compact", "/fable plan this"]) {
  const p = await open(b);
  await send(p, cmd);
  const r = await row(p);
  chk(r !== null && r.verb === "Working…", `CONTROL — ${cmd} still opens the optimistic row (${JSON.stringify(r)})`);
  await p.close();
}

// CONTROL 2: a genuine status renders as it does today — verb and meta, not the bare word. This is
// what a fix that simply deleted the row would fail.
{
  const p = await open(b, { status: STATUS });
  const r = await row(p);
  chk(r !== null && r.verb === "Incubating…" && r.meta === "2m 11s · 4.7k tokens",
    `CONTROL — a real working state is untouched (${JSON.stringify(r)})`);
  await p.close();
}

await b.close();
console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
