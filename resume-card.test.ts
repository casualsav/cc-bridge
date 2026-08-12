import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
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
  expect(renderCard(sections, NOW)).toContain('no transcript')
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
  expect(card).toContain('1.2 MB')
  expect(card).toContain('mid-turn')
  expect(card).toContain('fresh')
  expect(card).toContain('no transcript')
})

// ---- ranking, capping, expansion ----------------------------------------------------------------

test('workers rank newest-activity first and report N of M', () => {
  const rows = Array.from({ length: 40 }, (_, i) => worker({ sid: `w${i}`, at: NOW - i * 60_000 }))
  const ranked = rankWorkers(rows, WORKER_ROWS)
  expect(ranked.rows).toHaveLength(WORKER_ROWS)
  expect(ranked.rows[0].sid).toBe('w0')
  expect(ranked.total).toBe(40)
  expect(renderCard([{ key: 'w', title: 'Workers', note: '', rows: ranked.rows, shown: WORKER_ROWS, total: 40 }], NOW))
    .toContain(`${WORKER_ROWS} of 40`)
  // Expanded shows more and stops claiming completeness only when it IS complete.
  const more = rankWorkers(rows, WORKER_ROWS_MORE)
  expect(more.rows).toHaveLength(WORKER_ROWS_MORE)
  expect(renderCard([{ key: 'w', title: 'Workers', note: '', rows: more.rows, shown: WORKER_ROWS_MORE, total: WORKER_ROWS_MORE }], NOW))
    .not.toContain(`${WORKER_ROWS_MORE} of`)
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
  expect(t).toMatch(/not<\/b> deleted|not.*deleted/i)
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

test('a conversation with no handle renders as a bare row, not a placeholder line', () => {
  const row = chatRow({ title: '' })
  const lines = renderCard([{ key: 'c', title: 'Chat', note: 'past', shown: 1, total: 1, rows: [row] }], NOW).split('\n')
  // The row is there and tappable; it just has nothing to quote, so it spends no line saying so.
  expect(lines.filter(l => l.startsWith('<b>1</b>'))).toHaveLength(1)
  expect(lines.some(l => l.startsWith('　'))).toBe(false)
  expect(tappable(row)).toBe(true)
})

// ---- layout: one row, one line -------------------------------------------------------------------
//
// The owner's first look at this card (0.5.85) reported it as one continuous paragraph: the rich
// MARKDOWN carrier reflows single newlines, so nine rows welded together. The card is an HTML panel
// now (htmlPanelToRich turns each "\n" into a <br>), and these pin the shape that fixes it — they
// fail against a render that joins rows, repeats a default label, or prints the folder twice.

const fullCard = () => renderCard([
  { key: 'c', title: 'Chat', note: 'past', shown: 2, total: 9, rows: [
    chatRow({ id: 'live', title: 'now', live: true }),
    chatRow({ id: 'c1', title: 'a fairly long opening line that will certainly need clamping down', mtime: NOW - 3_600_000 }),
  ] },
  { key: 'w', title: 'Workers', note: 'ended', shown: 3, total: 40, rows: [
    worker({ sid: 'w1', name: 'cc-bridge', folder: 'cc-bridge' }),
    worker({ sid: 'w2', name: 'api', folder: 'cc-bridge', cost: { kind: 'continues', backlog: '2 MB', midFlight: true } }),
    worker({ sid: 'w3', name: 'old', cost: { kind: 'gone' }, last: null }),
  ] },
], NOW)

test('every numbered row starts its own line, at line start', () => {
  const lines = fullCard().split('\n')
  // One line per number, and the number is the first thing on it (it maps to the keypad button).
  for (const n of [1, 2, 3]) {
    const hits = lines.filter(l => l.startsWith(`<b>${n}</b>`))
    expect(hits).toHaveLength(1)
  }
  // No line carries two rows — the exact defect: a line holding two numbers.
  expect(lines.filter(l => /<b>\d<\/b>.*<b>\d<\/b>/.test(l))).toHaveLength(0)
})

test('rows are separated by a blank line, and snippets stay on their own line', () => {
  const lines = fullCard().split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^<b>\d<\/b>/.test(lines[i])) continue
    expect(lines[i - 1]).toBe('')              // hard separation above every row
    const next = lines[i + 1]
    if (next && next !== '') expect(next.startsWith('　')).toBe(true)   // only an indented snippet may follow
  }
})

test('a snippet is one short line, never a wrapping paragraph', () => {
  for (const l of fullCard().split('\n').filter(l => l.startsWith('　'))) {
    expect(l.replace(/<[^>]+>/g, '').trim().length).toBeLessThanOrEqual(42)
  }
})

test('the default state prints no label — only the non-default ones do', () => {
  const card = fullCard()
  // "finished its turn" was on all six of the owner's rows and said nothing; the replay size stays.
  expect(card).not.toContain('finished its turn')
  expect(card).toContain('1.2 MB')
  expect(card).toContain('⏳ mid-turn')      // non-default: named
  expect(card).toContain('⚠️ no transcript') // non-default: named
  // …and the marker appears only on the rows that are actually in that state.
  expect(card.split('\n').filter(l => l.includes('⏳ mid-turn'))).toHaveLength(1)
})

test('the folder prints only when it differs from the name', () => {
  const card = fullCard()
  expect(card).not.toContain('cc-bridge</b> · cc-bridge')   // the duplication the owner reported
  expect(card).not.toContain('· · ')                        // …and no empty column where a number would be
  expect(card).toContain('<b>api</b> · cc-bridge')          // …but a real difference survives
})

test('section headers are distinct from rows and carry the count', () => {
  const lines = fullCard().split('\n')
  const headers = lines.filter(l => /^<b>[A-Z]+<\/b>/.test(l))
  expect(headers).toHaveLength(2)
  expect(headers[1]).toContain('3 of 40')
  // A header is preceded by a blank line and is not itself a numbered row.
  for (const h of headers) expect(lines[lines.indexOf(h) - 1]).toBe('')
})

// ---- the chat surface renders nothing: no markup may reach it ------------------------------------
//
// SOURCE-LEVEL enumeration, because these strings are inline template literals in daemon.ts rather
// than values a unit test can call. The owner's reopen confirmation reached him with literal
// backticks around @launch; the gesture helper that produced it is pinned in chat-verbs.test.ts, and
// this covers the OTHER shape — a `g === 'chat'` ternary arm written with markup in place.
test('no chat-voice branch in the kill/reopen/watch verbs emits markup', () => {
  const src = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
  // Every `g === 'cli' ? A : B` in the file: B is the chat voice and may not contain a backtick.
  const offenders: string[] = []
  for (const m of src.matchAll(/g === 'cli' \? (?:'[^']*'|`[^`]*`) : ('[^']*'|`[^`]*`)/g)) {
    if (m[1].includes('\\`') || /`.*`/.test(m[1].slice(1, -1))) offenders.push(m[1])
  }
  expect(offenders).toEqual([])
})
