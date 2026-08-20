// The owner's resume-picker card. Every assertion here is against the REAL picker @hourlystudy has
// been sitting on since 19:33:50Z on 2026-08-20 (`fixtures/pane-resume-wedge.txt`), because the two
// things that can go wrong are both about that screen: pressing the wrong row (it discards a
// 242.3k-token conversation) and telling him about it more than once.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectResumeSessionPrompt } from './prompt.ts'
import {
  planResumeOptions, planResumeCardText, planResumeOutcome, planResumeCardMint, resumePickerSig, paneGlance,
} from './resume-picker-card.ts'

const WEDGED = readFileSync(join(import.meta.dir, 'fixtures/pane-resume-wedge.txt'), 'utf8')
const picker = detectResumeSessionPrompt(WEDGED)!

// ---- the button → key map -----------------------------------------------------------------------

test('the picker is read whole: options, cursor, and the size claim it makes', () => {
  expect(picker.options.map(o => o.label)).toEqual([
    'Resume from summary (recommended)', 'Resume full session as-is', "Don't ask me again",
  ])
  expect(picker.current).toBe(0)
  expect(picker.scale).toEqual({ age: '10h 21m', tokens: '242.3k' })
})

test('every offered option carries the exact keys that select it', () => {
  const offered = planResumeOptions(picker.options, picker.current)
  expect(offered.map(o => [o.idx, o.keys.join(' ')])).toEqual([
    [0, 'enter'],                 // the cursor is already here — and this is the destructive one
    [1, 'down enter'],
    [2, 'down down enter'],
  ])
})

test('buttons say what the tap COSTS, not what the CLI calls it', () => {
  const offered = planResumeOptions(picker.options, picker.current)
  expect(offered.map(o => o.button)).toEqual([
    '📝 Summary — drops the conversation',
    '💰 Keep it all — costs usage',
    '⚙️ Stop asking (every session)',
  ])
  // "Resume from summary (recommended)" is the CLI's own recommendation and the one that loses the
  // work. A button that repeated that wording would be the trap in a nicer place.
  expect(offered[0].button).not.toMatch(/recommended/i)
})

test('an option this build cannot name keeps the CLI label verbatim rather than being guessed at', () => {
  const offered = planResumeOptions([{ label: 'Resume with vendor caching' }, { label: 'Resume full session as-is' }], 0)
  expect(offered[0].button).toBe('Resume with vendor caching')
})

// NO CURSOR, NO KEYS — the same rule the roster hint follows. Down-presses are counted from where
// the ❯ sits, so a picker whose cursor cannot be found gets no buttons at all.
test('no readable cursor ⇒ no buttons, and the card says why', () => {
  const noCursor = WEDGED.replace('❯ 1.', '  1.')
  const p = detectResumeSessionPrompt(noCursor)!
  expect(p.current).toBeNull()
  const offered = planResumeOptions(p.options, p.current)
  expect(offered).toEqual([])
  const text = planResumeCardText({ name: 'hourlystudy', cwd: null, scale: p.scale, options: p.options, offered })
  expect(text).toContain("I can't tell which option is highlighted")
  expect(text).toContain('Answer it at the terminal')
})

// ---- the card text ------------------------------------------------------------------------------

test('the card names the session, its folder and the size the PICKER claims', () => {
  const offered = planResumeOptions(picker.options, picker.current)
  const text = planResumeCardText({
    name: 'hourlystudy', cwd: '/home/ubuntu/projects/weather', scale: picker.scale, options: picker.options, offered,
  })
  expect(text).toContain('<b>@hourlystudy</b>')
  expect(text).toContain('<code>/home/ubuntu/projects/weather</code>')
  expect(text).toContain('<b>242.3k tokens</b>')
  expect(text).toContain('10h 21m old')
  expect(text).toContain('nothing is pressed on your behalf')
  // Each option is listed by the number its button carries, so the card and the keyboard agree.
  expect(text).toContain('<b>1.</b> Resume from summary (recommended)')
  expect(text).toContain('<b>2.</b> Resume full session as-is')
})

test('the outcome edit says what was kept or lost, and what the row reads now', () => {
  const offered = planResumeOptions(picker.options, picker.current)
  expect(planResumeOutcome({ name: 'hourlystudy', chosen: offered[1], glance: '🟢 idle, back at its prompt' }))
    .toBe('✅ <b>@hourlystudy</b> — resumed in full; the conversation is intact.\n\nIts row now reads: 🟢 idle, back at its prompt')
  expect(planResumeOutcome({ name: 'hourlystudy', chosen: offered[0], glance: '🟢 idle, back at its prompt' }))
    .toContain('the previous conversation is gone')
})

test('the glance speaks the roster row vocabulary', () => {
  expect(paneGlance({ blocked: 'resume picker', working: false, atPrompt: false })).toBe('⛔ blocked: resume picker')
  expect(paneGlance({ blocked: null, working: true, atPrompt: false })).toBe('🟡 busy')
  expect(paneGlance({ blocked: null, working: false, atPrompt: true })).toBe('🟢 idle, back at its prompt')
  expect(paneGlance({ blocked: null, working: false, atPrompt: false })).toBe('🟡 not at a prompt yet')
  // Blocked outranks everything, exactly as it does in sessionState — a card that opened onto a
  // roster row disagreeing with it is the failure this vocabulary exists to prevent.
  expect(paneGlance({ blocked: 'login menu', working: true, atPrompt: true })).toBe('⛔ blocked: login menu')
})

// ---- one card per picker, not one per sweep -----------------------------------------------------
//
// THE KNOWN-ANSWER CONTROL for this rule is the incident itself: the old dedup was an in-memory Map,
// so @hourlystudy's card went out SIX times, each 1.5s after a daemon restart. The signature is
// content-derived and the mark is persisted, so a restart changes nothing and only a genuinely new
// picker mints again.
test('the same picker never mints twice — including across a daemon restart', () => {
  const sig = resumePickerSig(picker.options, picker.scale)
  expect(planResumeCardMint(null, sig)).toBe('mint')          // first sight
  expect(planResumeCardMint(sig, sig)).toBe('skip')           // a repaint on the next poll
  // The restart: everything in memory is gone, the persisted row is not. This is the exact step the
  // old Map could not take, and the one that sent six cards.
  const afterRestart = JSON.parse(JSON.stringify({ [sig]: 1 }))
  expect(planResumeCardMint(Object.keys(afterRestart)[0], sig)).toBe('skip')
})

test('a genuinely new picker mints again — a later restart, a different conversation', () => {
  const sig = resumePickerSig(picker.options, picker.scale)
  expect(planResumeCardMint(sig, resumePickerSig(picker.options, { age: '11h 02m', tokens: '242.3k' }))).toBe('mint')
  expect(planResumeCardMint(sig, resumePickerSig(picker.options, { age: '10h 21m', tokens: '318.9k' }))).toBe('mint')
  expect(planResumeCardMint(sig, resumePickerSig([{ label: 'Resume from summary' }, { label: 'Resume full session as-is' }], picker.scale))).toBe('mint')
})

// ---- bound to the shipped code ------------------------------------------------------------------
//
// The planners above are pure and would pass against a build that sends the card nowhere. These pin
// the three things the owner's ruling is actually about: it reaches HIM, nothing is pressed without
// a tap, and the keys are re-derived at press time rather than trusted from an old card.

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const between = (from: string, to: string): string => {
  const a = daemon.indexOf(from)
  const b = daemon.indexOf(to, a)
  return a >= 0 && b > a ? daemon.slice(a, b) : ''
}

test('call site: the card goes to the owner\'s own chat, never the worker topic', () => {
  const relay = between('async function relayResumeChoice(', '\n}\n')
  expect(relay).toContain('ownerCardChats()')
  expect(relay).not.toContain('outboundTargetsFor')
  expect(between('function ownerCardChats(', '\n}')).toContain('listDmChatSessions()')
})

test('call site: the mint mark is PERSISTED, so a restart cannot re-send it', () => {
  const relay = between('async function relayResumeChoice(', '\n}\n')
  expect(relay).toContain('loadResumeCards()')
  expect(relay).toContain('saveResumeCards(rows)')
  expect(relay).toContain("planResumeCardMint(rows[paneId]?.sig ?? null, sig) === 'skip'")
})

test('call site: the press re-derives its keys from a FRESH capture, and presses nothing otherwise', () => {
  const apply = between('async function applyResumeChoice(', '\n}\n')
  expect(apply).toContain('detectResumeSessionPrompt(cap)')
  expect(apply).toContain('planResumeOptions(picker.options, picker.current)')
  // A picker that has left the screen presses nothing — the card can be hours old.
  expect(apply).toContain('nothing was pressed')
})

test('call site: nothing presses this picker unattended', () => {
  // The ONLY caller of applyResumeChoice is the callback handler, which is gated on cbAuth. If a
  // sweep or timer ever calls it, this fails — which is the owner's ruling, expressed as a count.
  expect(daemon.split('applyResumeChoice(').length - 1).toBe(2)   // the definition + the one tap
  expect(between("const resumeSelMatch = /^resumesel:", 'applyResumeChoice(')).toContain('cbAuth(ctx)')
})
