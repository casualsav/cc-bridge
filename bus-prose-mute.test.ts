// PROSE FORCED OUT OF A BUS-WOKEN TURN, AND WHY NO CONTENT RULE CAN CATCH IT.
//
// A session woken by an ack, an aside or a digest is supposed to end its turn with no text. Claude
// Code treats a text-less turn as a fault and re-prompts it; since CLI 2.1.225 that re-prompt is not
// written to the transcript at all, so the existing drop (scanFinalReplies' `anchorIsBus && nudged`)
// is blind — its `nudged` flag comes from a row that no longer exists. The model, told to produce
// user-visible output, then writes the one thing it should never send: a bracketed note apologising
// for having nothing to say. The owner quoted one back on 2026-08-09:
//
//   [Ending turn silently — internal progress only; the owner gets one report when the history
//    scrub lands.]
//
// That is a real assistant text block by every test there is — real requestId, real tokens, ordinary
// prose. So the ANCHOR is what distinguishes it, not the words, and the surface decides: a worker's
// topic is a mirror where such a line is harmless, while a chat lane IS the owner's conversation.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')

// The decision, lifted out of daemon.ts (which boots a bot on import) by reading its source. The
// predicate is three terms and each one is load-bearing, so they are asserted as behaviour below
// against a local copy that must stay identical to it.
const muted = (sid: string | null, busAnchored: boolean, isLane: (s: string) => boolean): boolean =>
  busAnchored && sid != null && isLane(sid)

test('the predicate in daemon.ts is the one this file reasons about', () => {
  const fn = daemon.slice(daemon.indexOf('function busProseMuted('), daemon.indexOf('\n}', daemon.indexOf('function busProseMuted(')))
  expect(fn).toContain('busAnchored && sid != null && chatIdForDmChatSession(sid) != null')
})

const LANE = (s: string) => s === 'sid-lane'

test('a bus-woken chat lane says nothing into his conversation', () => {
  expect(muted('sid-lane', true, LANE)).toBe(true)
})

test("a worker's bus-woken prose is untouched — its topic is a mirror, not a conversation", () => {
  // This is the line that keeps the change surgical. Muting every bus-anchored reply everywhere
  // would take the worker topics quiet as well, and those are where he reads what a session did.
  expect(muted('sid-worker', true, LANE)).toBe(false)
})

test('a HUMAN-anchored turn is never muted, in a lane or anywhere else', () => {
  // The whole point of the chat lane. If this ever returns true the assistant goes mute in his DM,
  // which is a failure far worse than the noise being fixed.
  expect(muted('sid-lane', false, LANE)).toBe(false)
  expect(muted('sid-worker', false, LANE)).toBe(false)
})

test('an unresolved session is never muted — an unknown surface keeps its voice', () => {
  expect(muted(null, true, LANE)).toBe(false)
})

// COVERAGE. Four paths deliver a relayed reply (the repo learned this the hard way — see the relay
// claim in CLAUDE.md), and a mute on three of them is a leak that shows up only on whichever path
// happens to run. Every call site that passes an anchor to a send must consult the predicate first.
test('every relay path consults the mute — three call sites, none of them optional', () => {
  const calls = [...daemon.matchAll(/busProseMuted\(/g)]
  expect(calls.length).toBe(4)   // one definition + the three delivery paths
  // deliverRelayReply covers the focused and aux relay loops (both call it); the two pre-menu
  // preamble flushes send directly and are named here so a future path cannot be added silently.
  for (const site of ['async function deliverRelayReply(', 'pre-flush relaying', 'aux pre-flush relaying']) {
    const at = daemon.indexOf(site)
    expect(at).toBeGreaterThan(0)
    expect(daemon.slice(Math.max(0, at - 700), at + 200)).toContain('busProseMuted')
  }
})

test('the drop is LOUD and recoverable — it logs the text, and never deletes it', () => {
  // A silent drop of a reply is indistinguishable from a broken relay. The transcript keeps the
  // text either way, so the mini app's feed still shows it: this removes a message he must read,
  // not a record he might want.
  expect(daemon).toContain('MUTED bus-turn prose from chat lane')
  const log = daemon.slice(daemon.indexOf('MUTED bus-turn prose from chat lane'))
  expect(log.slice(0, 200)).toContain('text.slice(0, 120)')
})
