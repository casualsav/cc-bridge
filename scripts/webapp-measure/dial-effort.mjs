import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const repo = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const pagePath = resolve(process.argv[2] || join(repo, "webapp", "index.html"));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.goto("file://" + pagePath, { waitUntil: "domcontentloaded" });
await page.evaluate(async () => {
  const feed = {
    sid: "effort-control", name: "Effort control", cwd: "~/projects/cc-bridge",
    alive: true, working: false, state: "idle", model: "Opus 5", effort: "high", items: [],
    modelSelector: {
      provider: { kind: "anthropic", key: "anthropic", label: "Anthropic" },
      selected: { id: "opus", label: "Opus" }, selectable: true,
      options: [
        { id: "fable", label: "Fable 5" }, { id: "opus", label: "Opus 5" },
        { id: "sonnet", label: "Sonnet 5" }, { id: "haiku", label: "Haiku 4.5" },
      ],
    },
  };
  window.api = async path => path.includes("/api/session/feed") ? feed : {};
  window.fetch = async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  await openDrill(feed.sid, feed.name);
});
await page.click("#ddialm");
await page.waitForTimeout(250);
const geometry = () => page.evaluate(() => {
  const track = document.querySelector("#dial .dialpages");
  const sheet = document.querySelector("#dial .dialsheet");
  const p1 = document.querySelector("#dialp1");
  const p2 = document.querySelector("#dialp2");
  return {
    cls: document.querySelector("#dial").className,
    sheetTop: sheet.getBoundingClientRect().top,
    trackHeight: track.getBoundingClientRect().height,
    p1Height: p1.getBoundingClientRect().height,
    p2Height: p2.getBoundingClientRect().height,
    transition: getComputedStyle(track).transition,
    efforts: [...document.querySelectorAll("#dialefforts .dialrow")].map(row => row.dataset.v),
  };
});
const compact = await geometry();
await page.click("#dialeffort");
await page.waitForTimeout(250);
const raised = await geometry();
await page.click("#dialback");
await page.waitForTimeout(250);
const returned = await geometry();
await page.click("#dialx");
await page.waitForTimeout(200);
const closed = await page.locator("#dial").getAttribute("class");

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"} ${label}`); if (!ok) bad++; };
const near = (a, b, tolerance = 0.6) => Math.abs(a - b) <= tolerance;
check(errors.length === 0, `effort press/back raises no page error (${errors.join(" | ") || "none"})`);
check(raised.cls.includes("p2"), "pressing Effort enters the original raised detail page");
check(raised.efforts.join(",") === "low,medium,high,xhigh,max,auto", "all six original effort levels are exposed in order");
check(near(raised.trackHeight, raised.p2Height), `raised track expands to effort page (${raised.trackHeight.toFixed(2)} vs ${raised.p2Height.toFixed(2)})`);
check(raised.sheetTop < compact.sheetTop, `effort expansion raises the sheet (${compact.sheetTop.toFixed(2)} → ${raised.sheetTop.toFixed(2)})`);
check(!returned.cls.includes("p2"), "pressing back returns to the main model selector");
check(near(returned.trackHeight, returned.p1Height), "back collapses the track to the compact model page");
check(near(returned.sheetTop, compact.sheetTop), `back restores the original compact position (${returned.sheetTop.toFixed(2)} vs ${compact.sheetTop.toFixed(2)})`);
check(returned.transition === compact.transition && returned.transition.includes("height 0.22s"), `one original track transition serves both directions (${returned.transition})`);
check(closed === "", "closing removes every raised/open class after the original delay");
await browser.close();
if (bad) process.exit(1);
