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
import { readFileSync } from 'node:fs'
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

// ---- queue depth: the number that stops a fan-out building a bottleneck --------------------------
//
// Five asks behind one session read exactly like one from outside — both are "busy" — so an
// orchestrator stacked five without seeing it and learned only from what never came back (owner's
// box, 2026-08-09). The count rides the reply to the command doing the stacking.

test('a queued outcome names how many the target already holds unanswered', () => {
  const t = askResultText('busy', 'ccbridge', 95, 4)
  expect(t).toContain('4 unanswered ahead of it')
  // Inside the `(ask N …)` parenthesis, not trailing the line: a sender has stopped reading by the
  // time the "they answer with" instruction is over.
  expect(t).toMatch(/\(ask 95, 4 unanswered ahead of it\)/)
  // And it is the ONLY difference — the rest of the outcome's line is untouched.
  expect(t.replace(', 4 unanswered ahead of it', '')).toBe(askResultText('busy', 'ccbridge', 95))
})

// THE ONE THIS UNIT EXISTS FOR, and the half a first draft got backwards. A mid-turn target still
// TAKES an ask (the CLI queues it), so the stacked asks in that incident were every one of them
// reported 'delivered' — measured live against a real probe the same day, three sends, three
// "delivered", `queuedFor` empty throughout. A depth shown only on the queued outcomes would be
// silent in precisely the case it was built for.
test('DELIVERED carries the depth too — that outcome is where a fan-out actually stacks', () => {
  const t = askResultText('delivered', 'ccbridge', 95, 3)
  expect(t).toContain('3 unanswered ahead of it')
  expect(t).toMatch(/^delivered\b/)                    // still says what it did: the pane took it
  expect(t).not.toMatch(/QUEUED|NOT DELIVERED/)        // and does not borrow an outcome it isn't
})

test('every outcome carries the depth — there is no silent one', () => {
  for (const s of ASK_DELIVERY_STATES) {
    expect(askResultText(s, 'ccbridge', 95, 3), `outcome "${s}" took the message but did not say how deep`)
      .toContain('3 unanswered ahead of it')
  }
})

test('an empty queue says nothing at all — no "0 already queued"', () => {
  for (const s of ASK_DELIVERY_STATES) {
    expect(askResultText(s, 'ccbridge', 95, 0)).toBe(askResultText(s, 'ccbridge', 95))
    expect(askResultText(s, 'ccbridge', 95, 0)).not.toMatch(/ahead of it/)
  }
})

// The roster half of the same fact. STRUCTURAL, like the hidden-endpoint guards in
// slash-outcome.test.ts and for the same reason: `case 'roster'` lives inside handleCall's switch,
// which needs a socket, a tmux pane and a live endpoint store to run. It would have failed against
// the line as it stood before this unit, which is what earns it a place.
test('the roster line reports queue depth beside the one ask it already named', () => {
  const daemon = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
  const roster = daemon.slice(daemon.indexOf("case 'roster': {"))
  const body = roster.slice(0, roster.indexOf('\n      }\n'))
  // openAsksFor, NOT queuedFor: the bus-side queue is empty for the stack this counts (see the note
  // on openAsksFor in daemon.ts). Pinned by name because the two readers are one word apart and the
  // wrong one produces a segment that is always absent.
  expect(body).toContain('openAsksFor(e.id)')
  expect(body).not.toContain('queuedFor(e.id)')
  expect(body).toMatch(/\$\{queued \? ` · \$\{queued\} queued`/)
  // `on ask N` names the injected row only — the segment it sits beside, and the reason the rest were
  // invisible. If that ever goes away, this count is describing something no reader can see.
  expect(body).toContain('· on ask ')
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
