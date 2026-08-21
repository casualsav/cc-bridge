// THE REPLAY: ask 76's own body, against midi2score's own history.
//
// On 2026-08-21 the chat lane sent a worker to "find those questions in HANDOFF.md / handoff/ (they
// were drafted there…)" — eight days after `handoff/` was folded into HANDOFF.md and deleted. The
// preflight of the day STOPPED that ask (its 31st refusal), presented the capsule, and passed the
// identical body on the retry: it never read the brief, so the one real contradiction of the day went
// through. The first test below is that body against a fixture of that repo's removals.
//
// The control is the same body against a map with the `handoff/` removals taken out: no finding. It
// is the test that could pass from the wrong direction — a detector that flags every path it cannot
// stat would "catch" ask 76 and would also refuse every file a worker is asked to CREATE.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDeletedPaths, pathTokensIn, planBriefContradictions, renderContradictions, type DeletedPath } from './brief-contradictions.ts'

// `CC_BRIDGE_SRC_DIR=<dir holding HEAD's daemon.ts> bun test brief-contradictions.test.ts` must FAIL
// exactly the call-site tests at the bottom and pass every other one.
const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')

const REPO = '/home/ubuntu/projects/midi2score'
// Captured with the command the daemon runs:
//   git -C … log --diff-filter=DR --name-status --format='%h %cs %s' --since=180.days
const DELETED = parseDeletedPaths(readFileSync(join(import.meta.dir, 'fixtures', 'midi2score-deleted-paths.txt'), 'utf8'))
const ASK_76 = 'Your job: find those questions in HANDOFF.md / handoff/ (they were drafted there — trace each to its open item)'
// Everything the repo still has: HANDOFF.md, docs/design.md, the tree ask 76 would really touch.
const EXISTS = (rel: string): boolean => ['HANDOFF.md', 'docs', 'docs/design.md', 'midi2score', 'tools'].includes(rel)
const plan = (body: string, opts: { deleted?: Map<string, DeletedPath>; endpoints?: string[]; target?: string } = {}) =>
  planBriefContradictions({
    body, repoRoot: REPO, deletedPaths: opts.deleted ?? DELETED, existsInRepo: EXISTS,
    endpoints: opts.endpoints ?? ['chat', 'midi', 'weather'], target: opts.target ?? 'midi',
  })

test('REPLAY — ask 76 names a directory this repo deleted, and the refusal names the commit', () => {
  const findings = plan(ASK_76)
  const path = findings.filter(f => f.kind === 'deleted-path')
  expect(path.map(f => f.token)).toEqual(['handoff/'])
  // The design note names 87fe3cc/8144198 (both 2026-08-13). A DIRECTORY token gets the newest
  // removal under it — the commit that folded the directory away, whose subject says exactly that —
  // while 8144198 is what an exact `handoff/facts.md` token gets (the next test).
  expect(path[0]!.detail).toContain('removed in 87fe3cc')
  expect(path[0]!.detail).toContain('fold handoff/ into HANDOFF.md')
  expect(renderContradictions(findings)).toContain('✗ handoff/ — removed in 87fe3cc')
  expect(renderContradictions(findings).split('\n').length).toBeLessThanOrEqual(5)
  expect(renderContradictions(findings)).toContain('Resend unchanged to override')
})

test('the capsule\'s own dead path names the commit that moved it', () => {
  const findings = plan('Read handoff/facts.md (standing truths) before touching the pipeline.')
  expect(findings).toHaveLength(1)
  expect(findings[0]!.token).toBe('handoff/facts.md')
  expect(findings[0]!.detail).toContain('removed in 8144198')
  expect(findings[0]!.detail).toContain('2026-08-13')
})

test('CONTROL — the same body is clean once those removals are not in history', () => {
  const control = new Map([...DELETED].filter(([p]) => !p.startsWith('handoff/')))
  expect(plan(ASK_76, { deleted: control })).toEqual([])
})

test('a path that was never here is a file to CREATE, not a contradiction', () => {
  expect(plan('Add scripts/new-thing.ts and wire it into tools/.')).toEqual([])
})

test('a path that still exists is never flagged, however loudly the brief names it', () => {
  expect(plan('Read HANDOFF.md and docs/design.md first.')).toEqual([])
})

test('an @name nobody answers to is named; the roster, the target and @owner are not', () => {
  const findings = plan('Ask @mimo to check, then report to @owner and cc @chat and @midi.')
  expect(findings.map(f => f.token)).toEqual(['@mimo'])
  expect(findings[0]!.detail).toBe('is not a live endpoint')
  expect(renderContradictions(findings)).toContain('✗ @mimo is not a live endpoint')
})

test('an email local part and the convention\'s own placeholders are not endpoints', () => {
  expect(plan('Mail suchag@gmail.com; the verb is `tg ask @name -` and the sender shows as @sender.')).toEqual([])
})

// Measured over the 1,794 chat-lane bodies in 2026-08-21's ledger: without these three rules the
// detector refuses 49 of them and not one names a real address. Each line below is a shape that
// occurred, quoted from a body that would have been stopped.
test('a brief QUOTES cards, stamps and log lines — a quoted @name is not an address', () => {
  expect(plan('the dead letter still reads "killed by @x", which is the class')).toEqual([])
  expect(plan('after /clear the `@tg_transcript` stamp still names the discarded conversation')).toEqual([])
  expect(plan('the stale @tg_transcript stamp after /clear is exactly why the record wins')).toEqual([])
  expect(plan("the DM shows '@session messaged @chat' and that causes the confusion")).toEqual([])
  expect(plan('```\nSpawned @x · 1/2\n```')).toEqual([])
  // …and a plain-prose one still is.
  expect(plan('Ask @mimo to check the merge.').map(f => f.token)).toEqual(['@mimo'])
})

test('a bot username, a bridge gesture and an id are not endpoint names', () => {
  expect(plan('Test against @salahsclaudetestbot, then @launch bridgefix and @kill it after.')).toEqual([])
  expect(plan('ask 14 landed at @14:03 and @spawn is the same message as @launch')).toEqual([])
})

test('the refusal never runs past five lines', () => {
  const many = plan('handoff/facts.md handoff/title-band.md handoff/house-style.md handoff/census-tool.md handoff/tie-spelling.md @a @b')
  expect(many.length).toBeGreaterThan(5)
  const text = renderContradictions(many)
  expect(text.split('\n').length).toBe(5)
  expect(text).toContain('more not shown')
})

// ---- the tokeniser ---------------------------------------------------------------------------

test('the tokeniser takes paths and leaves prose, URLs, globs and shared-dir refs alone', () => {
  expect(pathTokensIn('see `docs/design.md`, then (tools/compare_cue.py) and HANDOFF.md.', REPO))
    .toEqual(['docs/design.md', 'tools/compare_cue.py', 'HANDOFF.md'])
  expect(pathTokensIn('https://example.com/a/b.md and $(tg shared)/bridgecontext/DESIGN.md and tools/*.py', REPO)).toEqual([])
  expect(pathTokensIn('and/or is prose but midi2score/web.py is not', REPO)).toEqual(['and/or', 'midi2score/web.py'])
})

test('an absolute path is repo-relative or it is somebody else\'s file', () => {
  expect(pathTokensIn(`${REPO}/docs/design.md and /etc/hosts and ~/scratch/x.md`, REPO)).toEqual(['docs/design.md'])
  expect(pathTokensIn(`${REPO}/docs/design.md`, null)).toEqual([])
})

// ---- source-bound: the gate reads the body, and both call sites hand it one --------------------

test('the preflight takes the dispatched BODY and the target it is going to', () => {
  const sig = /async function repoDispatchPreflight\(fromSid: string, real: string, body: string, target: string/.exec(daemon)
  expect(sig).not.toBeNull()
  expect(daemon).toContain('planBriefContradictions({')
})

test('the ask call site passes the ask text, and the spawn call site its founding message', () => {
  const calls = [...daemon.matchAll(/await repoDispatchPreflight\(([^)]*)\)/g)].map(m => m[1]!)
  expect(calls).toHaveLength(2)
  expect(calls[0]).toContain('askText')
  expect(calls[1]).toContain('args.text')
})
