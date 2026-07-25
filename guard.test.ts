import { test, expect } from 'bun:test'
import { classify } from './guard.ts'

const danger = (cmd: string) => classify(cmd).danger
const verb = (cmd: string) => { const v = classify(cmd); return v.danger ? v.verb : null }

test('the verbs that actually caused this are refused', () => {
  expect(danger('git stash')).toBe(true)
  expect(danger('git stash -u')).toBe(true)          // the exact command from the incident
  expect(danger('git stash push -m wip')).toBe(true)
  expect(danger('git stash pop')).toBe(true)
  expect(danger('git reset --hard origin/main')).toBe(true)
  expect(danger('git clean -fd')).toBe(true)
  expect(danger('git add -A')).toBe(true)
  expect(danger('git add .')).toBe(true)
  expect(danger('git checkout .')).toBe(true)
  expect(danger('git restore .')).toBe(true)
  expect(danger('git checkout -f')).toBe(true)
})

test('branch switching counts — it rewrites the tree under a co-occupant', () => {
  expect(danger('git checkout main')).toBe(true)
  expect(danger('git switch main')).toBe(true)
  expect(verb('git checkout feature-x')).toBe('git checkout <branch>')
})

test('surgical, path-scoped git is allowed — the rule is explicit paths, not fewer commands', () => {
  expect(danger('git checkout HEAD -- src/a.ts')).toBe(false)
  expect(danger('git restore --source=abc123 -- one.ts two.ts')).toBe(false)
  expect(danger('git add src/a.ts src/b.ts')).toBe(false)
  expect(danger('git reset src/a.ts')).toBe(false)          // unstaging one path is not a tree rewrite
  expect(danger('git commit -m "x"')).toBe(false)
  expect(danger('git status --short')).toBe(false)
  expect(danger('git diff HEAD --stat')).toBe(false)
  expect(danger('git log --oneline -3')).toBe(false)
  expect(danger('git show HEAD:file.ts')).toBe(false)
})

test('autosave\'s own plumbing must not be blocked by the guard it feeds', () => {
  // These three are exactly what autosave.ts runs; blocking them would make the recovery mechanism
  // unusable the moment a second session appeared.
  expect(danger('git stash create')).toBe(false)
  expect(danger('git stash list')).toBe(false)
  expect(danger('git checkout refs/cc-bridge/autosave/20260725-090807 -- lost.ts')).toBe(false)
})

test('a dangerous verb hidden behind a separator is still caught', () => {
  expect(danger('cd /tmp && git stash')).toBe(true)
  expect(danger('echo hi; git reset --hard')).toBe(true)
  expect(danger('git status | grep x && git clean -fd')).toBe(true)
  expect(danger('true\ngit add -A')).toBe(true)
})

test('global options before the subcommand do not hide it', () => {
  expect(danger('git -C /repo stash')).toBe(true)
  expect(danger('git -c user.name=x reset --hard')).toBe(true)
  expect(danger('git -C /repo status')).toBe(false)
})

test('non-git commands are never touched', () => {
  expect(danger('rm -rf /tmp/x')).toBe(false)
  expect(danger('bun test')).toBe(false)
  expect(danger('echo "git stash"')).toBe(false)   // a mention in a string is not an invocation
})

test('the refusal explains why, so the session can choose a correct alternative', () => {
  const v = classify('git stash -u')
  expect(v.danger).toBe(true)
  if (!v.danger) throw new Error('unreachable')
  expect(v.why).toContain('uncommitted work')
})
