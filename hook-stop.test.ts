// The Stop hook: the two halves that can be tested without a daemon — what it PRINTS (which is the
// whole contract with the CLI) and how its row gets into settings.json.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopDecision } from './hook-stop.ts'
import { healStopHook } from './accounts.ts'

// ---- the output contract ----------------------------------------------------------------------
//
// Silence is the common case and the safe one: every failure path in the hook produces no reason, and
// no reason must mean no output at all. A stray `{}` on stdout is parsed by the CLI as a decision.
test('no reason → nothing is printed, so the turn ends', () => {
  expect(stopDecision(null)).toBe('')
  expect(stopDecision(undefined)).toBe('')
  expect(stopDecision('')).toBe('')
  expect(stopDecision('   \n ')).toBe('')
})

test('a reason blocks the stop, and rides in the field the CLI reads', () => {
  const out = stopDecision('Ask 958 from @chat is still open — send it with: tg answer 958')
  expect(JSON.parse(out)).toEqual({
    decision: 'block',
    reason: 'Ask 958 from @chat is still open — send it with: tg answer 958',
  })
})

// The reason is daemon-built text with quotes, newlines and `<tg …>`-ish characters in it. It goes
// out as JSON, so it can never break the frame — asserted rather than assumed, because a hand-rolled
// string here would have.
test('a reason with quotes and newlines survives as one JSON value', () => {
  const nasty = 'Send it with: tg answer 1 "<summary>"\n958 from @a · 961 from @b'
  expect(JSON.parse(stopDecision(nasty)).reason).toBe(nasty)
})

// ---- how the row reaches an existing install ----------------------------------------------------
//
// setup.ts writes it at install time; every box that installed earlier gets it from the daemon at
// startup. Conservative on purpose: it may add a missing row and nothing else.
const settings = (obj: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'stophook-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(obj, null, 2))
  return dir
}
const read = (dir: string): any => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))

test('the row is added when absent, and the rest of settings.json is untouched', () => {
  const dir = settings({ statusLine: { type: 'command', command: 'x' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'ensure-daemon.ts' }] }] } })
  healStopHook(dir)
  const s = read(dir)
  expect(JSON.stringify(s.hooks.Stop)).toContain('hook-stop.ts')
  expect(s.statusLine).toEqual({ type: 'command', command: 'x' })
  expect(JSON.stringify(s.hooks.SessionStart)).toContain('ensure-daemon.ts')
  // The command must survive a deploy: it globs the newest cache version rather than pinning the one
  // that happened to write it.
  expect(s.hooks.Stop[0].hooks[0].command).toContain('sort -V | tail -1')
})

test('it is idempotent, and never touches a Stop hook the user already has', () => {
  const dir = settings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-thing.sh' }] }] } })
  healStopHook(dir)
  const first = read(dir)
  expect(first.hooks.Stop).toHaveLength(2)          // theirs, plus ours
  healStopHook(dir)
  expect(read(dir).hooks.Stop).toHaveLength(2)      // …and a second run adds nothing
  expect(JSON.stringify(first.hooks.Stop[0])).toContain('my-own-thing.sh')
})

test('a rewritten command still counts as installed — matched on the script, not the string', () => {
  const dir = settings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bun /somewhere/else/hook-stop.ts' }] }] } })
  healStopHook(dir)
  expect(read(dir).hooks.Stop).toHaveLength(1)
})

test('no settings.json at all is setup.ts\'s job — nothing is created here', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stophook-none-'))
  healStopHook(dir)
  expect(existsSync(join(dir, 'settings.json'))).toBe(false)
})

test('a settings.json with no hooks key at all gets one', () => {
  const dir = settings({ statusLine: null })
  healStopHook(dir)
  expect(JSON.stringify(read(dir).hooks.Stop)).toContain('hook-stop.ts')
})
