#!/usr/bin/env bun
// Would the auto-refresh sweep restart this session? Run the REAL predicate over REAL panes.
//
// The seam rule (refresh-seam.ts, owner's ruling 2026-08-20) is the one gate whose mistakes cost
// money, and its inputs come off a live terminal — a statusline that may not be painted, a transcript
// that may not resolve. So it gets an instrument that reads actual panes rather than a unit test's
// idea of them, the same way `session-freedom-probe.ts` does for the delivery veto.
//
//   bun scripts/refresh-seam-probe.ts              every bridged pane
//   bun scripts/refresh-seam-probe.ts %235         one pane
//
// It TYPES NOTHING and restarts nothing. The two rows to look for:
//   REFRESH  — a clean seam: fresh spawn, or just cleared
//   HOLD     — has context; the sweep must leave it alone
//
// The conversation is read from the CLI's OWN RECORD — the same `recordedTranscript` the daemon uses,
// never the pane's `@tg_transcript` stamp. A `/clear` mints a new conversation and re-stamps only at
// the next UserPromptSubmit, so the stamp can name a conversation the session has already discarded:
// measured live 2026-08-20, which is what sent the first version of this rule back.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { planRefreshSeam } from '../refresh-seam.ts'
import { recordedTranscript } from '../transcript-owner.ts'
import { readRegistryRows, rowForPane, rowIsLive } from '../session-freedom.ts'
import { contextPct } from '../status-card.ts'
import { parseStatusline } from '../statusline.ts'
import { latestFinalReply } from '../transcript.ts'

const sh = (args: string[]): string => {
  try { return execFileSync('tmux', args, { encoding: 'utf8' }) } catch { return '' }
}

// Every config dir the bridge launches into — @chat lives under ~/.claude-chat, so one dir is not
// the fleet. Mirrors the daemon's `listAccounts().map(a => a.configDir)` without importing it.
const CONFIG_DIRS = [process.env.HOME + '/.claude', process.env.HOME + '/.claude-chat'].filter(existsSync)

const panes = process.argv[2]
  ? [process.argv[2]]
  : sh(['list-panes', '-a', '-F', '#{pane_id}\t#{@tg_session}'])
      .split('\n').filter(l => l.includes('\t') && l.split('\t')[1]).map(l => l.split('\t')[0])

if (!panes.length) { console.log('no bridged panes found'); process.exit(0) }

let refresh = 0, hold = 0
for (const pane of panes) {
  const cap = sh(['capture-pane', '-p', '-t', pane])
  const row = rowForPane(pane, readRegistryRows(CONFIG_DIRS))
  const rec = recordedTranscript(row && rowIsLive(row) ? row : null, existsSync)
  const conversation = rec.kind === 'file' ? (latestFinalReply(rec.file) ? 'loaded' as const : 'empty' as const)
    : rec.kind === 'unwritten' ? 'unwritten' as const : 'unknown' as const
  const sl = cap ? parseStatusline(cap) : null
  const evidence = { conversation, ctxPct: contextPct(sl, rec.kind === 'file' ? rec.file : null) }
  const v = planRefreshSeam(evidence)
  const name = sh(['display-message', '-p', '-t', pane, '#{pane_title}']).trim() || pane
  if (v.refresh) refresh++; else hold++
  console.log(
    `${v.refresh ? 'REFRESH' : 'HOLD   '} ${pane.padEnd(6)} ${(sl?.model ?? '?').padEnd(10)} `
    + `conversation=${evidence.conversation.padEnd(9)} `
    + `ctx=${evidence.ctxPct == null ? 'unreadable' : evidence.ctxPct + '%'}`
    + (v.refresh ? '' : `  — ${v.why}`)
    + `   [${name.slice(0, 40)}]`,
  )
}
console.log(`\n${refresh} at a clean seam, ${hold} holding context.`)
