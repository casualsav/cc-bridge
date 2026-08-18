// cli-exit-signature.ts — what a Claude Code session leaves behind when it ends, by cause.
//
// The 2026-08-18 question: the owner's chat lane and a coding session both stopped inside one
// second, and all either left was a rewritten `last-prompt` record in its transcript — no `/exit`
// entry, no interrupt, no error, and (measured) no deletion of its `<config dir>/sessions/<pid>.json`
// record. That is a signature, and a signature is only evidence once you know what the alternatives
// look like. So: stage each ending deliberately and read the same three instruments.
//
//   bun scripts/cli-exit-signature.ts
//
// Two probe panes on the DEFAULT tmux server — unstamped, so `findOffMcpPanes` (which counts only
// panes carrying the instance's `@telegram` option) cannot see them, exactly as the week-old
// `hprobe` session has sat there untouched. Cleanup kills THESE SESSIONS BY NAME: never
// `kill-server` here, the owner's whole fleet is on this socket.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const tmux = (...a: string[]) => spawnSync('tmux', a, { encoding: 'utf8' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const SESSIONS = join(homedir(), '.claude', 'sessions')

type Probe = { name: string; pane: string; dir: string; transcript: string; record: string | null }

function newestTranscript(projectDir: string): string | null {
  try {
    const rows = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f: join(projectDir, f), t: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    return rows[0]?.f ?? null
  } catch { return null }
}
// The CLI's own live-session record, found by the pane it names rather than by pid — the pane is the
// one identifier this script already holds.
function recordForPane(pane: string): string | null {
  try {
    for (const f of readdirSync(SESSIONS)) {
      if (!f.endsWith('.json')) continue
      const p = join(SESSIONS, f)
      if (readFileSync(p, 'utf8').includes(`"${pane}"`)) return p
    }
  } catch {}
  return null
}
const lastRecords = (file: string, n = 3): string[] => {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-n).map(l => {
      try { const d = JSON.parse(l) as Record<string, unknown>; return `${d.type}${d.subtype ? `/${d.subtype}` : ''}${d.timestamp ? ` @${d.timestamp}` : ''}` }
      catch { return '<unparseable>' }
    })
  } catch { return ['<unreadable>'] }
}

async function start(name: string): Promise<Probe | null> {
  const dir = `/tmp/cc-exit-probe-${name}`
  mkdirSync(dir, { recursive: true })
  tmux('kill-session', '-t', name)
  const pane = tmux('new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}', '-c', dir, '-x', '200', '-y', '50',
    'claude --allow-dangerously-skip-permissions --model haiku').stdout?.trim() ?? ''
  if (!pane) return null
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const c = tmux('capture-pane', '-p', '-t', pane).stdout ?? ''
    if (/Yes, I trust this folder/.test(c)) { tmux('send-keys', '-t', pane, 'Enter'); continue }
    if (/^❯/m.test(c)) break
  }
  // One real turn, so the transcript holds a completed exchange — the state both dead sessions were
  // in. A transcript with nothing in it would end differently for reasons that are not the ending.
  tmux('set-buffer', '-b', `${name}buf`, '--', 'Reply with the single word: ok')
  tmux('paste-buffer', '-d', '-p', '-b', `${name}buf`, '-t', pane)
  await sleep(1200)
  tmux('send-keys', '-t', pane, 'Enter')
  await sleep(20_000)
  const projectDir = join(homedir(), '.claude', 'projects', dir.replace(/\//g, '-'))
  const transcript = newestTranscript(projectDir)
  if (!transcript) { console.log(`${name}: no transcript under ${projectDir}`); return null }
  return { name, pane, dir, transcript, record: recordForPane(pane) }
}

async function report(p: Probe, how: string): Promise<void> {
  const before = { mtime: statSync(p.transcript).mtimeMs, last: lastRecords(p.transcript), record: p.record && existsSync(p.record) }
  console.log(`\n── ${p.name}: ending it by ${how} ──`)
  console.log(`   before: last records ${JSON.stringify(before.last)}`)
  console.log(`   before: session record present ${before.record}`)
  if (how === '/exit') {
    tmux('set-buffer', '-b', `${p.name}x`, '--', '/exit')
    tmux('paste-buffer', '-d', '-p', '-b', `${p.name}x`, '-t', p.pane)
    await sleep(800); tmux('send-keys', '-t', p.pane, 'Enter')
  } else {
    tmux('kill-pane', '-t', p.pane)      // SIGHUP to the pane's process group — what a killed window does
  }
  await sleep(8000)
  const after = { mtime: statSync(p.transcript).mtimeMs, last: lastRecords(p.transcript), record: p.record && existsSync(p.record) }
  console.log(`   after:  transcript rewritten ${after.mtime > before.mtime}`)
  console.log(`   after:  last records ${JSON.stringify(after.last)}`)
  console.log(`   after:  session record still present ${after.record}`)
  tmux('kill-session', '-t', p.name)
}

const a = await start('cc-exitprobe')
if (a) await report(a, '/exit')
const b = await start('cc-hupprobe')
if (b) await report(b, 'tmux kill-pane (SIGHUP)')

console.log('\nThe 2026-08-18 panes left: transcript rewritten (last record `last-prompt`), no /exit')
console.log('entry, no error record, and their session records NOT deleted in that second.')
console.log('Whichever column above matches is how they ended.')
