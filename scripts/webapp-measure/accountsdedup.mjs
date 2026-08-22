// The Mini App's 👤 Accounts sheet renders ACCOUNTS, not config dirs.
//
// The payload below is the live one: the values were read off this box's running daemon via
// `tg providers` (same projection, same endpoint data), so the fixture cannot drift into agreeing
// with a frontend that groups on its own. What this script proves is the RENDER — that one row
// carries the shared subscription, that it is first, and that no second row exists for the profile
// folded into it. Against the pre-grouping payload the same assertions report 4 rows and fail.
//
// v0.5.213: the row's per-row "Default for: Chat / Coding" pair is retired. A row is a subscription
// and a role binds to a config DIR, so those buttons could not name what they wrote — which is this
// script's own subject, arriving on the control side. The role's account is one select over
// `roleOptions` under the role tab, and THAT is what must still resolve to a real dir here.
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
    { id: "claude:main", provider: "claude", providerLabel: "Claude native", label: "suchag@gmail.com · Max 20x (main, chat)", auth: "native", authLabel: "Native login", ready: true, state: "in", active: true, order: 0, model: null, models: M, members: [{ name: "main", ready: true }, { name: "chat", ready: true }] },
    { id: "claude:codex", provider: "claude", providerLabel: "Claude native", label: "codex", auth: "native", authLabel: "Native login", ready: false, state: "out", active: true, order: 1, model: null, models: M, members: [{ name: "codex", ready: false }] },
    { id: "gateway:local-codex", provider: "openai", providerLabel: "OpenAI", label: "OpenAI subscription", auth: "oauth", authLabel: "OAuth", ready: true, state: "in", active: true, order: 2, model: "gpt-5.6-sol", models: ["gpt-5.6-sol"], members: [{ name: "local-codex", ready: true }] },
    { id: "gateway:deepseek", provider: "deepseek", providerLabel: "DeepSeek", label: "deepseek", auth: "api-key", authLabel: "API key", ready: true, state: "in", active: true, order: 3, model: "deepseek-v4-flash", models: ["deepseek-v4-flash"], members: [{ name: "deepseek", ready: true }] },
  ],
  // Per CONFIG DIR: the four rows above are three subscriptions and a gateway pair, but a role binds
  // to a dir, so `chat` is an option here and is not a row up there. That asymmetry IS the design.
  roleOptions: [
    { id: "claude:main", label: "main — suchag@gmail.com · Max 20x", ready: true },
    { id: "claude:chat", label: "chat — suchag@gmail.com · Max 20x", ready: true },
    { id: "claude:codex", label: "codex", ready: false },
    { id: "gateway:local-codex", label: "OpenAI subscription", ready: true, model: "gpt-5.6-sol" },
    { id: "gateway:deepseek", label: "deepseek", ready: true, model: "deepseek-v4-flash" },
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
  runsOn: [...document.querySelectorAll("#acctdefaults [data-acc-runs-on] option")].map(o => o.textContent.trim()),
  runsOnPick: document.querySelector("#acctdefaults [data-acc-runs-on]")?.value || "",
}));
console.log(JSON.stringify(got, null, 1));

check(got.rows.length === 4, "one row per account, not per config dir (4 rows for 5 config dirs + gateways)");
check(got.rows[0] === "suchag@gmail.com · Max 20x (main, chat)", "the shared Max 20x subscription is the first row, and names its dirs");
check(!got.rows.some(r => /^(main|chat)$/.test(r)), "neither profile behind it appears as its own row");
check(got.roleTiles[0] === "Chat agent → main — suchag@gmail.com · Max 20x" && got.roleTiles[1] === "Coding agent → main — suchag@gmail.com · Max 20x",
  "both role tiles name the CONFIG DIR the role is bound to, not a vanished id");
// The role's account is ONE control now, over the per-dir list — so `chat`, folded into the row
// above, is still selectable, which is what makes folding the rows safe at all.
check(got.roleButtons === 0, "no row carries a per-row role button any more (v0.5.213)");
check(got.runsOn.length === 5 && got.runsOn.includes("● chat — suchag@gmail.com · Max 20x"),
  "Runs on offers every config dir, the folded one included");
check(got.runsOnPick === "claude:main", "Runs on is preselected on the role's stored dir id");

await page.screenshot({ path: join(OUT, "accounts-sheet.png") });
console.log(`shot → ${join(OUT, "accounts-sheet.png")}`);
await browser.close();
if (bad) process.exit(1);
