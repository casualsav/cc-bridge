#!/usr/bin/env node
// Render the REAL page against a payload captured from a REAL daemon (live-sessions.mjs), and
// screenshot it. A fixture proves the card renders; this proves the daemon and the card agree —
// the two halves of "it works" that a mounted fixture can never put together.
//
//   node live-sessions.mjs <channel-dir> <port> > live.json
//   node render-payload.mjs live.json out.png [page]
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const [payloadPath, out, page = join(REPO, "webapp", "index.html")] = process.argv.slice(2);
if (!payloadPath || !out) { console.error("usage: render-payload.mjs <payload.json> <out.png> [page]"); process.exit(2) }

const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 } });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + page, { waitUntil: "domcontentloaded" });
// The WHOLE payload is served, not `sessions` alone: the response also carries `usage` and `agents`,
// and a probe that drops them renders a page the daemon never sends.
await p.evaluate(pl => {
  window.api = async u => u.includes("/api/sessions") ? pl : { accounts: [], jobs: [], settings: [], write: false };
  showTab("sessions");
}, payload);
await p.waitForTimeout(600);
await p.screenshot({ path: out, fullPage: true });
for (const s of payload.sessions) console.log(`${s.state.padEnd(11)} ${s.name}  ${s.wait ? JSON.stringify(s.wait) : s.unreported ? JSON.stringify(s.unreported) : ""}`);
for (const a of payload.agents || []) console.log(`${(a.busy ? "busy" : "ready").padEnd(11)} ${a.name}  ${a.kind}/${a.profile}`);
await b.close();
console.log(`→ ${out}`);
