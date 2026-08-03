// TRIPWIRE for bug 11b (DIAGNOSIS-bug11-wedged-fleet-member.md): `tg ask` reported success for an ask
// that never landed. `void tryDeliverAsk(p)` discarded the outcome and the CLI printed the same
// "asked @X (ask N) — async" string whether the target took it, was mid-turn, was wedged on an
// unrecognized screen, or had no live pane at all. The owner spent an hour believing @ccbridge was
// working on two asks it could never see.
//
// The contract this pins: EVERY delivery outcome maps to its own CLI line, and exactly ONE of them —
// 'delivered' — may read as done. Adding a new outcome without giving it a distinguishable, honest
// line turns the enumeration test red instead of shipping another silent success.
import { test, expect } from 'bun:test'
import { askResultText, ASK_DELIVERY_STATES, type AskDelivery } from './agent-bus.ts'

// The exact pre-fix string, kept as a regression fixture: it must never come back for an outcome that
// did not land. (It read as a completed action, which is why an orchestrator moved on.)
const legacy = (name: string, id: number) => `asked @${name} (ask ${id}) — async; they answer with \`tg answer ${id}\``

test('a landed delivery says so, unambiguously', () => {
  const t = askResultText('delivered', 'ccbridge', 95)
  expect(t).toContain('delivered')
  expect(t).toContain('95')
  expect(t).not.toMatch(/QUEUED|NOT DELIVERED/)
})

test('11b: a mid-turn target is reported as queued, never as done', () => {
  const t = askResultText('busy', 'ccbridge', 95)
  expect(t).toContain('QUEUED')
  expect(t).toMatch(/mid-turn|busy/i)
  expect(t).not.toBe(legacy('ccbridge', 95))
})

// The distinction the owner asked for: "mid-turn" is normal and self-clearing; "not at a prompt with
// no turn running" is the @ccbridge shape and means nothing will ever reach it unaided.
test('11b: a wedged target is distinguishable from a merely busy one', () => {
  const wedged = askResultText('wedged', 'ccbridge', 95)
  const busy = askResultText('busy', 'ccbridge', 95)
  expect(wedged).not.toBe(busy)
  expect(wedged).toContain('NOT DELIVERED')
  expect(wedged).toMatch(/wedged|not at a prompt/i)
})

test('11b: a target with no live session is reported as such', () => {
  const t = askResultText('no-session', 'ccbridge', 95)
  expect(t).toContain('NOT DELIVERED')
  expect(t).toMatch(/not running|no live/i)
})

test("an occupied box is never described as OUR message sitting unsubmitted", () => {
  // The two look alike and lead opposite ways. 'not-landed': our block IS in their box and a retry
  // presses Enter. 'occupied': their own typed text is in the box, nothing of ours was pasted, and no
  // retry helps until a human clears it. Told apart because the merged wording sent a reader hunting
  // for our message in a box that had never held it — verified live on 2026-08-03 against a real
  // staged draft, which reported the 'not-landed' sentence before this split.
  const t = askResultText('occupied', 'ccbridge', 95)
  expect(t).toContain('NOT DELIVERED')
  expect(t).toMatch(/their|OWN/i)                       // whose text it is, is the whole point
  expect(t).not.toMatch(/sitting unsubmitted/i)         // that claim belongs to 'not-landed' alone
  expect(askResultText('not-landed', 'ccbridge', 95)).toMatch(/sitting unsubmitted/i)   // control
})

// THE TRIPWIRE. Enumerate the outcomes; only 'delivered' may read as done, and no two may collide.
test('TRIPWIRE: every delivery outcome has its own honest line', () => {
  const seen = new Map<string, AskDelivery>()
  for (const s of ASK_DELIVERY_STATES) {
    const t = askResultText(s, 'ccbridge', 95)
    expect(t.length, `outcome "${s}" must produce a line`).toBeGreaterThan(0)
    expect(t, `outcome "${s}" must never reproduce the pre-fix success string`).not.toBe(legacy('ccbridge', 95))
    const prior = seen.get(t)
    expect(prior, `outcomes "${s}" and "${prior}" produce the SAME line — they are indistinguishable to the asker`).toBeUndefined()
    seen.set(t, s)
    if (s !== 'delivered') {
      expect(t, `outcome "${s}" did not land, so its line must not claim delivery`).not.toMatch(/^delivered\b/)
      expect(t, `outcome "${s}" must be flagged as not-yet-delivered`).toMatch(/QUEUED/)
    }
  }
})
