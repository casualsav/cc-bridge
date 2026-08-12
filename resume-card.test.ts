import { test, expect } from 'bun:test'
import {
  buildChatRows, classifyWorker, rankWorkers, tappable, numberRows, rowCallback,
  renderCard, cardButtons, encodeExpanded, decodeExpanded, swapConfirmText, swapBusyText, plain,
  CHAT_ROWS, WORKER_ROWS, WORKER_ROWS_MORE,
  type Section, type WorkerRow, type ChatRow,
} from './resume-card.ts'

const NOW = 1_785_800_000_000
const worker = (over: Partial<WorkerRow> = {}): WorkerRow => ({
  kind: 'worker', sid: 'aaaa1111', name: 'cc-bridge', folder: 'cc-bridge', at: NOW - 3_600_000,
  last: 'shipped the fix', cost: { kind: 'continues', backlog: '1.2 MB', midFlight: false }, ...over,
})
const recents = (n: number) => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, title: `msg ${i}`, mtime: NOW - i * 60_000 }))
const chatRow = (over: Partial<ChatRow> = {}): ChatRow => ({ kind: 'chat', id: 'c1', title: 'hello', hint: 'opening', mtime: NOW, live: false, ...over })

// ---- the two honesty rules ----------------------------------------------------------------------

test('the live conversation is marked and can never be tapped', () => {
  const { rows } = buildChatRows(recents(5), 's0', CHAT_ROWS)
  const live = rows.filter(r => r.live)
  expect(live).toHaveLength(1)
  expect(live[0].id).toBe('s0')
  expect(tappable(live[0])).toBe(false)
  // …and it takes no number, so no callback in the whole card addresses it.
  const sections: Section[] = [{ key: 'c', title: 'Chat', note: '', rows, shown: rows.length - 1, total: 4 }]
  expect(numberRows(sections).some(t => (t.row as ChatRow).id === 's0')).toBe(false)
  expect(cardButtons(sections, { c: false, w: false }).flat().some(b => b.data === 'rsw:s0')).toBe(false)
})

test('the live row does not consume a visible slot', () => {
  // 1 live + CHAT_ROWS resumable, not CHAT_ROWS-1 — the marker is context, not a choice.
  const { rows, total } = buildChatRows(recents(9), 's0', CHAT_ROWS)
  expect(rows.filter(r => !r.live)).toHaveLength(CHAT_ROWS)
  expect(total).toBe(8)
})

test('a transcript-gone worker offers no tap', () => {
  const gone = worker({ sid: 'gone1111', cost: classifyWorker('uuid-on-record', { file: null, midFlight: false, backlog: null }) })
  expect(gone.cost.kind).toBe('gone')
  expect(tappable(gone)).toBe(false)
  const sections: Section[] = [{ key: 'w', title: 'Workers', note: '', rows: [gone, worker()], shown: 2, total: 2 }]
  const taps = numberRows(sections)
  expect(taps).toHaveLength(1)
  expect((taps[0].row as WorkerRow).sid).toBe('aaaa1111')
  expect(cardButtons(sections, { c: false, w: false }).flat().some(b => b.data.includes('gone1111'))).toBe(false)
  // The row still RENDERS — a hidden dead session is a session the owner keeps looking for.
  expect(renderCard(sections, NOW)).toContain('transcript gone')
})

// ---- the three reopen costs ---------------------------------------------------------------------

test('classifyWorker splits fresh / continues / gone on the two facts it has', () => {
  expect(classifyWorker(undefined, { file: '/x.jsonl', midFlight: false, backlog: '1 MB' })).toEqual({ kind: 'fresh' })
  expect(classifyWorker('u', { file: null, midFlight: false, backlog: null })).toEqual({ kind: 'gone' })
  expect(classifyWorker('u', { file: '/x.jsonl', midFlight: true, backlog: '2 MB' }))
    .toEqual({ kind: 'continues', backlog: '2 MB', midFlight: true })
})

test('each cost renders its own line, and continues names the replay', () => {
  const card = renderCard([{ key: 'w', title: 'Workers', note: '', shown: 3, total: 3, rows: [
    worker({ sid: 'a', cost: { kind: 'continues', backlog: '1.2 MB', midFlight: true } }),
    worker({ sid: 'b', cost: { kind: 'fresh' } }),
    worker({ sid: 'c', cost: { kind: 'gone' } }),
  ] }], NOW)
  expect(card).toContain('replays 1.2 MB')
  expect(card).toContain('mid-turn')
  expect(card).toContain('never completed a turn')
  expect(card).toContain('transcript gone')
})

// ---- ranking, capping, expansion ----------------------------------------------------------------

test('workers rank newest-activity first and report N of M', () => {
  const rows = Array.from({ length: 40 }, (_, i) => worker({ sid: `w${i}`, at: NOW - i * 60_000 }))
  const ranked = rankWorkers(rows, WORKER_ROWS)
  expect(ranked.rows).toHaveLength(WORKER_ROWS)
  expect(ranked.rows[0].sid).toBe('w0')
  expect(ranked.total).toBe(40)
  expect(renderCard([{ key: 'w', title: 'Workers', note: '', rows: ranked.rows, shown: WORKER_ROWS, total: 40 }], NOW))
    .toContain(`showing ${WORKER_ROWS} of 40`)
  // Expanded shows more and stops claiming completeness only when it IS complete.
  const more = rankWorkers(rows, WORKER_ROWS_MORE)
  expect(more.rows).toHaveLength(WORKER_ROWS_MORE)
  expect(renderCard([{ key: 'w', title: 'Workers', note: '', rows: more.rows, shown: WORKER_ROWS_MORE, total: WORKER_ROWS_MORE }], NOW))
    .not.toContain('showing')
})

test('More is offered only for a section with hidden rows, and carries the next expansion', () => {
  const sections: Section[] = [
    { key: 'c', title: 'Chat', note: '', rows: [worker() as unknown as ChatRow], shown: 1, total: 1 },
    { key: 'w', title: 'Workers', note: '', rows: [worker()], shown: 1, total: 9 },
  ]
  const kb = cardButtons(sections, { c: false, w: false }).flat()
  expect(kb.filter(b => b.data.startsWith('rres:'))).toHaveLength(1)
  expect(kb.find(b => b.data.startsWith('rres:'))!.data).toBe('rres:cW')
})

test('expansion round-trips through callback data', () => {
  for (const e of [{ c: false, w: false }, { c: true, w: false }, { c: false, w: true }, { c: true, w: true }])
    expect(decodeExpanded(encodeExpanded(e))).toEqual(e)
})

// ---- card mechanics ------------------------------------------------------------------------------

test('numbers are continuous across sections and each maps to exactly one callback', () => {
  const sections: Section[] = [
    { key: 'c', title: 'Chat', note: '', shown: 2, total: 2, rows: [
      chatRow({ id: 'live', title: 'now', live: true }),
      chatRow({ id: 'c1', title: 'older', mtime: NOW - 1 }),
    ] },
    { key: 'w', title: 'Workers', note: '', shown: 2, total: 2, rows: [worker({ sid: 'w1' }), worker({ sid: 'w2' })] },
  ]
  const taps = numberRows(sections)
  expect(taps.map(t => t.n)).toEqual([1, 2, 3])
  expect(taps.map(t => rowCallback(t.row))).toEqual(['rsw:c1', 'rro:w1', 'rro:w2'])
  expect(new Set(taps.map(t => rowCallback(t.row))).size).toBe(3)
})

test('buttons are three per keyboard row', () => {
  const rows = Array.from({ length: 7 }, (_, i) => worker({ sid: `w${i}` }))
  const kb = cardButtons([{ key: 'w', title: 'Workers', note: '', rows, shown: 7, total: 7 }], { c: false, w: false })
  expect(kb.map(l => l.length)).toEqual([3, 3, 1])
})

test('an empty card says so instead of rendering a bare heading', () => {
  expect(renderCard([{ key: 'w', title: 'Workers', note: '', rows: [], shown: 0, total: 0 }], NOW))
    .toContain('Nothing resumable here yet')
})

test('a third section can be appended without touching the first two', () => {
  const base: Section[] = [{ key: 'w', title: 'Workers', note: '', rows: [worker({ sid: 'w1' })], shown: 1, total: 1 }]
  const withAgents = [...base, { key: 'w' as const, title: 'Agents', note: '', rows: [worker({ sid: 'a1' })], shown: 1, total: 1 }]
  // The existing rows keep their numbers and their callbacks; only new numbers are added.
  expect(numberRows(base).map(t => t.n)).toEqual([1])
  expect(numberRows(withAgents).map(t => rowCallback(t.row))).toEqual(['rro:w1', 'rro:a1'])
})

// ---- the swap's words ----------------------------------------------------------------------------

test('the swap confirm names both sides and says it is reversible', () => {
  const t = swapConfirmText('the new one', 'the running one')
  expect(t).toContain('the new one')
  expect(t).toContain('the running one')
  expect(t).toMatch(/not.*deleted/i)
  expect(t).toContain('/resume')
})

test('the mid-turn refusal says when to retry', () => {
  const t = swapBusyText()
  expect(t).toMatch(/wait|finish/i)
  expect(t).toContain('/resume')
})

// ---- row text is somebody else's markdown --------------------------------------------------------

test('markdown in a quoted reply is stripped before it reaches the card', () => {
  const card = renderCard([{ key: 'w', title: 'Workers', note: '', shown: 1, total: 1, rows: [
    worker({ last: 'Pushed — `baae622..d57f9e2` on **main**, see [the note](x)' }),
  ] }], NOW)
  expect(card).not.toContain('`')
  expect(card).toContain('baae622..d57f9e2')
  // A clamp that cuts mid-entity is what makes Telegram refuse the whole card; nothing survives to cut.
  expect(plain('**bold** `code` _it_').match(/[`*_]/)).toBeNull()
})

test('a chat row says WHICH handle it is showing', () => {
  const opening = renderCard([{ key: 'c', title: 'Chat', note: '', shown: 1, total: 1, rows: [chatRow({ title: 'let us build it', hint: 'opening' })] }], NOW)
  const last = renderCard([{ key: 'c', title: 'Chat', note: '', shown: 1, total: 1, rows: [chatRow({ title: 'shipped it', hint: 'last' })] }], NOW)
  expect(opening).not.toContain('↩')
  expect(last).toContain('↩')
})

test('a conversation with no handle at all renders honestly, and is still tappable', () => {
  const row = chatRow({ title: '' })
  expect(renderCard([{ key: 'c', title: 'Chat', note: '', shown: 1, total: 1, rows: [row] }], NOW)).toContain('nothing said yet')
  expect(tappable(row)).toBe(true)
})
