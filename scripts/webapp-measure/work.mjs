import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The .work row (last child of #dfeed, painted by paintWork() off lastDrill.status). Stub the fetch
// layer with the EXACT payload the daemon produced, per the theming trap in the README: colours come
// from --tg-theme-* vars, not prefers-color-scheme, so light has to be injected the way themes.mjs does.
const LIGHT = { "bg-color":"#ffffff","secondary-bg-color":"#f1f1f1","text-color":"#000000",
                "hint-color":"#707579","link-color":"#2481cc","button-color":"#2481cc","button-text-color":"#ffffff" };
const FEED = { sid:"eea261db", name:"cc-bridge", working:true,
  cwd:"~/projects/cc-bridge", model:"Opus 5", effort:"high",
  status:{ verb:"Incubating", elapsed:"2m 11s", tokens:"4.7k tokens" },
  items:[
    { role:"user", text:"bring through the token amount and everything on that line", ts:1785200000000 },
    { role:"assistant", text:"Reading the client's feed renderer to place this correctly.", ts:1785200060000 },
  ] };
const NO_STATUS = { ...FEED, status: undefined };
const SESSION = { sid:"eea261db", name:"cc-bridge", alive:true, working:true, cwd:"~/projects/cc-bridge",
  model:"Opus 5", effort:"high" };
const OUT = process.argv[2] || "work";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

async function openPage(b, { vars, feed, reducedMotion }) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", () => {});
  if (reducedMotion) await p.emulateMedia({ reducedMotion: "reduce" });
  await p.goto("file:///home/ubuntu/projects/cc-bridge/webapp/index.html", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(300);
  if (vars) await p.evaluate(v => { for (const [k, val] of Object.entries(v))
    document.documentElement.style.setProperty("--tg-theme-" + k, val); }, vars);
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed
      : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed, session: SESSION });
  await p.waitForTimeout(600);   // idle: let the 3s poll's first paint and the glyph timer settle
  return p;
}

const b = await chromium.launch();

// ---- Known-truth control FIRST (per README rule 1): status absent -> no .work row at all. ----
{
  const p = await openPage(b, { vars: null, feed: NO_STATUS });
  const has = await p.evaluate(() => !!document.querySelector(".work"));
  console.log("CONTROL (status absent) — .work present:", has, has ? "FINDING: renders anyway!" : "OK, absent as expected");
  await p.close();
}

// ---- Reduced motion: glyph must be static, verb/elapsed/tokens still render. ----
{
  const p = await openPage(b, { vars: null, feed: FEED, reducedMotion: true });
  const g0 = await p.locator("#dwork .g").textContent();
  await p.waitForTimeout(500);   // several 130ms glyph-tick intervals, if one were (wrongly) running
  const g1 = await p.locator("#dwork .g").textContent();
  const text = await p.evaluate(() => ({ v: document.querySelector("#dwork .v").textContent,
    m: document.querySelector("#dwork .m").textContent }));
  console.log("REDUCED MOTION — glyph t0:", JSON.stringify(g0), "glyph t1 (+500ms):", JSON.stringify(g1),
    "static:", g0 === g1, "verb:", JSON.stringify(text.v), "meta:", JSON.stringify(text.m));
  await p.close();
}

// ---- Dark + light: full view and cropped view (message-above + .work row) + measurements. ----
for (const [name, vars] of [["dark", null], ["light", LIGHT]]) {
  const p = await openPage(b, { vars, feed: FEED });

  const full = `${OUT}/work-${name}-full.png`;
  await p.screenshot({ path: full });

  const cropRect = await p.evaluate(() => {
    const work = document.getElementById("dwork");
    const msgs = [...document.querySelectorAll("#dfeed .msg")];
    const above = msgs[msgs.length - 1];   // last real message, immediately above .work
    const wr = work.getBoundingClientRect(), ar = above.getBoundingClientRect();
    const x = Math.min(wr.x, ar.x), y = Math.min(wr.y, ar.y);
    const right = Math.max(wr.x + wr.width, ar.x + ar.width);
    const bottom = Math.max(wr.y + wr.height, ar.y + ar.height);
    return { x, y, width: right - x, height: bottom - y };
  });
  const cropped = `${OUT}/work-${name}-crop.png`;
  await p.screenshot({ path: cropped, clip: cropRect });

  const measure = await p.evaluate(() => {
    const work = document.getElementById("dwork");
    const m = document.querySelector("#dwork .m");
    const cs = getComputedStyle(work), ms = getComputedStyle(m);
    const wr = work.getBoundingClientRect();
    const composer = document.querySelector(".composer").getBoundingClientRect();
    const overlap = wr.bottom > composer.top;   // .work's bottom edge crossing the composer's top edge
    return {
      workColor: cs.color, workFontSize: cs.fontSize, workHeight: +wr.height.toFixed(2),
      mFontFamily: ms.fontFamily, mFontVariantNumeric: ms.fontVariantNumeric,
      workBottom: +wr.bottom.toFixed(2), composerTop: +composer.top.toFixed(2), overlap,
    };
  });
  console.log(name.toUpperCase(), JSON.stringify(measure));
  console.log(name, "full:", full, "crop:", cropped, "cropRect:", JSON.stringify(cropRect));
  await p.close();
}

await b.close();
