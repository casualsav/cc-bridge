import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHermesProfileList, upsertHermesEndpoint, removeHermesEndpoint } from './hermes-registry.ts'

// Captured verbatim from `hermes profile list` on this box (hermes 0.20.0) — the active profile
// carries a glued ◆, and the header + box-drawing rule are the two lines a naive first-token parse
// would turn into profiles named "Profile" and "───".
const REAL_OUTPUT = `
 Profile          Model                        Gateway      Alias        Distribution
 ─────────────    ───────────────────────────    ───────────    ───────────    ────────────────
 ◆default         deepseek-v4-flash            running      —            —
  codex           gpt-5.6-sol                  running      codex        —
  mimo            mimo-v2.5-pro                running      mimo         —
  mini            minimax-m3                   running      —            —
  opencode        glm-5.2                      running      opencode     —
  quick           gpt-5.6-terra                running      quick        —
`

const withFile = (initial: string | null, fn: (file: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-registry-'))
  const file = join(dir, 'hermes-endpoints.json')
  if (initial !== null) writeFileSync(file, initial)
  try { fn(file) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// The live config on this box: one hand-written entry no UI can reproduce, one ordinary one.
const LIVE = JSON.stringify({
  selftest: { profile: 'test', cmd: ['/home/ubuntu/.claude/channels/telegram/test-hermes.sh'], hidden: true },
  mimo: { profile: 'mimo', pane: true },
})

test('parses profile names, and neither the header nor the rule becomes one', () => {
  expect(parseHermesProfileList(REAL_OUTPUT)).toEqual(['default', 'codex', 'mimo', 'mini', 'opencode', 'quick'])
})

test('garbage in yields nothing, never an invented profile', () => {
  // The control: a bad parse must under-report. A picker built from an invented name mints a dead endpoint.
  for (const junk of ['', '\n\n', 'error: command not found', '   ───   \n  ◆  ', 'usage: hermes [-h]'])
    expect(parseHermesProfileList(junk).filter(p => !['usage', 'error', 'hermes'].includes(p))).toEqual([])
})

test('an unrelated add leaves every other entry byte-for-byte intact', () => {
  withFile(LIVE, file => {
    const before = JSON.parse(readFileSync(file, 'utf8'))
    expect(upsertHermesEndpoint(file, { name: 'quick', profile: 'quick', pane: true })).toEqual({ ok: true })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    // The whole point: `cmd` and `hidden` are fields this module can neither read nor set, and a
    // writer that serialized the daemon's endpoint Map would have dropped both.
    expect(after.selftest).toEqual(before.selftest)
    expect(after.mimo).toEqual(before.mimo)
    expect(after.quick).toEqual({ profile: 'quick', pane: true })
  })
})

test('a remove takes exactly one entry with it', () => {
  withFile(LIVE, file => {
    expect(removeHermesEndpoint(file, 'mimo')).toBe(true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(after)).toEqual(['selftest'])
    expect(after.selftest.cmd).toEqual(['/home/ubuntu/.claude/channels/telegram/test-hermes.sh'])
    expect(removeHermesEndpoint(file, 'mimo')).toBe(false)   // already gone
  })
})

test('re-registering an agent as one-shot clears a pane flag already on disk', () => {
  withFile(LIVE, file => {
    expect(upsertHermesEndpoint(file, { name: 'mimo', profile: 'mimo', pane: false })).toEqual({ ok: true })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect('pane' in after.mimo).toBe(false)
    expect(after.mimo.profile).toBe('mimo')
  })
})

test('an add onto unparseable bytes REFUSES rather than replacing them', () => {
  // readJsonFile's fallback cannot tell this from an empty store; treating it as empty and saving
  // would leave the file holding one new entry and nothing else.
  withFile('{"mimo": {"profile": "mimo",', file => {
    const r = upsertHermesEndpoint(file, { name: 'quick', profile: 'quick', pane: true })
    expect(r.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"mimo": {"profile": "mimo",')   // untouched
    expect(removeHermesEndpoint(file, 'mimo')).toBe(false)
  })
})

test('a missing file is a legitimately empty store and takes the first agent', () => {
  withFile(null, file => {
    expect(upsertHermesEndpoint(file, { name: 'mimo', profile: 'mimo', pane: true })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mimo: { profile: 'mimo', pane: true } })
  })
})

test('a JSON array is refused too — it parses, but it is not the store', () => {
  withFile('["mimo"]', file => {
    expect(upsertHermesEndpoint(file, { name: 'quick', profile: 'quick', pane: false }).ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('["mimo"]')
  })
})

// ---- the reply-target switch must never fall through -------------------------------------------
//
// SOURCE-LEVEL, because this switch lives inside daemon.ts's message handler and has no unit
// harness. It does NOT end the handler: a `break` resumes the ordinary inbound path, which delivers
// the text into the chat lane's pane. Shipped that way in v0.5.88 — the owner replied with a new
// agent's name and his chat session was handed the registration exchange as a turn, and answered
// about it. Every case in that switch exits with `return`.
import { readFileSync as readSrc } from 'node:fs'
test('no case in the force-reply switch exits with a bare break', () => {
  const src = readSrc(new URL('./daemon.ts', import.meta.url), 'utf8')
  const start = src.indexOf('      switch (target.kind) {')
  expect(start).toBeGreaterThan(0)
  const end = src.indexOf('\n      }\n    }\n  }\n', start)
  expect(end).toBeGreaterThan(start)
  const body = src.slice(start, end)
  expect(body.match(/case '/g)!.length).toBeGreaterThan(10)   // the slice really is the switch
  const offenders = body.split('\n')
    .filter(l => !/^\s*(\/\/|\*)/.test(l))          // comments may DISCUSS break; only code counts
    .filter(l => /\bbreak\b/.test(l))
  expect(offenders).toEqual([])
})
