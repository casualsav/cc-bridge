import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The working row's scrim must be INVISIBLE with nothing behind it and VISIBLE when a message is.
//
//   node scrim.mjs [page]
//
// Two-sided by construction, which is the whole point: an always-invisible scrim passes the first
// check, an always-painted bar passes the second, and only a correct one passes both. Each state is
// shot twice — once as built, once with `.work::before` killed — and the pair is compared.
//
// Compared on the BACKGROUND, right of the row's own ink. The row's GLYPHS legitimately differ
// between the two builds: a translucent layer underneath switches text from subpixel to grayscale
// antialiasing. That is a few units of colour fringing on the letterforms, not a visible band, and
// including it would fail a correct scrim for the wrong reason.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "scrim-"));

const ts = 1785200000000;
const SESSION = { sid: "abc", name: "cc", alive: true, working: true, cwd: "~/p", model: "Opus 5", effort: "high",
  status: { verb: "Incubating", elapsed: "2m 11s", tokens: "4.7k tokens" } };
const SHORT = { ...SESSION, items: [{ role: "user", text: "hi", ts }] };
const LONG = { ...SESSION, items: Array.from({ length: 16 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  text: `Message ${i + 1}. ` + "Long enough that the transcript overflows several times over. ".repeat(2), ts })) };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

const b = await chromium.launch();

async function shot(feed, killScrim, name, scrollTo) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  if (killScrim) await p.addStyleTag({ content: ".work::before{display:none!important}" });
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed
      : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed, session: SESSION });
  await p.waitForTimeout(1000);
  if (scrollTo != null) { await p.evaluate(v => { document.getElementById("dfeed").scrollTop = v; }, scrollTo); await p.waitForTimeout(400); }
  const row = await p.evaluate(() => { const r = document.querySelector(".work"); return r ? JSON.parse(JSON.stringify(r.getBoundingClientRect())) : null; });
  if (!row) { await p.close(); return null; }
  const clip = { x: 0, y: Math.round(row.top) - 4, width: 375, height: Math.round(row.height) + 8 };
  const buf = await p.screenshot({ clip });
  writeFileSync(join(OUT, name + ".png"), buf);
  await p.close();
  return buf.toString("base64");
}

const shots = {
  emptyWith: await shot(SHORT, false, "empty-with", null),
  emptyWithout: await shot(SHORT, true, "empty-without", null),
  textWith: await shot(LONG, false, "text-with", 900),
  textWithout: await shot(LONG, true, "text-without", 900),
};
check(Object.values(shots).every(Boolean), "the working row rendered in every state (else nothing below means anything)");

// The diff runs in the browser, on a canvas — no image library, and the same engine that drew them.
const page = await b.newPage();
const worst = (a, c) => page.evaluate(async ([a, b]) => {
  const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const px = img => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0); return c.getContext("2d").getImageData(0, 0, img.width, img.height).data; };
  const [pa, pb] = [px(ia), px(ib)];
  const W = ia.width, H = ia.height, x0 = Math.floor(W * 0.70);
  let max = 0;
  for (let y = 0; y < H; y++) for (let x = x0; x < W; x++) {
    const i = (y * W + x) * 4;
    max = Math.max(max, Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]));
  }
  return max;
}, [a, c]);

const idle = await worst(shots.emptyWith, shots.emptyWithout);
const over = await worst(shots.textWith, shots.textWithout);
check(idle <= 12, `with nothing behind it the scrim is invisible (worst channel-sum difference ${idle} of 765)`);
check(over >= 120, `with a message behind it the scrim is doing its job (${over} of 765)`);
check(over > idle * 8, `…and the two states are not the same picture (${over} vs ${idle})`);

await b.close();
console.log(`\nshots: ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
