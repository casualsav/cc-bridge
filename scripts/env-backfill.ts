#!/usr/bin/env bun
// Add keys a channel's `.env` is MISSING, without touching any it already has.
//
// Why this exists: a `.env` written by hand (or by an older path) can omit a key the daemon needs,
// and the omission is silent. `TELEGRAM_TRANSCRIPT_OUTBOUND` is the one that bit us on 2026-07-28 —
// absent, the daemon runs with pane discovery off, so every session reads "down", /api/sessions is
// empty and nothing relays, with no error anywhere. `/telegram:configure` calls this so a status
// check repairs the gap instead of just describing it.
//
//   bun scripts/env-backfill.ts [channel-dir] [--write]
//
// Dry by default: it prints what it WOULD add. `--write` applies. Never overwrites an existing
// value — a key that is present, even set to something surprising, is somebody's decision.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// slice(2), not a scan of argv: argv[0] is the bun binary and its path contains slashes, so a
// "looks like a path" test picks the interpreter and silently backfills nothing, somewhere else.
const dir = process.argv.slice(2).find(a => !a.startsWith('--'))
  ?? join(homedir(), '.claude', 'channels', 'telegram')
const write = process.argv.includes('--write')
const envPath = join(dir, '.env')

// Is this box wired for off-MCP (the daemon drives tmux panes) or MCP (sessions register over the
// socket)? It decides whether the mode-defining key BELONGS here at all — writing it into an MCP
// install would silently convert it, which is the opposite of a repair. Read from the same place
// the installer writes: a SessionStart hook that brings up ensure-daemon.
function offMcpWired(): boolean {
  try {
    const s = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')
    return /ensure-daemon/.test(s)
  } catch { return false }
}

// key → [default, mode-defining?]. Mode-defining keys are only written when the box is wired for
// that mode; everything else is a plain default that changes no behaviour by being written.
const BACKFILL: Record<string, { value: string; offMcpOnly?: true; why: string }> = {
  TELEGRAM_TRANSCRIPT_OUTBOUND: { value: '1', offMcpOnly: true,
    why: 'without it the daemon never discovers panes: every session reads "down" and nothing relays' },
  TELEGRAM_TRANSCRIBE: { value: 'off',
    why: 'absent already means off; writing it makes the file say so' },
}

if (!existsSync(envPath)) { console.log(`no .env at ${envPath} — nothing to backfill (run /telegram:configure <token> first)`); process.exit(0) }
const body = readFileSync(envPath, 'utf8')
const has = (k: string) => new RegExp(`^\\s*${k}\\s*=`, 'm').test(body)
const offMcp = offMcpWired()

const added: string[] = []
const skipped: string[] = []
for (const [key, spec] of Object.entries(BACKFILL)) {
  if (has(key)) { console.log(`  ok      ${key} — already set, untouched`); continue }
  if (spec.offMcpOnly && !offMcp) {
    skipped.push(key)
    console.log(`  SKIP    ${key} — missing, but this box is not wired for off-MCP; writing it would change the mode, not repair it`)
    continue
  }
  added.push(`${key}=${spec.value}`)
  console.log(`  ${write ? 'ADD ' : 'WOULD'}    ${key}=${spec.value} — ${spec.why}`)
}

if (added.length && write) {
  writeFileSync(envPath, body.replace(/\n*$/, '\n') + added.join('\n') + '\n')
  console.log(`\nwrote ${added.length} key(s) to ${envPath}`)
} else if (added.length) {
  console.log(`\n${added.length} key(s) missing — re-run with --write to add them`)
} else {
  console.log(`\nnothing to backfill${skipped.length ? ` (${skipped.length} skipped by mode)` : ''}`)
}
