import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Where #viewer sits in the stacking ladder — measured from the PAINT, not from the stylesheet.
//
//   node viewerz.mjs [page] [outdir]
//
// #viewer is `position: fixed; inset: 0` with an opaque --bg and, before this, NO z-index at all —
// so it landed in painting step 8 (positioned, z-index auto) while every surface it is supposed to
// cover landed in step 9: .tabs (2), .newfab (3), #drill (5). A positive z-index outranks `auto`
// however late the element appears in the document, so being last in the body could not save it.
//
// Two things this refutes, both of which read as plausible from the source:
//   - "the viewer paints over the drill by source order" — it does not; the drill paints over IT,
//     and showing the viewer over an open drill changes the screen by exactly 0.00.
//   - "so it is a latent trap" — the drill and .newfab pairings are indeed unreachable today, but
//     .tabs is a body-level sticky nav that showTab() never hides, so it covered the viewer's own
//     header on EVERY file opened from the Files tab. That is the check that matters here.
//
// Measured by render and pixel diff because elementsFromPoint reports HIT order, not paint order —
// and by hit test as well, because the two answer different halves of this: what you can SEE and
// what your tap LANDS on. Here they agreed, and both were wrong.
//
// The instrument validates itself before judging anything (§0): the two surfaces must render
// distinguishable pictures, and a forced `#viewer{z-index:6}` must flip the result — without that,
// "no difference" could equally mean the viewer never rendered. Note that the clean reference for
// "what the viewer looks like on top" is taken WITH that force applied: the unforced viewer is the
// very thing under test, so using it as its own reference would hide the defect.
//
// Every check asserts the FIXED behaviour, so the unfixed page is the falsifying control: pass it
// as [page] and checks 2-6 fail in both themes.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "viewerz-"));
const FORCE = "#viewer{z-index:6}";   // the instrument's known-truth override, never the page's own

const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
  "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };

const ts = 1785200000000;
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge" };
const FEED = { working: false, items: Array.from({ length: 10 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  text: `DRILL LINE ${i + 1} — the chat transcript, which is the picture the drill paints.`, ts })) };
const FILE = { content: Array.from({ length: 40 }, (_, i) => `VIEWER LINE ${i + 1} — the file body.`).join("\n"),
  mtime: ts, binary: false, tooLarge: false, size: 900 };
const LS = { entries: [{ name: "notes.txt", type: "file", size: 900 }], path: "/", write: true };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
const canvas = await b.newPage();

// Whole-frame comparison: mean absolute channel difference, 0-255. Two renders of the same surface
// are 0.00; two different surfaces are whole units apart. Done on a canvas in the same engine that
// drew them rather than with an image library.
const diff = (a, c) => canvas.evaluate(async ([a, b]) => {
  const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const px = img => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0); return c.getContext("2d").getImageData(0, 0, img.width, img.height).data; };
  const [pa, pb] = [px(ia), px(ib)];
  let sum = 0;
  for (let i = 0; i < pa.length; i += 4)
    sum += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
  return +(sum / (pa.length / 4) / 3).toFixed(2);
}, [a, c]);

// One render. `state` names which surfaces are up. The file is opened through showTab("files") →
// openFile(), which is the app's only real route to the viewer — the tab bar's presence is part of
// the state under test, not scenery.
async function open(theme, state, { force, fab } = {}) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", () => {});
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(200);
  if (theme === "light") await p.evaluate(v => {
    for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty("--tg-theme-" + k, val);
    pinChromeColour();   // a fixture that only sets the vars leaves a dark-pinned --bg under light type
  }, LIGHT);
  if (force) await p.addStyleTag({ content: force });
  await p.evaluate(async ({ state, session, feed, file, ls, fab }) => {
    window.api = async path => path.includes("session/feed") ? feed
      : path.includes("/api/read") ? file
      : path.includes("/api/ls") ? ls
      : path.includes("sessions") ? { sessions: [session] } : {};
    if (state.includes("drill")) openDrill(session.sid, session.name);
    if (state.includes("viewer")) { await showTab("files"); await openFile("/home/ubuntu/notes.txt"); }
    // .newfab is static markup toggled by showTab(); the fixture drives the class the same way.
    document.getElementById("newfab").classList.toggle("show", !!fab);
  }, { state, session: SESSION, feed: FEED, file: FILE, ls: LS, fab });
  await p.waitForTimeout(700);
  return p;
}
async function shot(theme, state, name, opts) {
  const p = await open(theme, state, opts);
  const buf = await p.screenshot();
  writeFileSync(join(OUT, `${theme}-${name}.png`), buf);
  await p.close();
  return buf.toString("base64");
}

// §1 — the stylesheet fact. Two comments in the tree (this file's .newfab block and CLAUDE.md) said
// #drill/#viewer were both "z-index 5, opaque"; only the first half was ever true.
{
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  p.on("pageerror", () => {});
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  const z = await p.evaluate(() => {
    const zi = sel => { const e = document.querySelector(sel); const was = e.style.display;
      e.style.display = "block"; const v = getComputedStyle(e).zIndex; e.style.display = was; return v; };
    return { viewer: zi("#viewer"), drill: zi("#drill"), newfab: zi(".newfab"), tabs: zi(".tabs") };
  });
  console.log(`\n  computed z-index — #viewer: ${z.viewer} · #drill: ${z.drill} · .newfab: ${z.newfab} · .tabs: ${z.tabs}\n`);
  check(z.drill === "5" && z.tabs === "2" && z.newfab === "3",
    `the surfaces the viewer must cover are where the ladder says (.tabs ${z.tabs} · .newfab ${z.newfab} · #drill ${z.drill})`);
  const n = parseInt(z.viewer, 10);
  check(Number.isFinite(n), `#viewer declares its place in the ladder instead of falling to auto (z-index ${z.viewer})`);
  check(Number.isFinite(n) && n > 5 && n < 9, `…above #drill (5), below the sheets (9) — ${z.viewer}`);
  await p.close();
}

// §2 — the hit test: what a tap on the viewer's own controls actually reaches. Its sibling below is
// the pixel proof; neither replaces the other, and on the unfixed page both failed.
{
  const p = await open("dark", ["viewer"]);
  const hits = await p.evaluate(() => ["vback", "vdl", "vclose"].map(id => {
    const r = document.getElementById(id).getBoundingClientRect();
    const top = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2)[0];
    return { id, top: top ? (top.id || top.className || top.tagName) : null, own: top ? !!top.closest("#viewer") : false };
  }));
  for (const h of hits)
    check(h.own, `a tap on the viewer's own #${h.id} reaches the viewer, not ${h.top} above it`);
  await p.close();
}

for (const theme of ["dark", "light"]) {
  console.log(`\n— ${theme} —`);
  const drill = await shot(theme, ["drill"], "drill");
  // The clean reference: the viewer with the instrument's own force applied, i.e. what "the viewer
  // is on top" looks like. NOT the unforced viewer, which is the thing under test.
  const ref = await shot(theme, ["viewer"], "viewer-forced", { force: FORCE });

  // §0 — the instrument. Without these two, every number below is unreadable.
  const apart = await diff(drill, ref);
  check(apart > 3, `[control] the two surfaces render distinguishable pictures (${apart} mean channel units apart)`);
  const forcedBoth = await shot(theme, ["drill", "viewer"], "both-forced", { force: FORCE });
  check(await diff(forcedBoth, ref) < 0.05,
    `[control] with the force applied the viewer covers the drill — so a null result below is a real one`);

  // §3 — the tab bar, which is the reachable half: it is up on every file opened from the Files tab.
  const alone = await shot(theme, ["viewer"], "viewer");
  const vsTabs = await diff(alone, ref);
  check(vsTabs < 0.05, `an open file is not overpainted by the tab bar (${vsTabs} — above 0 is the bar showing through)`);

  // §4 — the drill, which is latent: nothing routes to openFile() from a chat today.
  const both = await shot(theme, ["drill", "viewer"], "both");
  const vsRef = await diff(both, ref), vsDrill = await diff(both, drill);
  console.log(`     both-shown vs viewer-on-top: ${vsRef} · vs drill-alone: ${vsDrill}`);
  check(vsRef < 0.05, `opened over the drill, the viewer is what you see (${vsRef} from the viewer on top)`);
  check(vsDrill > 3, `…and the drill is not (${vsDrill} from the drill alone — 0 means showing the viewer changed nothing)`);

  // §5 — the new-session pill, latent for the same reason: showTab() hides it off the Sessions tab.
  const fab = await shot(theme, ["viewer"], "viewer-fab", { fab: true });
  const fabDiff = await diff(fab, alone);
  check(fabDiff < 0.05, `the new-session pill stays under the open viewer (${fabDiff} — above 0 means it paints through)`);
}

await b.close();
console.log(`\nshots: ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
