// Which conversation has already read which repo capsule. THREE things about that sentence are the
// whole design (evidence: `$(tg shared)/bridgecontext/DESIGN.md` §1, §3):
//
//   · it is a CONVERSATION, not a session and not a process. The old gate was a Set in daemon memory,
//     so the deploy loop's 26 restarts on 2026-08-21 made "first contact" recur 31 times for a lane
//     that had read the same capsule at 00:22Z — ~150k characters of capsule re-dumped into its
//     context. And it keyed on the session id, which survives a `/clear` — the one event that really
//     does lose the capsule.
//   · seen means seen THIS capsule: the stored value is the record's `generatedAt`, so a refresh
//     presents again and nothing else does.
//   · it fails OPEN in both directions. An unreadable store means nothing is seen (one extra capsule,
//     never a swallowed one); an unwritable store keeps the state in memory for this process, which is
//     exactly the old behaviour.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RepoContextGate {
  hasSeen: (conversationKey: string, realPath: string, generatedAt: number) => boolean
  markSeen: (conversationKey: string, realPath: string, generatedAt: number) => void
}

type Store = Record<string, Record<string, number>>

export function createRepoContextGate(storePath: string, log: (s: string) => void = s => process.stderr.write(s)): RepoContextGate {
  let store: Store | null = null
  let warned = false
  const load = (): Store => {
    if (store) return store
    try {
      const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as unknown
      store = parsed && typeof parsed === 'object' ? parsed as Store : {}
    } catch { store = {} }
    return store
  }
  const flush = (): void => {
    try {
      mkdirSync(dirname(storePath), { recursive: true })
      const tmp = `${storePath}.tmp`
      writeFileSync(tmp, JSON.stringify(store) + '\n', { mode: 0o600 })
      renameSync(tmp, storePath)
    } catch (e) {
      if (!warned) { warned = true; log(`repo-context-gate: cannot write ${storePath} (${(e as Error)?.message ?? e}) — seen-state is process-local until it can\n`) }
    }
  }
  return {
    hasSeen(conversationKey, realPath, generatedAt) {
      const at = load()[conversationKey]?.[realPath]
      return at != null && at >= generatedAt
    },
    markSeen(conversationKey, realPath, generatedAt) {
      const s = load()
      ;(s[conversationKey] ??= {})[realPath] = generatedAt
      flush()
    },
  }
}
