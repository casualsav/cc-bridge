// When the auto-refresh sweep may restart a session — the owner's ruling, 2026-08-20.
//
// He reached it from the resume-cost card v0.5.178 sent him: it named the price of bringing
// @hourlystudy back (242.3k tokens), and his answer was that the bill should never have existed.
// Verbatim: "If there is context sitting there, it should not run, for that very reason that it costs
// money to bring that transcript back up. Auto update should work between sessions, after clears, or
// any other clean seams where it won't cost anything like that… but it should not have that behavior
// of restarting an idle session that has context sitting in it."
//
// Every gate the sweep had asked "is this pane free to type into". None asked "is there anything here
// worth money" — and IDLE is not that question, which is why an idle 242k-token session was its
// favourite target.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planRefreshSeam, refreshSummaryHeld } from './refresh-seam.ts'

const esc = (s: string) => s

// The four states the ruling names, as evidence the CLI actually produces.
// MEASURED on a live `--probe` session, 2026-08-20 — the ctxPct values are not illustrative:
// a fresh spawn reads 20% and a pane seconds after `/clear` reads 19%, because the system prompt,
// CLAUDE.md and memory load before a word is exchanged. That is why the decision cannot key on
// "context > 0" and keys on the CONVERSATION instead.
const IDLE_WITH_CONTEXT = { conversation: 'loaded' as const, ctxPct: 24 }    // @hourlystudy at 10:30Z
const FRESH_SPAWN = { conversation: 'unwritten' as const, ctxPct: 20 }       // never used — still reads 20%
const AFTER_CLEAR = { conversation: 'unwritten' as const, ctxPct: 19 }       // new conversation, not written yet
const CLEARED_WRITTEN = { conversation: 'empty' as const, ctxPct: 19 }       // …its file exists, no turn in it
const UNREADABLE = { conversation: 'unknown' as const, ctxPct: null }        // no record

test('THE RULING: an idle session with context is never refreshed', () => {
  const v = planRefreshSeam(IDLE_WITH_CONTEXT)
  expect(v.refresh).toBe(false)
  expect(v).toHaveProperty('why', 'it has a conversation — a restart replays it at model rates')
})

// THE CONTROL. The old rule was the four gates above this one, and @hourlystudy passed every one of
// them at 19:33Z: not restarting, no hold, safeToType, no turn in progress, no live subagents. That
// is what "idle" bought it. This asserts the only fact that changed — nothing about its idleness.
test('CONTROL: the old rule refreshed exactly this session, and idleness is why', () => {
  const oldRuleWouldRefresh = (_e: typeof IDLE_WITH_CONTEXT) => true   // no gate looked at the conversation
  expect(oldRuleWouldRefresh(IDLE_WITH_CONTEXT)).toBe(true)
  expect(planRefreshSeam(IDLE_WITH_CONTEXT).refresh).toBe(false)
})

test('a clean seam IS refreshed — a fresh spawn, and a pane that just cleared', () => {
  expect(planRefreshSeam(FRESH_SPAWN)).toEqual({ refresh: true })
  expect(planRefreshSeam(AFTER_CLEAR)).toEqual({ refresh: true })
  expect(planRefreshSeam(CLEARED_WRITTEN)).toEqual({ refresh: true })
})

// THE MEASUREMENT THAT KILLED THE FIRST VERSION OF THIS RULE. It gated on `ctxPct > 0`, which reads
// as obvious and refuses every seam there is — a fresh spawn and a cleared pane both sit at ~20%
// before anyone has said anything. The baseline reloads on any launch and costs nothing extra.
test('a loaded baseline is NOT a conversation — every seam here reads ~20%', () => {
  for (const e of [FRESH_SPAWN, AFTER_CLEAR, CLEARED_WRITTEN]) {
    expect(e.ctxPct).toBeGreaterThan(0)
    expect(planRefreshSeam(e).refresh).toBe(true)
  }
})

test('an unidentifiable conversation is treated as a loaded one — the errors are not symmetric', () => {
  const v = planRefreshSeam(UNREADABLE)
  expect(v.refresh).toBe(false)
  expect(v).toHaveProperty('why', 'its conversation could not be identified, so it cannot be called empty')
})

test('the summary names what it left alone, and says when it moves', () => {
  expect(refreshSummaryHeld([], esc)).toBe('')
  expect(refreshSummaryHeld([{ name: 'hourlystudy', why: 'it has a conversation' }], esc))
    .toBe('\n\n💤 Left on the old build: <b>hourlystudy</b> (it has a conversation). '
      + 'It moves across when it clears or ends — restarting it now would cost you the reload.')
  const two = refreshSummaryHeld([{ name: 'a', why: 'x' }, { name: 'b', why: 'y' }], esc)
  expect(two).toContain('<b>a</b> (x); <b>b</b> (y)')
  expect(two).toContain('They move across when they clear or end')
})

// ---- bound to the shipped sweep -----------------------------------------------------------------

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const between = (from: string, to: string): string => {
  const a = daemon.indexOf(from)
  const b = daemon.indexOf(to, a)
  return a >= 0 && b > a ? daemon.slice(a, b) : ''
}
const sweep = between('async function autoRefreshStaleSessions(', 'function updateDashboardKeyboard(')

test('call site: the sweep asks the seam gate, off the CLI\'s own evidence', () => {
  expect(sweep).toContain('planRefreshSeam({')
  expect(sweep).toContain('const rec = recordedConversation(pane)')
  expect(sweep).toContain("rec.kind === 'file' ? (latestFinalReply(rec.file) ? 'loaded' : 'empty') : rec.kind")
  expect(sweep).toContain('if (!seam.refresh) {')
})

test('call site: a held session is NAMED, never silently skipped', () => {
  expect(sweep).toContain('withContext.push({ name, why: seam.why })')
  expect(sweep).toContain('auto-refresh HOLD on @')
  expect(between('async function settleRestartedSessions(', 'async function restartAllStaleSessions('))
    .toContain('refreshSummaryHeld(held, escapeHtml)')
})

// The sweep can no longer resume ANYTHING: a session with a conversation is refused upstream, so the
// only lane left is the fresh relaunch. If `restartPaneSessionCore` ever reappears in this function,
// the sweep has regained the ability to spend his money without asking.
test('call site: the sweep never resumes a conversation — that stays a human tap', () => {
  expect(sweep).not.toContain('restartPaneSessionCore(t.pane, t.id')   // the CALL, not the comment naming it
  expect(sweep).toContain('await relaunchFreshSession(t)')
  expect(sweep).toContain('id: null')
  // …while the TAPPED flow keeps it, because that is him choosing to spend the reload.
  expect(between('async function restartAllStaleSessions(', 'settleRestartedSessions(targets'))
    .toContain('restartPaneSessionCore(t.pane, t.id)')
})

test('call site: the card claims a clean seam, not merely an idle session', () => {
  const settle = between('async function settleRestartedSessions(', 'async function restartAllStaleSessions(')
  expect(settle).toContain('at a clean seam onto')
  // The claim itself, not the file: the incident comment above it legitimately quotes the old wording.
  expect(settle).toContain("`♻️ Auto-refreshed ${n === 1 ? 'one session' : `${n} sessions`} at a clean seam onto")
})
