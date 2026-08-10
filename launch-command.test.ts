import { test, expect } from 'bun:test'
import { parseLaunch, LAUNCH_USAGE } from './launch-command.ts'

const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const p = (s: string) => parseLaunch(s, MODELS, EFFORTS)

test('not an @launch at all — the caller must leave the message alone', () => {
  expect(p('what is @launch anyway')).toBeNull()
  expect(p('@launchpad test do the thing')).toBeNull()
  expect(p('launch test do the thing')).toBeNull()
})

test("the owner's two examples", () => {
  expect(p('@launch test opus/high send me the word ping')).toEqual(
    { kind: 'launch', name: 'test', model: 'opus', effort: 'high', message: 'send me the word ping' })
  // The one that decides the grammar: `name` is a message word, not a dial token.
  expect(p('@launch general name the top 10 processes using the most ram on this box')).toEqual(
    { kind: 'launch', name: 'general', model: null, effort: null,
      message: 'name the top 10 processes using the most ram on this box' })
})

test('dials: model alone, /effort alone, med normalised, case-insensitive', () => {
  expect(p('@launch t sonnet go')).toMatchObject({ model: 'sonnet', effort: null, message: 'go' })
  expect(p('@launch t /xhigh go')).toMatchObject({ model: null, effort: 'xhigh', message: 'go' })
  expect(p('@launch t opus/med go')).toMatchObject({ model: 'opus', effort: 'medium', message: 'go' })
  expect(p('@LAUNCH t Opus/High go')).toMatchObject({ name: 't', model: 'opus', effort: 'high', message: 'go' })
})

test('a bare effort word is NOT eaten — the likelier sentence wins', () => {
  expect(p('@launch notes high level summary of X')).toMatchObject(
    { model: null, effort: null, message: 'high level summary of X' })
})

test('a path-shaped token is not a dial', () => {
  expect(p('@launch t /srv/chat is where it lives')).toMatchObject(
    { model: null, effort: null, message: '/srv/chat is where it lives' })
})

test('half a dial is a typo, and says so', () => {
  expect(p('@launch t opus/turbo go')).toEqual({ kind: 'error', error: "unknown effort 'turbo' — one of: low | medium | high | xhigh | max" })
  expect(p('@launch t gpt5/high go')).toEqual({ kind: 'error', error: "unknown model 'gpt5' — one of: fable | opus | sonnet | haiku" })
})

test('an unknown BARE word is message text, not a bad model', () => {
  expect(p('@launch t gpt5 is not a model')).toMatchObject({ model: null, message: 'gpt5 is not a model' })
})

test('multi-line message keeps its newlines and internal spacing', () => {
  const r = p('@launch t fable/max fix the bug:\n\n  - step one\n  - step two')
  expect(r).toMatchObject({ model: 'fable', effort: 'max', message: 'fix the bug:\n\n  - step one\n  - step two' })
})

test('a dial token on the NEXT line is message text, not a dial', () => {
  expect(p('@launch t\nopus/high do it')).toMatchObject({ model: null, effort: null, message: 'opus/high do it' })
})

// `@spawn` is the same verb spelled the way the CLI spells it. Asserted as EQUIVALENCE over every
// case above rather than as one happy-path sample: the whole risk of an alias is a branch that only
// one spelling reaches, and a same-object check covers the dial token, the refusals and the
// message-boundary rule in one pass. The already-live branch needs no case of its own — it is chosen
// downstream of this parse, from a ParsedLaunch that is byte-identical either way.
test('@spawn parses identically to @launch, case for case', () => {
  const cases = [
    '@launch test opus/high send me the word ping',
    '@launch general name the top 10 processes using the most ram on this box',
    '@launch t sonnet go', '@launch t /xhigh go', '@launch t opus/med go',
    '@launch notes high level summary of X',
    '@launch t /srv/chat is where it lives',
    '@launch t opus/turbo go', '@launch t gpt5/high go',
    '@launch t gpt5 is not a model',
    '@launch t fable/max fix the bug:\n\n  - step one',
    '@launch t\nopus/high do it',
    '@launch test', '@launch', '@launch --help x',
  ]
  for (const c of cases) expect(p(c.replace('@launch', '@spawn'))).toEqual(p(c))
  // And it is still a verb only at the start, on a whole word.
  expect(p('what is @spawn anyway')).toBeNull()
  expect(p('@spawner test do the thing')).toBeNull()
  expect(p('@SPAWN t Opus/High go')).toMatchObject({ name: 't', model: 'opus', effort: 'high', message: 'go' })
})

// The sigil typed twice: every other way of naming a session on this surface wants one, so `@launch
// @cc-bridge …` is the likely typo, not an exotic one. Left alone it reached the folder name, where
// the sanitiser turned it into a dash and spawned "-cc-bridge", directory and all.
test('a leading @ on the name is dropped, not spawned as part of it', () => {
  expect(p('@launch @cc-bridge do the thing')).toEqual(
    { kind: 'launch', name: 'cc-bridge', model: null, effort: null, message: 'do the thing' })
  expect(p('@spawn @test opus/high go')).toMatchObject({ name: 'test', model: 'opus', effort: 'high', message: 'go' })
  expect(p('@launch @@test go')).toMatchObject({ name: 'test', message: 'go' })
  // Stripping happens BEFORE the dash refusal, so a mistyped flag behind a sigil is still refused.
  expect((p('@launch @--help x') as { error: string }).error).toContain('starts with a dash')
  expect(p('@launch @ do the thing')).toEqual({ kind: 'error', error: LAUNCH_USAGE })
})

test('empty message and a dash name refuse before anything is created', () => {
  expect(p('@launch test')).toEqual({ kind: 'error', error: `no message — ${LAUNCH_USAGE}` })
  expect(p('@launch test opus/high')).toEqual({ kind: 'error', error: `no message — ${LAUNCH_USAGE}` })
  expect(p('@launch')).toEqual({ kind: 'error', error: LAUNCH_USAGE })
  expect(p('@launch --help do the thing')).toMatchObject({ kind: 'error' })
  expect((p('@launch --help x') as { error: string }).error).toContain('starts with a dash')
})
