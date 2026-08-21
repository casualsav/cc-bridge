// The ~16 KB ceiling every pane delivery used to have, and the two words tmux uses for it.
//
// `set-buffer -b <name> -- <text>` makes the message a tmux COMMAND. Measured on a live pane
// (2026-08-21, `scripts/paste-size-probe.ts --legacy`, %263):
//
//   1,000 bytes   loads
//   16,312 bytes  loads            ← the last size that ever reached a pane
//   16,343 bytes  `failed to send command`
//   30,000 bytes  `command too long`
//
// Nothing reached the input box past that, yet the sender was told the message was "sitting
// unsubmitted in their input box" — the words of the opposite failure — and the sweep retried the
// same impossible paste every 15 seconds until the 60-minute TTL. `load-buffer` from a file loads all
// four sizes in 3–23 ms.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { payloadRefused } from './pane-io.ts'
import { askResultText } from './agent-bus.ts'

const src = (f: string): string => readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, f), 'utf8')

test('payloadRefused knows BOTH of tmux\'s words for the ceiling — the boundary case says neither "long" nor "large"', () => {
  // Verbatim from the control run. The 16,343 message is the one a classifier written from the 30,000
  // case alone would call transient — and a transient verdict here is the retry loop, not a recovery.
  expect(payloadRefused({ stderr: 'failed to send command\nCommand failed: tmux set-buffer -b tg-probe--263 -- PASTE…' })).toBe(true)
  expect(payloadRefused({ stderr: 'command too long\nCommand failed: tmux set-buffer -b tg-probe--263 -- PASTE…' })).toBe(true)
  expect(payloadRefused(new Error('spawn tmux ENOENT'))).toBe(false)             // the box is gone, not the message
  expect(payloadRefused(new Error("can't find pane: %263"))).toBe(false)         // …transient by construction
  expect(payloadRefused(new Error('ETIMEDOUT'))).toBe(false)
  expect(payloadRefused(undefined)).toBe(false)
})

test('SOURCE: no payload is a tmux command argument any more — every site loads a FILE', () => {
  // The enumeration IS the coverage: five sites had the ceiling, in three daemons, and a fix applied
  // only where the symptom was reported would have left four of them. Ground truth: `set-buffer` with
  // a text argument appears nowhere outside prose.
  for (const f of ['pane-io.ts', 'daemon.ts', 'slack-daemon.ts', 'discord-daemon.ts']) {
    const s = src(f)
    expect(s, `${f} still passes a payload as a tmux command argument`).not.toMatch(/exec\('tmux', \['set-buffer'/)
  }
  const io = src('pane-io.ts')
  expect(io).toContain('export async function loadPasteBuffer')
  expect(io).toContain("await exec('tmux', ['load-buffer', '-b', buf, file]")
  // A name unique to the ATTEMPT: a shared one means a failed load leaves the PREVIOUS payload under
  // that name, and the paste that follows sends the wrong message into the pane, submitted.
  expect(io).toContain('const buf = `${injectBuffer(paneId)}-${++pasteAttempt}`')
  // …and a load that failed deletes its buffer rather than leaving it for anything to paste.
  expect(io).toContain("await exec('tmux', ['delete-buffer', '-b', buf]")
  // The message is somebody's private text, and the temp file is removed by name — never by a glob
  // (the /tmp lesson in CLAUDE.md: a cleanup glob once took 2,185 live directories with it).
  expect(io).toContain('{ mode: 0o600 }')
  expect(io).toContain('try { unlinkSync(file) } catch {}')
})

test('SOURCE: a refused payload is TERMINAL — the sweep does not retry an impossible paste', () => {
  const d = src('daemon.ts')
  const fn = d.slice(d.indexOf('async function tryDeliverAsk('), d.indexOf('async function confirmInjections('))
  expect(fn).toContain("if (outcome === 'refused')")
  expect(fn).toContain('removePending(cur.id)')
  expect(fn).toContain('reportRefusedPayload(cur, pane)')
  // …and every other outcome keeps its retry: the row stays queued exactly as before.
  expect(fn).toContain("outcome === 'failed' ? 'failed' : 'not-landed'")
  // The answer path tells the answerer the same truth: re-running with the SAME text cannot land.
  expect(d).toContain("outcome === 'refused'")
  expect(d).toContain('cannot land: shorten it')
})

test('the sender is told which box the message is in — and "failed" and "not-landed" say opposite things', () => {
  const failed = askResultText('failed', 'w', 7)
  const notLanded = askResultText('not-landed', 'w', 7)
  const refused = askResultText('refused', 'w', 7)
  // 'not-landed': our block IS in their box, unsubmitted. 'failed': nothing of ours ever reached it.
  // Conflating them sent the reader looking for a message in a box that never held it.
  expect(notLanded).toContain('sitting unsubmitted')
  expect(failed).toContain('nothing of ours reached their input box')
  expect(failed).not.toContain('sitting unsubmitted')
  // 'failed' is transient and says the sweep retries; 'refused' is terminal and says it does not.
  expect(failed).toMatch(/sweep retries/i)
  expect(refused).toMatch(/NOT RETRYING/)
  expect(refused).toContain('off the queue')
  // …and it names the one thing that does work, because "re-send it" is wrong advice here.
  expect(refused).toMatch(/shorten it|file/i)
})

test('SOURCE: every payload path ends at the SAME primitive — human inbound included', () => {
  const d = src('daemon.ts')
  // The human paths (a topic pane and the focused pane) reach the loader through exactly the two
  // wrappers the bus does, so "does the bus work" and "does a human message work" are one question
  // about one function. That is why the live gate could prove four paths and reason about the fifth.
  expect(d).toContain('const run = () => pasteToPane(paneId, block)')          // topic inbound
  expect(d).toContain('return (await injectPasteOutcome(paneId, watcher, text)) === \'landed\'')  // focused inbound
  const io = src('pane-io.ts')
  const fn = io.slice(io.indexOf('export async function pasteVerified('), io.indexOf('export async function waitForPaneReady('))
  expect(fn).toContain('await loadPasteBuffer(paneId, text)')
  expect(fn).toContain("payloadRefused(e) ? 'refused' : 'failed'")
  // …and the slash path, which has its own verifier but must not have its own loader.
  const slash = io.slice(io.indexOf('export async function pasteSlashVerified('), io.indexOf('export const injectBuffer'))
  expect(slash).toContain('await loadPasteBuffer(paneId, text)')
})
