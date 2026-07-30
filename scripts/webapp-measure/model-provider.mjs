import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
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
    compact: "Sol", title: "Select model · OpenAI / Codex",
    rows: ["Sol\ngpt-5.6-sol", "Terra\ngpt-5.6-terra", "Luna\ngpt-5.6-luna"], disabled: 0,
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
    compact: "Opus", title: "Select model · Anthropic", rows: null, disabled: 0,
  },
  {
    name: "unknown-gateway",
    selector: {
      provider: { kind: "gateway", key: "other", label: "Gateway · other" },
      selected: { id: "some-model", label: "some-model" },
      options: [{ id: "some-model", label: "some-model" }], selectable: false,
    },
    compact: "some-model", title: "Select model · Gateway · other",
    rows: ["some-model\nsome-model"], disabled: 1,
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
    title: document.querySelector("#dialtitle")?.textContent?.trim(),
    rows: [...document.querySelectorAll("#dialmodels .dialrow")].map(row => row.innerText.trim()),
    disabled: document.querySelectorAll("#dialmodels .dialrow:disabled").length,
  }));
  console.log(`${c.name}: ${JSON.stringify(got)}`);
  check(got.compact === c.compact, `${c.name}: compact label is ${c.compact}`);
  check(got.title === c.title, `${c.name}: provider is visible in the menu title`);
  check(got.disabled === c.disabled, `${c.name}: actionability follows the server selector`);
  if (c.rows) check(JSON.stringify(got.rows) === JSON.stringify(c.rows), `${c.name}: menu rows come from the server catalog`);
  else check(got.rows.length === 4 && got.rows.every(row => !row.includes("gpt-")), `${c.name}: native four-model menu remains native`);
  await page.close();
}

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
