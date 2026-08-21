// THE FOUNDING ASK CARRIES THE CAPSULE BY REFERENCE, AND THE PREFIX IS NOT THE CALLER'S WORDS.
//
// In one day (2026-08-21) the chat lane restated the plugin-cache rule into nine bodies, the
// shared-checkout rule into ten, `bun run deploy` into fifteen — facts the repo's own capsule already
// held, retyped because a fresh session has never read it. Four fields prepended to the founding
// message costs ~150 tokens per spawn and the rest of the capsule stays one `tg repo` away.
//
// The half that is easy to get wrong is WHOSE WORDS THEY ARE. The prefix is the bridge speaking; the
// spawner's card, the ledger row and the ask row are the caller's message and must stay it, or the
// owner reads a brief he never approved as one his lane wrote.
//
// Source-bound half: `CC_BRIDGE_SRC_DIR=<dir holding HEAD's daemon.ts> bun test founding-prefix.test.ts`
// must FAIL exactly the call-site tests.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyBrief, foundingPrefix, type RepoBrief } from './repo-brief.ts'

const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
const has = (s: string): void => { expect(daemon.includes(s) ? s : `MISSING from daemon.ts: ${s}`).toBe(s) }

const FULL: RepoBrief = {
  ...emptyBrief(),
  what: 'a Claude Code ↔ Telegram bridge',
  verify: 'bun test && ./node_modules/.bin/tsc --noEmit -p .',
  assumptions: ['the live daemon runs from the plugin cache, not this checkout', 'HANDOFF.md is gitignored'],
  hazards: ['the checkout is shared by concurrent sessions — explicit paths on every git verb'],
  conventions: ['edit .ts here, then `bun run deploy`'],
}

test('four fields, in the order a worker needs them, marked as the bridge\'s', () => {
  expect(foundingPrefix(FULL, '/home/ubuntu/projects/cc-bridge')).toBe([
    'Repo brief (bridge-added — `tg repo /home/ubuntu/projects/cc-bridge` for the rest):',
    '· do not assume: the live daemon runs from the plugin cache, not this checkout · HANDOFF.md is gitignored',
    '· hazards: the checkout is shared by concurrent sessions — explicit paths on every git verb',
    '· conventions: edit .ts here, then `bun run deploy`',
    '· verify: bun test && ./node_modules/.bin/tsc --noEmit -p .',
    '',
    '',
  ].join('\n'))
})

test('a line whose field is empty is omitted, and an empty capsule prefixes nothing', () => {
  const thin = foundingPrefix({ ...emptyBrief(), what: 'x', verify: 'bun test' }, '/r')
  expect(thin).toBe('Repo brief (bridge-added — `tg repo /r` for the rest):\n· verify: bun test\n\n')
  expect(thin).not.toContain('hazards')
  // A header over nothing is worse than no header: the deterministic fallback has none of the four.
  expect(foundingPrefix(emptyBrief(), '/r')).toBe('')
})

test('the prefix ends in a blank line, so the message below it reads as its own', () => {
  const msg = foundingPrefix(FULL, '/r') + 'Build U3.'
  expect(msg.split('\n').at(-1)).toBe('Build U3.')
  expect(msg.split('\n').at(-2)).toBe('')
})

// ---- source-bound: which text goes to the pane, and which to every surface ----

test('D1 — the spawn verb builds the prefix, and only after the preflight has passed', () => {
  has('if (briefed) founding = foundingPrefix(briefed.brief, repoRoot)')
  // Only when there IS a first message: nothing to prefix otherwise, and the block is never pasted.
  has("const briefed = String(args.text ?? '').trim() ? loadBriefRecord(STATE_DIR, repoRoot) : null")
  // ONE mint. The owner's `@launch` runs no preflight and must never acquire this.
  expect(daemon.match(/foundingPrefix\(/g) ?? []).toHaveLength(1)
})

test('D2 — the PANE gets the prefixed text; nothing else does', () => {
  has("const pasteMsg = (spec.briefPrefix ?? '') + firstMsg")
  has('formatAskBlock(fromName, p.id, pasteMsg, foundingRefs, false, !!spec.ownerDirect)')
  expect(daemon.match(/pasteMsg/g) ?? []).toHaveLength(2)   // the definition and its ONE use
  // The owner's `@launch` takes `firstMsg` by construction, not because nothing sets the field: his
  // envelope carries his own words, and a bridge-written brief inside it is a message he never sent.
  has('ownerInboundBlock(firstMsg, ownerChat, spec.ownerMsgId, foundingRefs)')
})

test('D3 — the spawner\'s card and the ask row keep the lane\'s own words', () => {
  // The chevron the owner reads. `firstMsg`, never `pasteMsg` — a bridge-written brief attributed to
  // his lane is a report of a request nobody made.
  has('if (firstMsg) void notifyBusRich(fromSid, spawnHeader, reason ? `why: ${reason}\\n\\n${firstMsg}` : firstMsg, sid)')
  // The ask row (target card, digest, `tg history`) and the ledger row.
  has('toSid: sid, fromName, toName: topicName, text: firstMsg')
  has("kind: 'ask', from: fromName, to: topicName, id: p.id, text: firstMsg")
})

test('D4 — the prefix rides the spec, so a spawn held for the owner\'s tap keeps it', () => {
  has('briefPrefix?: string;')
  has("...(founding ? { briefPrefix: founding } : {})")
})
