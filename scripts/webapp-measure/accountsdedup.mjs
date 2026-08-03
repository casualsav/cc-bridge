// The Mini App's 👤 Accounts sheet renders ACCOUNTS, not config dirs.
//
// The payload below is the live one: the values were read off this box's running daemon via
// `tg providers` (same projection, same endpoint data), so the fixture cannot drift into agreeing
// with a frontend that groups on its own. What this script proves is the RENDER — that one row
// carries the shared subscription, that it is first, and that no second row exists for the profile
// folded into it. Against the pre-grouping payload the same assertions report 4 rows and fail.
//
//   node accountsdedup.mjs [page] [outdir]
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = resolve(process.argv[2] || join(REPO, "webapp", "index.html"));
const OUT = resolve(process.argv[3] || join(REPO, "scripts", "webapp-measure", "accounts-shots"));
mkdirSync(OUT, { recursive: true });

const M = ["opus", "fable", "sonnet", "haiku"];
const LIVE = {
  auto: true, activeCount: 4, catalog: [{ id: "claude", label: "Claude", auth: ["native"], protocol: "native" }],
  defaults: { chat: "claude:main", code: "claude:main" },
  accounts: [
    { id: "claude:main", provider: "claude", providerLabel: "Claude native", label: "suchag@gmail.com · Max 20x", auth: "native", authLabel: "Native login", ready: true, active: true, order: 0, model: null, models: M, members: ["main", "chat"] },
    { id: "claude:codex", provider: "claude", providerLabel: "Claude native", label: "Claude · codex", auth: "native", authLabel: "Native login", ready: false, active: true, order: 1, model: null, models: M, members: ["codex"] },
    { id: "gateway:local-codex", provider: "openai", providerLabel: "OpenAI", label: "OpenAI subscription", auth: "oauth", authLabel: "OAuth", ready: true, active: true, order: 2, model: "gpt-5.6-sol", models: ["gpt-5.6-sol"], members: ["local-codex"] },
    { id: "gateway:deepseek", provider: "deepseek", providerLabel: "DeepSeek", label: "deepseek", auth: "api-key", authLabel: "API key", ready: true, active: true, order: 3, model: "deepseek-v4-flash", models: ["deepseek-v4-flash"], members: ["deepseek"] },
  ],
};

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"} ${label}`); if (!ok) bad++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 812 } });
page.on("pageerror", e => { console.log(`PAGEERROR: ${e.message}`); bad++; });
await page.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await page.evaluate(async view => {
  window.api = async u => u.includes("/api/provider-accounts") ? view : {};
  await openAccounts();
}, LIVE);
await page.waitForSelector("#accounts.show .acctitem");

const got = await page.evaluate(() => ({
  rows: [...document.querySelectorAll("#accbody .acctitem .acctname")].map(n => n.textContent.trim()),
  roleTiles: [...document.querySelectorAll("#accbody .acctrole")].map(t => t.querySelector(".k").textContent.trim() + " → " + t.querySelector(".v").textContent.trim()),
  roleButtons: [...document.querySelectorAll("#accbody .acctactions button")].filter(b => b.dataset.accDefault).length,
  onButtons: [...document.querySelectorAll("#accbody .acctactions button.on")].map(b => b.dataset.accDefault),
}));
console.log(JSON.stringify(got, null, 1));

check(got.rows.length === 4, "one row per account, not per config dir (4 rows for 5 config dirs + gateways)");
check(got.rows[0] === "suchag@gmail.com · Max 20x", "the shared Max 20x subscription is the first row");
check(!got.rows.some(r => /Claude · (main|chat)$/.test(r)), "neither profile behind it appears as its own row");
check(got.roleTiles[0] === "Chat agent → suchag@gmail.com · Max 20x" && got.roleTiles[1] === "Coding agent → suchag@gmail.com · Max 20x",
  "both role tiles resolve to the account row, not to a vanished profile id");
check(got.onButtons.join(",") === "chat,code", "Chat and Coding are both marked on that one row");
check(got.roleButtons === 8, "every row still carries its two provider buttons");

await page.screenshot({ path: join(OUT, "accounts-sheet.png") });
console.log(`shot → ${join(OUT, "accounts-sheet.png")}`);
await browser.close();
if (bad) process.exit(1);
