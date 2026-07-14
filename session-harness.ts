import { join } from 'node:path'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { STATE_DIR, readJsonFile } from './common.ts'
import { normalizeHarnessProfile, type HarnessProfile } from './harness-provider.ts'

const SESSION_HARNESS_FILE = join(STATE_DIR, 'session-harnesses.json')
type StoredHarness = { profile: HarnessProfile; updatedAt: number }

let entries = new Map<string, StoredHarness>()
let loaded = false
let persist = true

function load(): void {
  if (loaded) return
  loaded = true
  const raw = readJsonFile<Record<string, { profile?: unknown; updatedAt?: unknown }>>(SESSION_HARNESS_FILE, {})
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value.updatedAt !== 'number') continue
    entries.set(id, { profile: normalizeHarnessProfile(value.profile), updatedAt: value.updatedAt })
  }
}

function save(): void {
  if (!persist) return
  const tmp = `${SESSION_HARNESS_FILE}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 })
    renameSync(tmp, SESSION_HARNESS_FILE)
  } catch (error) {
    try { unlinkSync(tmp) } catch {}
    throw error
  }
}

export function findSessionHarness(sessionId: string): HarnessProfile | undefined {
  load()
  return entries.get(sessionId)?.profile
}

export function getSessionHarness(sessionId: string): HarnessProfile {
  return findSessionHarness(sessionId) ?? { provider: 'anthropic' }
}

export function recordSessionHarness(sessionId: string, profile: HarnessProfile, updatedAt = Date.now()): void {
  if (!sessionId) return
  load()
  entries.set(sessionId, { profile: normalizeHarnessProfile(profile), updatedAt })
  save()
}

export function _resetSessionHarnessesForTest(seed: Record<string, StoredHarness> = {}): void {
  entries = new Map(Object.entries(seed))
  loaded = true
  persist = false
}

export function _sessionHarnessCountForTest(): number { load(); return entries.size }
