// Type text into a PROBE's pane, safely — the only sanctioned way for a bridge session to put text
// into another session's input box during a live test (rider, @chat 629, 2026-08-16: a canary string
// typed with an EMPTY `-t` landed in the chat lane's box for 40 seconds).
//
//   bun scripts/probe-type.ts <session-name> <text> [--enter]
//
// Refuses, never guesses: an empty/unknown name; a name that resolves to no pane or to more than one;
// a pane whose `@tg_session` stamp does not match the topic's session id; a chat lane (his DM
// surface) always; this script's own pane. After typing it reads the box back and fails if the text
// is not there. Never falls back to the current pane. (Topic rows do not record `--probe`, so the
// name is the operator's responsibility — spawn probes with names that say so.)
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter(a => a.startsWith('--')))
const [name, text] = argv.filter(a => !a.startsWith('--'))
const die = (why: string): never => { console.error(`probe-type: REFUSED — ${why}`); process.exit(2) }
if (!name || !name.trim()) die('empty session name')
if (!text) die('empty text')

const home = process.env.HOME!
const topicsPath = `${home}/.claude/channels/telegram/topics.json`
const topicsFile = JSON.parse(readFileSync(topicsPath, 'utf8')) as { topics?: Record<string, { name?: string; closed?: boolean }>; dmChat?: Record<string, { sessionId: string }> }
const topics = topicsFile.topics ?? {}
const matches = Object.entries(topics).filter(([, v]) => v && typeof v === 'object' && v.name === name && !v.closed)
if (matches.length !== 1) die(`session name ${JSON.stringify(name)} resolves to ${matches.length} LIVE topic row(s), need exactly 1`)
const [sid] = matches[0]!
if (Object.values(topicsFile.dmChat ?? {}).some(d => d.sessionId === sid)) die(`${name} is a chat lane — the owner's own surface; never typed into`)

const tmux = (...a: string[]) => spawnSync('tmux', a, { encoding: 'utf8' })
const list = tmux('list-panes', '-a', '-F', '#{pane_id}\t#{@tg_session}')
if (list.status !== 0) die(`tmux list-panes failed: ${list.stderr}`)
const panes = list.stdout.split('\n').filter(Boolean).map(l => l.split('\t')).filter(([, s]) => s && sid.startsWith(s!) )
if (panes.length !== 1) die(`session ${sid} (${name}) is stamped on ${panes.length} pane(s), need exactly 1`)
const pane = panes[0]![0]!
// Belt and braces: the pane must not be the pane this script runs in.
if (process.env.TMUX_PANE && process.env.TMUX_PANE === pane) die(`${pane} is THIS pane`)

const before = tmux('capture-pane', '-p', '-t', pane).stdout
if (before.includes(text)) die(`${pane} already shows that text — refusing to type it twice`)
const r = tmux('send-keys', '-t', pane, '-l', text)
if (r.status !== 0) die(`send-keys failed: ${r.stderr}`)
if (flags.has('--enter')) tmux('send-keys', '-t', pane, 'Enter')
// The TUI repaints asynchronously: read back with a short retry before calling it a miss.
let after = ''
for (let i = 0; i < 10 && !after.includes(text); i++) { Bun.sleepSync(200); after = tmux('capture-pane', '-p', '-t', pane).stdout }
if (!flags.has('--enter') && !after.includes(text)) die(`typed into ${pane} but the capture does not show it after 2s — check the pane by hand`)
console.log(`probe-type: typed ${text.length} chars into ${pane} (@${name}, ${sid})${flags.has('--enter') ? ' + Enter' : ''}`)
