// Fix 3 — a bad READ must never become a WRITE that destroys the on-disk store.
//
// These run topics.ts in a CHILD bun process with its own TELEGRAM_STATE_DIR, on purpose: the store
// caches `loaded`/`persist` in module state and the suite's other files latch `persist` off via
// _resetForTest, so an in-process test would prove nothing about the real write path. A fresh process
// is the only way to exercise load-then-save exactly as the daemon does — and it needs no test-only
// export in topics.ts.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir

// Load the store, then mutate it (which calls save()) — the exact sequence that laundered a failed
// read into an empty file.
const DRIVER = `
import { loadTopics, setTopic } from ${JSON.stringify(join(HERE, 'topics.ts'))}
loadTopics()
setTopic('aaaa1111', { headless: true, cwd: '/tmp/x', name: 'probe', closed: false, createdAt: 1 })
`

function runDriver(stateDir: string): { code: number; stderr: string } {
  const script = join(stateDir, 'driver.ts')
  writeFileSync(script, DRIVER)
  const r = Bun.spawnSync(['bun', script], {
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { code: r.exitCode ?? -1, stderr: r.stderr.toString() }
}

function stateDirWith(topicsContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'topics-dur-'))
  writeFileSync(join(dir, 'topics.json'), topicsContent)
  return dir
}

test('a truncated topics.json is NOT overwritten with an empty store', () => {
  // Exactly the observed corruption: a whole-file write killed partway through.
  const truncated = '{"groupChatId":"-100123","topics":{"8ca051de":{"headless":true,"cwd":"/home/u/p","na'
  const dir = stateDirWith(truncated)

  const { stderr } = runDriver(dir)

  // The corrupt bytes must survive somewhere — either still in place, or moved aside for forensics.
  const aside = readdirSync(dir).filter(f => f.startsWith('topics.json.corrupt-'))
  const live = readFileSync(join(dir, 'topics.json'), 'utf8')
  const preserved = live === truncated || (aside.length === 1 && readFileSync(join(dir, aside[0]), 'utf8') === truncated)

  expect(preserved).toBe(true)
  // The failure mode this test exists for: the store came back as an empty object over the top.
  expect(live).not.toBe('{"groupChatId":null,"generalSessionId":null,"generalCwd":null,"baseCwd":null,"topics":{},"dismissedSessions":{},"dmChat":{}}')
  expect(live.includes('"topics":{}')).toBe(false)
  // And it must be loud, not silent.
  expect(stderr.toLowerCase()).toContain('corrupt')
})

test('an ABSENT topics.json is still a legitimate empty store (writes normally)', () => {
  // The guard must not turn "no file yet" — a first run — into a refusal to persist.
  const dir = mkdtempSync(join(tmpdir(), 'topics-dur-'))
  const { code } = runDriver(dir)
  expect(code).toBe(0)
  const written = JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))
  expect(written.topics.aaaa1111.name).toBe('probe')
})

test('a healthy store keeps its existing rows across a load+mutate cycle', () => {
  const good = JSON.stringify({
    groupChatId: '-100123', generalSessionId: null, generalCwd: null, baseCwd: null,
    topics: { keepme01: { headless: true, cwd: '/tmp/keep', name: 'keep', closed: false, createdAt: 5 } },
    dismissedSessions: {}, dmChat: {},
  })
  const dir = stateDirWith(good)
  runDriver(dir)
  const after = JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))
  expect(after.topics.keepme01).toBeTruthy()          // pre-existing row survived
  expect(after.topics.aaaa1111).toBeTruthy()          // new row landed
  expect(after.groupChatId).toBe('-100123')           // top-level state survived
})

test('rows dropped by the loader as malformed are reported, not silently discarded', () => {
  // Neither a numeric threadId nor headless:true — loadTopics drops it. That drop is legitimate;
  // doing it in silence is what let the loss go unnoticed for hours.
  const withBadRow = JSON.stringify({
    groupChatId: '-100123', topics: {
      goodrow1: { headless: true, cwd: '/tmp/g', name: 'g', closed: false, createdAt: 1 },
      badrow01: { cwd: '/tmp/b', name: 'b', closed: false, createdAt: 2 },
    }, dismissedSessions: {}, dmChat: {},
  })
  const dir = stateDirWith(withBadRow)
  const { stderr } = runDriver(dir)
  expect(stderr).toMatch(/drop(ped)? 1 /i)
})
