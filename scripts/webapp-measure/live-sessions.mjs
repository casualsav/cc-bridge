#!/usr/bin/env node
// Read a LIVE daemon's /api/sessions the way the mini app does — signed initData over the local
// loopback port. Read-only by construction: this script only ever GETs, so it can be pointed at a
// running bridge without doing anything to it.
//
//   node live-sessions.mjs <channel-dir> <port> [user-id]
//
// It exists because "the card renders" and "the daemon computes the state" are different claims, and
// a fixture can only ever prove the first. Pipe its output into a page render and both are covered.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const port = process.argv[3];
const user = process.argv[4] || readFileSync(join(dir, "access.json"), "utf8").match(/"(\d{5,})"/)?.[1];
if (!dir || !port || !user) { console.error("usage: live-sessions.mjs <channel-dir> <port> [user-id]"); process.exit(2) }

const token = readFileSync(join(dir, ".env"), "utf8").match(/TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/)?.[1];
if (!token) { console.error(`no TELEGRAM_BOT_TOKEN in ${dir}/.env`); process.exit(2) }

const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(user), first_name: "probe" }) };
const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join("\n");
const secret = createHmac("sha256", "WebAppData").update(token).digest();
const hash = createHmac("sha256", secret).update(dcs).digest("hex");
const p = new URLSearchParams(fields); p.set("hash", hash);

const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `tma ${p}` } });
if (!r.ok) { console.error(`HTTP ${r.status}: ${await r.text()}`); process.exit(1) }
console.log(JSON.stringify(await r.json(), null, 2));
