// transcript-crossadopt-probe.ts — two Claude Code sessions in ONE folder, each asked "which
// transcript is mine?".
//
// The bug it reproduces (2026-08-18): `transcriptForPane`'s fallback is "the newest .jsonl in the
// project dir for this cwd", which has no notion of WHICH session wrote the file. Both guards behind
// it are scoped to one daemon process and one instance's `topics.json`, while the project dir is
// shared — `~/.claude-chat/projects/-srv-chat` hosts every chat lane on this box — so the canary's
// lane adopted the PROD lane's live transcript and relayed two of its replies into the test chat.
//
//   bun scripts/transcript-crossadopt-probe.ts [--cache <dir>]
//
// Against the CHECKOUT each pane must resolve to its OWN conversation (rc 0). Against a DEPLOYED
// plugin-cache copy the same probe must resolve both panes to the same newest file (rc 1) — that
// failure IS the reproduction, and it is what makes this an instrument rather than a description.
//
// Ground truth is not the record it is testing: each pane is made to say a unique word, and a
// resolution is only accepted if the file it returns carries THAT pane's word and not its
// neighbour's. Everything runs on a PRIVATE tmux server (`tmux -L crossadopt`), so the bridge daemon
// cannot see, adopt, or be disturbed by these panes.
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argOf = (flag: string) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null }
const SRC = argOf('--cache') ?? join(import.meta.dir, '..')
const { resolveAgentTranscript } = await import(join(SRC, 'agent-transcript.ts'))
const { readRegistryRows, rowForPane, rowIsLive } = await import(join(SRC, 'session-freedom.ts'))
// The deployed build has no record path at all — an undefined import here is the whole finding.
const { recordedTranscript } = await import(join(SRC, 'transcript-owner.ts')) as { recordedTranscript?: Function }

const SOCK = 'crossadopt'
const tmux = (...a: string[]) => spawnSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const CONFIG = join(homedir(), '.claude')
const ROOTS = [join(CONFIG, 'projects')]
const DIR = '/tmp/cc-bridge-crossadopt-probe'
const PROJECT_DIR = join(CONFIG, 'projects', DIR.replace(/[^a-zA-Z0-9]/g, '-'))

// The resolution UNDER TEST, exactly as `transcriptForPane` orders it minus the pane stamp (these
// panes are unstamped on purpose — an unstamped pane is the whole population the fallback serves).
function resolveForPane(pane: string): { file: string | null; how: string } {
  if (recordedTranscript) {
    const row = rowForPane(pane, readRegistryRows([CONFIG]))
    const rec = recordedTranscript(row && rowIsLive(row) ? row : null, existsSync)
    if (rec.kind === 'file') return { file: rec.file, how: 'session record' }
    if (rec.kind === 'unwritten') return { file: null, how: `session record, no file yet (${rec.why})` }
  }
  return { file: resolveAgentTranscript('claude', DIR, ROOTS), how: 'newest-in-dir guess' }
}

async function startPane(name: string, word: string): Promise<string | null> {
  const pane = tmux('new-session', '-d', '-s', name, '-P', '-F', '#{pane_id}', '-c', DIR, '-x', '200', '-y', '50',
    'claude --allow-dangerously-skip-permissions --model haiku').stdout?.trim() ?? ''
  if (!pane) { console.log(`${name}: tmux would not start a pane`); return null }
  let up = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const c = tmux('capture-pane', '-p', '-t', pane).stdout ?? ''
    if (/Yes, I trust this folder/.test(c)) { tmux('send-keys', '-t', pane, 'Enter'); continue }
    if (/^❯/m.test(c)) { up = true; break }
  }
  if (!up) { console.log(`${name}: never reached a prompt`); return null }
  // One real turn, so this session HAS a conversation on disk with its own word in it.
  tmux('set-buffer', '-b', `${name}buf`, '--', `Reply with the single word: ${word}`)
  tmux('paste-buffer', '-d', '-p', '-b', `${name}buf`, '-t', pane)
  await sleep(1200)
  tmux('send-keys', '-t', pane, 'Enter')
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    try {
      if (readdirSync(PROJECT_DIR).some(f => f.endsWith('.jsonl') && readFileSync(join(PROJECT_DIR, f), 'utf8').includes(word))) break
    } catch {}   // the project dir does not exist until the first turn is written
  }
  return pane
}

const carries = (file: string, word: string): boolean => {
  try { return readFileSync(file, 'utf8').includes(word) } catch { return false }
}

tmux('kill-server')
rmSync(DIR, { recursive: true, force: true })
rmSync(PROJECT_DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

console.log(`resolving with: ${SRC}`)
const A = await startPane('crossadoptA', 'PROBEWORDALPHA')
const B = A ? await startPane('crossadoptB', 'PROBEWORDBETA') : null

let rc = 1
if (A && B) {
  const files = readdirSync(PROJECT_DIR).filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f, mt: statSync(join(PROJECT_DIR, f)).mtimeMs })).sort((x, y) => y.mt - x.mt)
  console.log(`\n${PROJECT_DIR} holds ${files.length} conversation(s): ${files.map(x => x.f).join(', ')}`)
  console.log(`the newest-in-dir guess answers ${files[0]?.f ?? '-'} for BOTH panes, by construction\n`)

  const rA = resolveForPane(A), rB = resolveForPane(B)
  for (const [pane, r, word] of [[A, rA, 'PROBEWORDALPHA'], [B, rB, 'PROBEWORDBETA']] as const) {
    const ok = !!r.file && carries(r.file, word)
    console.log(`  pane ${pane} (${word}) → ${r.file ?? 'null'}  [${r.how}]  carries its own word: ${ok}`)
  }
  const distinct = !!rA.file && !!rB.file && rA.file !== rB.file
  const ownA = !!rA.file && carries(rA.file, 'PROBEWORDALPHA') && !carries(rA.file, 'PROBEWORDBETA')
  const ownB = !!rB.file && carries(rB.file, 'PROBEWORDBETA') && !carries(rB.file, 'PROBEWORDALPHA')
  rc = distinct && ownA && ownB ? 0 : 1
  console.log(`\n${rc === 0
    ? 'PASS — each pane resolved to its OWN conversation.'
    : 'FAIL — the two panes do not each resolve to their own conversation. That is the cross-adoption: whichever session wrote last owns both panes.'}`)
}

tmux('kill-session', '-t', 'crossadoptA')
tmux('kill-session', '-t', 'crossadoptB')
tmux('kill-server')
process.exit(rc)
