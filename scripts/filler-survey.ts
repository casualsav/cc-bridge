#!/usr/bin/env bun
// WHAT THE CLI ACTUALLY DOES WITH A TURN THAT PRODUCES NO TEXT — measured, not remembered.
//
// The bridge filters exactly one class of assistant text: the filler a session emits when the CLI
// refuses to let a turn end silently. Every previous attempt at that filter was built on a
// REMEMBERED claim about the CLI ("2.1.225 stopped writing the meta row"), and the claim was wrong
// — a filter built on it dropped a real report to the owner inside an hour. This script is how the
// claim gets re-checked instead: point it at the transcripts on this box and it prints the current
// CLI's behaviour, per version.
//
//   bun scripts/filler-survey.ts                 # every Claude Code transcript root it can find
//   bun scripts/filler-survey.ts ~/.claude ~/.claude-chat
//
// It reads only local transcripts and prints no message content beyond the filler it matched, so it
// is safe to run and paste. Re-run it after any CLI upgrade: if the counts move, the filter in
// transcript.ts (isHarnessNoise) and the fixtures in filler-cli.test.ts are what need revisiting.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const NUDGE_PREFIX = '[Your previous response had no visible output'
const BRACKET = /^\[[^[\]]*\]$/
// The CANDIDATE rule, measured beside the shipped one and shipping nothing: the same shape in
// parentheses. It exists because a chat lane leaked `(no reply needed)` — filler the bracket rule
// cannot see. Whether it becomes real depends on the count below and nothing else: a parenthesised
// one-liner is a likelier REAL reply than a bracketed one, so this rule has to earn its own evidence
// rather than inherit the bracket rule's.
const PAREN = /^\([^()]*\)$/

type Row = { version: string; kind: 'meta-row' | 'echo' | 'bracket-filler' | 'paren-candidate'; text: string; file: string }

function transcriptRoots(argv: string[]): string[] {
  if (argv.length) return argv
  // Every `<config dir>/projects` on this box. A second account (CLAUDE_CONFIG_DIR) is an ordinary
  // sibling directory, so globbing the home dir finds them without naming any of them here.
  return readdirSync(homedir())
    .filter(d => d === '.claude' || d.startsWith('.claude-'))
    .map(d => join(homedir(), d, 'projects'))
    .filter(p => { try { return statSync(p).isDirectory() } catch { return false } })
}

function* transcripts(root: string): Generator<string> {
  let dirs: string[]
  try { dirs = readdirSync(root) } catch { return }
  for (const d of dirs) {
    let files: string[]
    try { files = readdirSync(join(root, d)) } catch { continue }
    for (const f of files) if (f.endsWith('.jsonl')) yield join(root, d, f)
  }
}

const textOf = (c: unknown): string => {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('\n')
}

const rows: Row[] = []
let conclusions = 0
// This box runs probe sessions whose whole job is to end turns without text, and their transcripts sit
// in the same corpus. Counting them would let an instrument's own experiments inflate the evidence it
// produces — 4 of 42 paren matches on the day this was written were exactly that.
const isProbeTranscript = (file: string): boolean => /nudge-probe|-probe[a-z]*\/|scratchpad/.test(file)

for (const root of transcriptRoots(process.argv.slice(2))) {
  for (const file of transcripts(root)) {
    let raw: string
    try { raw = readFileSync(file, 'utf8') } catch { continue }
    if (isProbeTranscript(file)) continue
    if (!raw.includes('no visible output') && !raw.includes('"text":"[') && !raw.includes('"text":"(')) continue
    const entries = raw.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const version = e.version ?? '?'
      const t = textOf(e.message?.content).trim()
      if (!t) continue
      // The CLI's own persisted re-prompt row.
      if (e.type === 'user' && e.isMeta === true && t.startsWith(NUDGE_PREFIX)) {
        rows.push({ version, kind: 'meta-row', text: t, file }); continue
      }
      if (e.type !== 'assistant' || e.isSidechain) continue
      // A TURN CONCLUSION: the next user/assistant entry is not another assistant response.
      const next = entries.slice(i + 1).find((x: any) => x.type === 'user' || x.type === 'assistant')
      if (next && next.type === 'assistant') continue
      conclusions++
      if (t.startsWith(NUDGE_PREFIX)) rows.push({ version, kind: 'echo', text: t, file })
      else if (!t.includes('\n') && BRACKET.test(t)) rows.push({ version, kind: 'bracket-filler', text: t, file })
      else if (t.length <= 280 && !t.includes('\n') && PAREN.test(t)) rows.push({ version, kind: 'paren-candidate', text: t, file })
    }
  }
}

const versions = [...new Set(rows.map(r => r.version))].sort()
const kinds = ['meta-row', 'echo', 'bracket-filler', 'paren-candidate'] as const

const shipped = rows.filter(r => r.kind !== 'paren-candidate')
console.log(`turn-conclusion text blocks scanned: ${conclusions}`)
console.log(`matched by the SHIPPED filter: ${shipped.length} (${(100 * shipped.length / Math.max(1, conclusions)).toFixed(2)}% of conclusions)`)
console.log(`matched by the CANDIDATE paren rule (not filtered today): ${rows.length - shipped.length}\n`)
console.log('CLI version   meta-row   echo   bracket-filler   paren-candidate')
for (const v of versions) {
  const n = (k: typeof kinds[number]) => rows.filter(r => r.version === v && r.kind === k).length
  console.log(`${v.padEnd(13)} ${String(n('meta-row')).padEnd(10)} ${String(n('echo')).padEnd(6)} ${String(n('bracket-filler')).padEnd(16)} ${n('paren-candidate')}`)
}

console.log('\ndistinct filler strings (every one of these is a message a human would have received):')
const distinct = new Map<string, number>()
for (const r of rows) if (r.kind !== 'paren-candidate') distinct.set(r.text, (distinct.get(r.text) ?? 0) + 1)
for (const [text, n] of [...distinct].sort((a, b) => b[1] - a[1])) {
  console.log(`  n=${String(n).padStart(3)}  ${JSON.stringify(text.slice(0, 160))}`)
}

// The CANDIDATE class, listed separately and in full: these are NOT filtered today. Widening the rule
// to parentheses would remove every one of them from someone's chat, so each line has to be read as
// "would losing this have been fine?" — one real reply here is a rule that must not ship.
console.log('\nPAREN CANDIDATES (not filtered today — this is the decision):')
const parens = new Map<string, number>()
for (const r of rows) if (r.kind === 'paren-candidate') parens.set(r.text, (parens.get(r.text) ?? 0) + 1)
if (!parens.size) console.log('  (none)')
for (const [text, n] of [...parens].sort((a, b) => b[1] - a[1])) {
  console.log(`  n=${String(n).padStart(3)}  ${JSON.stringify(text.slice(0, 200))}`)
}

// THE ONE NUMBER THAT MATTERS. Every match above is text the filter removes, so a match that is a
// real reply is a message the owner never sees. Read this list after every CLI upgrade.
console.log('\nIf any line above reads like something a person meant to send, the filter is too wide.')
