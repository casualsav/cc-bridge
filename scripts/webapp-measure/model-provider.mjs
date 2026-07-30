import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = resolve(process.argv[2] || join(REPO, "webapp", "index.html"));
const base = {
  sid: "provider-model", name: "Model selector", cwd: "~/projects/cc-bridge",
  alive: true, working: false, state: "idle", model: "gpt-5.6-sol[1m]", effort: "high",
};
const cases = [
  {
    name: "local-codex",
    selector: {
      provider: { kind: "openai-codex", key: "local-codex", label: "OpenAI / Codex" },
      selected: { id: "gpt-5.6-sol", label: "Sol" },
      options: [
        { id: "gpt-5.6-sol", label: "Sol" },
        { id: "gpt-5.6-terra", label: "Terra" },
        { id: "gpt-5.6-luna", label: "Luna" },
      ],
      selectable: true,
    },
    compact: "Sol", title: "Select model",
    rows: ["Sol\ngpt-5.6-sol", "Terra\ngpt-5.6-terra", "Luna\ngpt-5.6-luna"],
  },
  {
    name: "anthropic",
    selector: {
      provider: { kind: "anthropic", key: "anthropic", label: "Anthropic" },
      selected: { id: "opus", label: "Opus" },
      options: [
        { id: "fable", label: "Fable 5" }, { id: "opus", label: "Opus 5" },
        { id: "sonnet", label: "Sonnet 5" }, { id: "haiku", label: "Haiku 4.5" },
      ],
      selectable: true,
    },
    compact: "Opus", title: "Select model", rows: [
      "Fable 5\nFor your toughest challenges", "Opus 5\nFor complex tasks",
      "Sonnet 5\nMost efficient for everyday tasks", "Haiku 4.5\nFastest for quick answers",
    ],
  },
  {
    name: "unknown-gateway",
    selector: {
      provider: { kind: "gateway", key: "other", label: "Gateway · other" },
      selected: { id: "some-model", label: "some-model" },
      options: [{ id: "some-model", label: "some-model" }], selectable: false,
    },
    compact: "some-model", title: "Select model", rows: [],
  },
];

let bad = 0;
const check = (ok, label) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) bad++;
};
const browser = await chromium.launch();
for (const c of cases) {
  const page = await browser.newPage({ viewport: { width: 390, height: 812 } });
  page.on("pageerror", e => { console.log(`PAGEERROR ${c.name}: ${e.message}`); bad++; });
  await page.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ session, selector }) => {
    const feed = { ...session, items: [], modelSelector: selector };
    window.api = async u => u.includes("/api/session/feed") ? feed : {};
    await openDrill(session.sid, session.name);
  }, { session: { ...base, model: c.name === "anthropic" ? "Opus 5" : base.model }, selector: c.selector });
  await page.click("#ddialm");
  const got = await page.evaluate(() => ({
    compact: document.querySelector("#ddialm")?.textContent?.trim(),
    title: document.querySelector("#dialp1 .dialhead .t")?.textContent?.trim(),
    rows: [...document.querySelectorAll("#dialmodels .dialrow")].map(row => row.innerText.trim()),
    primitives: [...document.querySelectorAll("#dialmodels .dialrow")].map(row => ({
      cls: row.className, children: [...row.children].map(child => child.tagName + "." + (typeof child.className === "string" ? child.className : child.className.baseVal)),
    })),
  }));
  console.log(`${c.name}: ${JSON.stringify(got)}`);
  check(got.compact === c.compact, `${c.name}: compact label is ${c.compact}`);
  check(got.title === c.title, `${c.name}: the v0.4.292 menu title is unchanged`);
  check(JSON.stringify(got.rows) === JSON.stringify(c.rows), `${c.name}: exact labels, order, and notes use the old row template`);
  check(got.primitives.every(row => /^dialrow(?: on)?$/.test(row.cls) && row.children.join("|") === "SPAN.nm|svg.tick"),
    `${c.name}: every provider uses the same dialrow DOM primitives`);
  await page.close();
}
const source = readFileSync(PAGE, "utf8");
check((source.match(/function dialRow\(/g) || []).length === 1 && (source.match(/function paintDial\(/g) || []).length === 1,
  "Anthropic and Codex share one row template and one menu paint path");

const spawn = await browser.newPage({ viewport: { width: 390, height: 812 } });
await spawn.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await spawn.evaluate(() => {
  window.api = async u => u.includes("/api/settings")
    ? { settings: { spawnModel: { value: "opus" }, spawnEffort: { value: "high" }, prefMode: { value: "Ask", raw: "default" } } }
    : { sessions: [] };
  openSpawnSheet();
});
await spawn.click('#spp1 .dialrow[data-drill="model"]');
const spawnModels = await spawn.locator("#spdetail .dialrow").evaluateAll(rows => rows.map(row => row.dataset.v));
check(JSON.stringify(spawnModels) === JSON.stringify(["fable", "opus", "sonnet", "haiku"]),
  "spawn sheet keeps its four Anthropic coding-session defaults");
await spawn.close();

await browser.close();
if (bad) process.exit(1);
