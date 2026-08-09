// The owner's DIRECT thread with a session — `@name <message>` typed in his DM, or a native reply to
// one of its cards — and the one thing that makes it direct: the answer is a card to HIM, and his chat
// lane (whose sid the ask row carries, because that is how his DM is found) is never woken by it.
//
// The failure this pins is silent and expensive: honour `ownerDirect` on the way out but forget it on
// the way back, and every answer is typed into his orchestrator instead — which then reads it, judges
// it and speaks, which is the entire round trip the gesture exists to skip. Nothing errors; he just
// gets his worker's answer secondhand, in someone else's words.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerRouteFor } from './agent-bus.ts'

const SYS = '@system'
const row = (o: Partial<{ fromSid: string; ownerDirect: true }> = {}) => ({ fromSid: 'sid-lane', ...o })

test('an owner-direct answer with a DM surface is a card to him, never a paste into the lane', () => {
  expect(answerRouteFor(row({ ownerDirect: true }), { systemSid: SYS, ownerChat: '111' })).toBe('owner-card')
})

test('an ordinary agent→agent answer is unchanged — it is typed into the asker session', () => {
  expect(answerRouteFor(row(), { systemSid: SYS, ownerChat: '111' })).toBe('pane')
  // ownerChat is only ever looked up FOR an owner-direct row, but a stray one must not reroute
  // traffic that was never his.
  expect(answerRouteFor(row(), { systemSid: SYS, ownerChat: null })).toBe('pane')
})

test('a @system ask still outranks everything: it has no asker session at all', () => {
  expect(answerRouteFor(row({ fromSid: SYS }), { systemSid: SYS, ownerChat: '111' })).toBe('system')
  expect(answerRouteFor({ fromSid: SYS, ownerDirect: true }, { systemSid: SYS, ownerChat: '111' })).toBe('system')
})

test('owner-direct with NO surface falls back to the pane rather than dropping the answer', () => {
  // The lane relaying it is a worse outcome than the one he asked for; losing it is worse than both.
  expect(answerRouteFor(row({ ownerDirect: true }), { systemSid: SYS, ownerChat: null })).toBe('pane')
  expect(answerRouteFor(row({ ownerDirect: true }), { systemSid: SYS, ownerChat: undefined })).toBe('pane')
})

// ---- The wiring, which the pure function above cannot see ---------------------------------------
// Two properties of the daemon side, each one line and each the whole feature if it goes missing.
const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')

test('both direct gestures mint through ONE dispatch, so they can never drift apart', () => {
  // `@name <message>` and a reply to a card are the same act. Two mints is how one of them quietly
  // loses `ownerDirect` and starts answering into the lane again.
  const mints = [...daemon.matchAll(/createPending\(\{[^}]*ownerDirect: true/g)]
  expect(mints.length).toBe(1)
  for (const fn of ['routeOwnerAddress', 'routeOwnerReply']) {
    const body = daemon.slice(daemon.indexOf(`async function ${fn}(`), daemon.indexOf(`async function ${fn}(`) + 3000)
    expect(body).toContain('ownerDirectDispatch')
  }
})

test("the answer card is routable — replying to it continues the thread with the SESSION that spoke", () => {
  // Without the msg-route the card is a dead end: he replies, and msg-routes has nothing to resolve,
  // so his follow-up lands in the lane as ordinary conversation — the exact thing he asked not to
  // have to do. The subject is the ANSWERER, not the surface the card landed on.
  const card = daemon.slice(daemon.indexOf('async function sendOwnerAnswerCard('), daemon.indexOf('// The chat lane\'s copy of a worker\'s post'))
  expect(card).toContain('rememberMsgRoute')
  expect(daemon).toContain('await sendOwnerAnswerCard(ownerChat!, answerer, shown, cur.toSid)')
})
