export type ScoutStart = 'started' | 'running'

export interface ScoutCoordinatorDeps {
  run: (realPath: string) => Promise<string>
  notify: (sessionId: string, note: string, realPath: string) => Promise<void>
}

export interface ScoutCoordinator {
  start: (realPath: string, sessionId: string | null) => ScoutStart
  wait: (realPath: string) => Promise<void>
}

/** Deduplicate work per repo while retaining every distinct session waiting for the result. */
export function createScoutCoordinator(deps: ScoutCoordinatorDeps): ScoutCoordinator {
  const running = new Map<string, { waiters: Set<string>; promise: Promise<void> }>()

  const start = (realPath: string, sessionId: string | null): ScoutStart => {
    const current = running.get(realPath)
    if (current) {
      if (sessionId) current.waiters.add(sessionId)
      return 'running'
    }

    const waiters = new Set<string>()
    if (sessionId) waiters.add(sessionId)
    const entry = { waiters, promise: Promise.resolve() as Promise<void> }
    entry.promise = deps.run(realPath)
      .then(async note => {
        for (const sid of entry.waiters) await deps.notify(sid, note, realPath).catch(() => {})
      })
      .finally(() => running.delete(realPath))
    running.set(realPath, entry)
    return 'started'
  }

  return {
    start,
    wait: async realPath => { await running.get(realPath)?.promise },
  }
}
