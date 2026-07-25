import { test, expect } from 'bun:test'
import { parsePaneList, newestPane, adoptionChoice, SESSION_PANE_OPT, LEGACY_PANE_OPT } from './session-identity.ts'

// Only the PURE half is covered here. sessionForPane / paneForSession / stampPaneSession drive a real
// tmux server through proc.exec; pane-io.test.ts owns the process-wide mock.module seam for that, and
// duplicating it here would leak the mock across files. Those three are UNVERIFIED — see the resume
// note in the audit doc.

const line = (id: string, legacy: string, activity: string, cwd: string, chan: string) =>
  [id, legacy, activity, cwd, chan].join('\t')
const allLive = () => true

test('parsePaneList keeps panes carrying this channel marker or the legacy one', () => {
  const out = [
    line('%1', '', '100', '/a', '1'),      // channel marker, discoverable
    line('%2', '', '200', '/b', 'pin'),    // channel marker, pinned
    line('%3', '1', '300', '/c', ''),      // legacy shared marker only
    line('%4', '', '400', '/d', ''),       // no marker at all -> not a bridge pane
    line('%5', '0', '500', '/e', '0'),     // markers explicitly off
    '',
  ].join('\n')
  expect(parsePaneList(out, allLive).map(p => p.id)).toEqual(['%1', '%2', '%3'])
})

test('parsePaneList records pinned and cwd liveness', () => {
  const out = [line('%1', '', '10', '/gone', '1'), line('%2', '', '20', '/here', 'pin')].join('\n')
  const panes = parsePaneList(out, p => p === '/here')
  expect(panes[0]).toMatchObject({ id: '%1', activity: 10, cwdLive: false, pinned: false })
  expect(panes[1]).toMatchObject({ id: '%2', activity: 20, cwdLive: true, pinned: true })
})

test('parsePaneList tolerates a blank/garbage listing', () => {
  expect(parsePaneList('', allLive)).toEqual([])
  expect(parsePaneList('\n\n', allLive)).toEqual([])
})

test('newestPane: an explicit pin beats a more recently active pane', () => {
  const panes = [
    { id: '%1', activity: 999, cwdLive: true, pinned: false },
    { id: '%2', activity: 1, cwdLive: true, pinned: true },
  ]
  expect(newestPane(panes)).toBe('%2')
})

test('newestPane: a live cwd beats a dead one, then most-recently-active wins', () => {
  expect(newestPane([
    { id: '%1', activity: 999, cwdLive: false, pinned: false },
    { id: '%2', activity: 5, cwdLive: true, pinned: false },
  ])).toBe('%2')
  expect(newestPane([
    { id: '%1', activity: 10, cwdLive: true, pinned: false },
    { id: '%2', activity: 20, cwdLive: true, pinned: false },
  ])).toBe('%2')
})

test('newestPane: all-dead cwds still yield a pane rather than nothing', () => {
  // Falling to null here would strand the bridge with no pane at all; a stale pane beats none.
  expect(newestPane([
    { id: '%1', activity: 10, cwdLive: false, pinned: false },
    { id: '%2', activity: 20, cwdLive: false, pinned: false },
  ])).toBe('%2')
})

test('newestPane: equal activity tiebreaks on the higher pane id, and empty is null', () => {
  expect(newestPane([
    { id: '%7', activity: 5, cwdLive: true, pinned: false },
    { id: '%12', activity: 5, cwdLive: true, pinned: false },
  ])).toBe('%12')
  expect(newestPane([])).toBeNull()
})

test('adoptionChoice adopts exactly one free candidate', () => {
  expect(adoptionChoice(['s1'], new Set())).toBe('s1')
})

test('adoptionChoice refuses to guess between same-cwd siblings', () => {
  // After a tmux-server restart wipes every stamp, adopting "the first" binds this pane to the wrong
  // session. A duplicate row beats cross-wiring two live sessions, so ambiguity must mint fresh.
  expect(adoptionChoice(['s1', 's2'], new Set())).toBeNull()
})

test('adoptionChoice ignores candidates a LIVE pane already holds', () => {
  expect(adoptionChoice(['s1', 's2'], new Set(['s2']))).toBe('s1')   // s2 taken -> s1 is the lone free one
  expect(adoptionChoice(['s1'], new Set(['s1']))).toBeNull()          // the only candidate is claimed
  expect(adoptionChoice([], new Set())).toBeNull()
})

test('the session stamp is the channel-neutral one Telegram already writes', () => {
  // Regression guard on the decision, not the value: minting a per-channel stamp would give a pane
  // bridged to two channels two identities and two histories. See session-identity.ts header.
  expect(SESSION_PANE_OPT).toBe('@tg_session')
  expect(LEGACY_PANE_OPT).toBe('@tg_bridge')
})
