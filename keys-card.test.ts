// The `/keys` card's guard rails. The two that matter are the parser (this is the only surface where
// a keystroke can be requested by tap, so it must not widen past `tg keys`) and the state line (a tap
// the owner cannot predict is worse than no button at all).
import { test, expect } from 'bun:test'
import { parseKeysCallback, keysKeyboard, pickerKeyboard, describePane, keysCardText, previewBlock,
  KEY_ROWS, PREVIEW_LINES, PREVIEW_TTL_MS, previewKey, armPreview, disarmPreview, strandedPreviews } from './keys-card.ts'
import { KEY_NAMES, normalizeKeys } from './keys-plan.ts'

test('every button on the card is a key the bus verb would also accept', () => {
  // The card and `tg keys` share one vocabulary on purpose: a button this normalizer refuses would
  // be a keystroke surface that drifted wider than the audited one.
  for (const row of KEY_ROWS) for (const b of row) {
    expect(KEY_NAMES).toContain(b.key)
    expect(normalizeKeys([b.key.toLowerCase()])).toEqual({ keys: [b.key] })
  }
})

test('the parser refuses any key outside the vocabulary, however the data is crafted', () => {
  expect(parseKeysCallback('keys:74e5aedb:Enter')).toEqual({ kind: 'key', sid: '74e5aedb', key: 'Enter' })
  expect(parseKeysCallback('keys:74e5aedb:Escape')).toEqual({ kind: 'key', sid: '74e5aedb', key: 'Escape' })
  // The whole point: a hand-crafted callback cannot smuggle a keystroke the bus verb would refuse.
  for (const bad of ['C-c', 'C-u', 'BSpace', 'q', 'Tab', 'rm -rf /'])
    expect(parseKeysCallback(`keys:74e5aedb:${bad}`)).toBeNull()
  // …nor a sid shaped like anything but a session id.
  expect(parseKeysCallback('keys:../../etc:Enter')).toBeNull()
  expect(parseKeysCallback('keys::Enter')).toBeNull()
  // …and nothing this card did not mint is claimed at all.
  expect(parseKeysCallback('strand:%72:submit')).toBeNull()
  expect(parseKeysCallback('keysomething')).toBeNull()
})

test('the parser reads the card’s own navigation actions', () => {
  expect(parseKeysCallback('keys:@pick')).toEqual({ kind: 'pick' })
  expect(parseKeysCallback('keys:74e5aedb:@refresh')).toEqual({ kind: 'refresh', sid: '74e5aedb' })
  expect(parseKeysCallback('keys:74e5aedb:@target')).toEqual({ kind: 'target', sid: '74e5aedb' })
})

test('every button the keyboard renders parses back to an action for THAT session', () => {
  // Round-trip, so a change to either half that the other does not follow fails here.
  const rows = keysKeyboard('1b6852bf', { pickable: true })
  const flat = rows.flat()
  expect(flat.length).toBe(KEY_ROWS.flat().length + 2)   // keys + 🎯 Session + 🔄 Refresh
  for (const b of flat) {
    const a = parseKeysCallback(b.data)
    expect(a).not.toBeNull()
    if (a && a.kind !== 'pick') expect(a.sid).toBe('1b6852bf')
    expect(b.data.length).toBeLessThanOrEqual(64)        // Telegram's callback_data ceiling
  }
  // Without another session to point at, the picker button is not offered.
  expect(keysKeyboard('1b6852bf', { pickable: false }).flat().some(b => b.data === 'keys:@pick')).toBe(false)
})

test('the picker addresses sessions by id, never by pane', () => {
  // A pane id in callback data goes stale across a restart and can be REUSED by another session, so
  // a tap on an old card would key a stranger. Nothing here may look like a pane.
  const rows = pickerKeyboard([{ sid: '74e5aedb', name: 'chat' }, { sid: 'f1610de2', name: 'weather' }])
  expect(rows.map(r => r[0]!.text)).toEqual(['@chat', '@weather'])
  for (const b of rows.flat()) expect(b.data).not.toMatch(/%\d/)
})

test('the state line names the wedge cases ahead of the quiet ones', () => {
  const base = { alive: true, working: false, queued: false, atPrompt: true, box: null }
  expect(describePane({ ...base, alive: false })).toContain('pane is gone')
  // Unsent text outranks everything else — it is the 2026-08-15 wedge, and Enter is the fix.
  expect(describePane({ ...base, box: 'Keep the replica as a backup', working: true })).toContain('Enter')
  expect(describePane({ ...base, box: 'Keep the replica as a backup' })).toContain('unsent text')
  expect(describePane({ ...base, queued: true })).toContain('queued')
  expect(describePane({ ...base, working: true })).toContain('mid-turn')
  expect(describePane({ ...base, atPrompt: false })).toContain('unrecognised screen')
  expect(describePane(base)).toContain('idle')
})

test('the state line escapes what the input box holds', () => {
  // A pane's box can hold anything; the card is HTML.
  expect(describePane({ alive: true, working: false, queued: false, atPrompt: true, box: '<b>x</b> & y' }))
    .toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
})

test('the preview is escaped, and a card without one carries no block at all', () => {
  const withPre = keysCardText({ name: 'chat', pane: '%72', state: 's', preview: 'a <b>&</b> b' })
  expect(withPre).toContain('<pre>a &lt;b&gt;&amp;&lt;/b&gt; b</pre>')
  // `undefined` is the 30s revert's render: no block, and the header/state/receipt survive intact.
  const reverted = keysCardText({
    name: 'chat', pane: '%72', state: 'STATE',
    last: { key: 'Enter', name: 'chat', pane: '%72', at: '08:44:12Z', ok: true },
  })
  expect(reverted).not.toContain('<pre>')
  expect(reverted).toContain('STATE')
  expect(reverted).toContain('Enter')
})

test('a failed capture and a quiet pane are different facts', () => {
  expect(previewBlock(null)).toContain('couldn’t read')
  expect(previewBlock('')).toBe('')
  expect(previewBlock('\n  \n')).toBe('')       // whitespace is not a screen worth showing
})

test('the preview never overflows a Telegram message, and drops from the TOP when it must', () => {
  // A 200-column, 30-line pane is 6000 raw chars — over the 4096 ceiling, where an overflowing card
  // is NOT a clipped card, it is no card. Width is truncated so the line COUNT survives; whole lines
  // go only when width alone is not enough, and always the oldest.
  const wide = Array.from({ length: PREVIEW_LINES }, (_, i) => `line${i} ` + 'x'.repeat(200)).join('\n')
  const block = previewBlock(wide)
  expect(block.length).toBeLessThan(4096 - 400)
  expect(block).toContain(`line${PREVIEW_LINES - 1}`)          // the newest line always survives
  expect(block).not.toContain('line0 ')                        // the oldest is what went
  expect(block).toContain('trimmed to fit')                    // and the card says so
  // A pane whose lines fit keeps all thirty and says nothing about trimming.
  const narrow = Array.from({ length: PREVIEW_LINES }, (_, i) => `line${i}`).join('\n')
  const ok = previewBlock(narrow)
  expect(ok).toContain('line0')
  expect(ok).not.toContain('trimmed to fit')
  // Ampersands quadruple under escaping — the budget is counted on the escaped text or this passes
  // in the test and overflows in the chat.
  expect(previewBlock(Array.from({ length: PREVIEW_LINES }, () => '&'.repeat(200)).join('\n')).length)
    .toBeLessThan(4096 - 400)
})

test('one live preview window per CARD — arming replaces, it never races', () => {
  // The failure this exists to stop: a tap inside a live window leaving two timers, so the card the
  // owner is still using gets reverted by the older one.
  const rec = { chat: '837047563', msgId: 900, sid: '74e5aedb' }
  let s = armPreview({}, rec, 1_000)
  s = armPreview(s, { ...rec, last: { key: 'Enter', name: 'chat', pane: '%72', at: 'x', ok: true } }, 2_000)
  expect(Object.keys(s)).toEqual([previewKey('837047563', 900)])
  expect(s[previewKey('837047563', 900)]!.at).toBe(2_000)        // the LATEST window is the live one
  expect(s[previewKey('837047563', 900)]!.last?.key).toBe('Enter')  // …and the receipt rides along
  // A different card in the same chat is a different window.
  s = armPreview(s, { chat: '837047563', msgId: 901, sid: 'f1610de2' }, 3_000)
  expect(Object.keys(s).length).toBe(2)
  // The same message id in a different chat, too — the key is the pair, not either half.
  s = armPreview(s, { chat: '999', msgId: 900, sid: '74e5aedb' }, 4_000)
  expect(Object.keys(s).length).toBe(3)
})

test('disarming drops exactly one card, and is a no-op on one that was never armed', () => {
  const s = armPreview(armPreview({}, { chat: 'c', msgId: 1, sid: 'a' }, 1), { chat: 'c', msgId: 2, sid: 'b' }, 2)
  expect(Object.keys(disarmPreview(s, previewKey('c', 1)))).toEqual([previewKey('c', 2)])
  expect(disarmPreview(s, previewKey('c', 99))).toBe(s)   // unchanged, same object
})

test('a restart strands every armed window, however old', () => {
  // Age is deliberately not a filter: the OLDEST record is the one most in need of reverting, since
  // its screenshot has been sitting in the chat the longest.
  const s = armPreview(armPreview({}, { chat: 'c', msgId: 1, sid: 'a' }, 1), { chat: 'c', msgId: 2, sid: 'b' }, Date.now())
  expect(strandedPreviews(s).sort()).toEqual([previewKey('c', 1), previewKey('c', 2)].sort())
  expect(strandedPreviews({})).toEqual([])
})

test('the preview window is the 30 seconds the owner asked for', () => {
  expect(PREVIEW_TTL_MS).toBe(30_000)
  expect(PREVIEW_LINES).toBe(30)
})

test('the receipt names the key, the session AND the pane', () => {
  // "a tap is never ambiguous": two cards open on two sessions must not be readable as each other.
  const txt = keysCardText({
    name: 'chat', pane: '%72', state: describePane({ alive: true, working: false, queued: false, atPrompt: true, box: null }),
    last: { key: 'Enter', name: 'chat', pane: '%72', at: '08:44:12Z', ok: true },
  })
  expect(txt).toContain('Enter')
  expect(txt).toContain('@chat')
  expect(txt).toContain('%72')
  expect(txt).toContain('08:44:12Z')
  // A refused send says so rather than reading as a success.
  expect(keysCardText({ name: 'chat', pane: '%72', state: '', last: { key: 'Enter', name: 'chat', pane: '%72', at: 'x', ok: false } }))
    .toContain('tmux refused it')
})
