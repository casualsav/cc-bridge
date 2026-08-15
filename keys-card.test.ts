// The `/keys` card's guard rails. The two that matter are the parser (this is the only surface where
// a keystroke can be requested by tap, so it must not widen past `tg keys`) and the state line (a tap
// the owner cannot predict is worse than no button at all).
import { test, expect } from 'bun:test'
import { parseKeysCallback, keysKeyboard, pickerKeyboard, describePane, keysCardText, KEY_ROWS } from './keys-card.ts'
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
