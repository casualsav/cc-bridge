// chat-queue.ts — the orchestrator's own queue of work, written down.
//
// WHY THIS EXISTS. Unit 1 takes the queue out of the bus: an ask to a busy target refuses and mints
// nothing, and sequencing moves to the orchestrating agent — the owner's ruling, 2026-08-16 ("I never
// wanted queue'd work to sit in the bus — I wanted it to sit with the orchestration agent"). That
// trades one failure for another unless the agent's queue survives what a context does not: the bus's
// queue was persisted, and an agent's is a paragraph in a context window that a `/clear` or a
// compaction erases. @chat lost exactly that mid-exchange while this was being designed, and
// reconstructed it from `tg history`.
//
// So the queue is a FILE, and the shape follows from who reads it. It lives in the shared dir beside
// every other deliverable, it is pretty-printed JSON rather than a log or a database because a cold
// chat context must be able to recover by reading it directly with no tool, and every verb is cheap
// enough to run on every turn. `tg queue` reads, `tg queue add -` writes from stdin like every other
// body on this bus, `tg queue done <id>` closes.
//
// It is deliberately NOT a scheduler and NOT a dispatcher: nothing here sends anything. Handing it a
// delivery trigger would rebuild the bus queue one directory over, which is the thing being removed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type QueueItem = {
  id: number
  // Optional rather than 0-for-missing: a timestamp of 0 is a real value that reads as absent under
  // every truthiness check, and this file has two of them. `!= null` is the only test used below.
  createdAt?: number
  text: string
  target?: string      // the endpoint this is meant for, when it is known — free text, never resolved here
  startedAt?: number   // dispatched; kept in the file so a cold read can tell "sent" from "not yet"
}

export type QueueStore = { items: QueueItem[]; nextId: number }

export const EMPTY: QueueStore = { items: [], nextId: 1 }

// Tolerant like every other store here: a malformed row is dropped rather than throwing away the file.
// A queue that fails to parse must not take the whole queue with it.
export function parseQueue(raw: string): QueueStore {
  try {
    const d = JSON.parse(raw) as Partial<QueueStore>
    const items: QueueItem[] = []
    for (const it of Array.isArray(d.items) ? d.items : []) {
      // The null check is per-ROW and load-bearing: reading `.id` off a null throws, the outer catch
      // swallows it, and one bad row would take the entire queue with it — the opposite of tolerant.
      if (!it || typeof it !== 'object') continue
      const t = it as Partial<QueueItem>
      if (typeof t.id !== 'number' || typeof t.text !== 'string') continue
      items.push({
        id: t.id, text: t.text,
        ...(typeof t.createdAt === 'number' ? { createdAt: t.createdAt } : {}),
        ...(typeof t.target === 'string' ? { target: t.target } : {}),
        ...(typeof t.startedAt === 'number' ? { startedAt: t.startedAt } : {}),
      })
    }
    // nextId is derived rather than trusted: a hand-edited file (which is the point of it being
    // readable) can carry a stale one, and a reused id would silently merge two units of work.
    const maxId = items.reduce((m, i) => Math.max(m, i.id), 0)
    return { items, nextId: Math.max(typeof d.nextId === 'number' ? d.nextId : 1, maxId + 1) }
  } catch { return { items: [], nextId: 1 } }
}

export function loadQueue(file: string): QueueStore {
  try { return parseQueue(readFileSync(file, 'utf8')) } catch { return { items: [], nextId: 1 } }
}

export function saveQueue(file: string, store: QueueStore): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n')
}

export function addItem(store: QueueStore, text: string, target?: string, now = Date.now()): { store: QueueStore; item: QueueItem } {
  const item: QueueItem = { id: store.nextId, createdAt: now, text, ...(target ? { target } : {}) }
  return { store: { items: [...store.items, item], nextId: store.nextId + 1 }, item }
}

/** Mark an item dispatched. Idempotent — re-starting an already-started item is not an error. */
export function startItem(store: QueueStore, id: number, now = Date.now()): { store: QueueStore; item: QueueItem | null } {
  const item = store.items.find(i => i.id === id) ?? null
  if (!item) return { store, item: null }
  return { store: { ...store, items: store.items.map(i => i.id === id ? { ...i, startedAt: i.startedAt ?? now } : i) }, item }
}

/** Remove an item. Returns null when the id is not in the queue, so the caller can say so. */
export function doneItem(store: QueueStore, id: number): { store: QueueStore; item: QueueItem | null } {
  const item = store.items.find(i => i.id === id) ?? null
  if (!item) return { store, item: null }
  return { store: { ...store, items: store.items.filter(i => i.id !== id) }, item }
}

// The read verb's output. One line per item so it is scannable in a terminal and in a card; the full
// text is NOT truncated for a single item, because the whole point is that this is the record of what
// the work was — a queue that elides its own contents sends the reader back to `tg history`.
export function renderQueue(store: QueueStore, now = Date.now()): string {
  if (!store.items.length) return 'queue is empty'
  return store.items.map(i => {
    const mark = i.startedAt != null ? '▶' : '·'
    const to = i.target ? ` → @${i.target}` : ''
    const when = i.createdAt != null ? ` (${Math.round((now - i.createdAt) / 60_000)}m ago)` : ''
    return `${mark} ${i.id}${to}${when}: ${i.text}`
  }).join('\n')
}
