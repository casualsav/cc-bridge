// chat-queue.test.ts — the orchestrator's own queue, and the properties it exists for.
//
// It exists because Unit 1 moved sequencing out of the bus, and an agent's queue is a paragraph in a
// context window until it is a file. So the tests that matter are the recovery ones: a cold read, a
// hand-edited file, a corrupt file. Rendering is tested because the render IS the read verb — a queue
// nobody can read on a phone at 3am is not written down in any useful sense.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseQueue, loadQueue, saveQueue, addItem, startItem, doneItem, renderQueue, EMPTY } from './chat-queue.ts'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'cq-')), 'chat-queue.json')

test('add → save → load round-trips through the file', () => {
  const f = tmp()
  const { store, item } = addItem(EMPTY, 'build the index estimator', 'weather', 1000)
  saveQueue(f, store)
  expect(item.id).toBe(1)
  const back = loadQueue(f)
  expect(back.items).toHaveLength(1)
  expect(back.items[0]).toMatchObject({ id: 1, text: 'build the index estimator', target: 'weather', createdAt: 1000 })
})

test('ids never repeat, even across a reload', () => {
  const f = tmp()
  let s = addItem(EMPTY, 'one').store
  s = addItem(s, 'two').store
  saveQueue(f, s)
  const reloaded = loadQueue(f)
  const third = addItem(reloaded, 'three')
  expect(third.item.id).toBe(3)
  // …and dropping an item does not free its id for reuse: two units of work must never merge.
  const afterDone = doneItem(third.store, 1).store
  expect(addItem(afterDone, 'four').item.id).toBe(4)
})

test('nextId is DERIVED, so a hand-edited file cannot collide two items onto one id', () => {
  // Being readable is the point of this file, which means being editable, which means a stale nextId
  // is a thing that will happen. Trusting it would silently merge work.
  const s = parseQueue(JSON.stringify({ nextId: 1, items: [{ id: 7, text: 'hand-added', createdAt: 0 }] }))
  expect(s.nextId).toBe(8)
  expect(addItem(s, 'next').item.id).toBe(8)
})

test('a corrupt or absent file loads as an empty queue rather than throwing', () => {
  const f = tmp()
  expect(loadQueue(f).items).toEqual([])          // never written
  writeFileSync(f, 'not json at all')
  expect(loadQueue(f).items).toEqual([])
  writeFileSync(f, JSON.stringify({ items: [{ id: 1 }, { text: 'no id' }, null, { id: 2, text: 'good' }] }))
  expect(loadQueue(f).items.map(i => i.id)).toEqual([2])   // malformed rows dropped, the good one survives
})

test('start is idempotent and done reports an unknown id rather than lying', () => {
  const s = addItem(EMPTY, 'a').store
  const first = startItem(s, 1, 500)
  expect(first.item?.id).toBe(1)
  const second = startItem(first.store, 1, 900)
  expect(second.store.items[0]!.startedAt).toBe(500)   // not re-stamped
  expect(doneItem(s, 99).item).toBeNull()
  expect(doneItem(s, 99).store.items).toHaveLength(1)  // and nothing was removed
})

test('the file is pretty-printed, because recovering by reading it directly is the whole point', () => {
  const f = tmp()
  saveQueue(f, addItem(EMPTY, 'readable?').store)
  const raw = readFileSync(f, 'utf8')
  expect(raw).toContain('\n  ')          // indented, not one line
  expect(raw).toContain('readable?')     // and the text is right there in plain sight
})

test('render shows every item in full, marks what was dispatched, and says when it is empty', () => {
  expect(renderQueue(EMPTY)).toBe('queue is empty')
  const long = 'a unit of work whose description runs well past any sensible truncation point, deliberately'
  let s = addItem(EMPTY, long, 'weather', 0).store
  s = addItem(s, 'second', undefined, 0).store
  s = startItem(s, 1, 0).store
  const out = renderQueue(s, 60_000)
  expect(out).toContain(long)            // NOT truncated — eliding the work defeats the record
  expect(out).toContain('▶ 1 → @weather')
  expect(out).toContain('· 2')           // not started
  expect(out).toContain('1m ago')
})
