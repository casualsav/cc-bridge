// Unit 2a source enumeration: every refusing branch the design note commissioned carries a
// logDecision (or the deliverAside `refused` wrapper), counted from daemon.ts by function body. The
// counts are the contract — a branch added silent, or a log call deleted, moves a number here.
// "Silent by design" branches are the note's §3 list; they are not counted and must not be.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
/** The body of a top-level function, from its declaration to the next top-level declaration. */
function bodyOf(decl: RegExp): string {
  const m = decl.exec(src)
  if (!m) throw new Error(`not found: ${decl}`)
  const start = m.index
  const next = /\n(?:async function |function |const |export |\/\/ ----)/g
  next.lastIndex = start + m[0].length
  const n = next.exec(src)
  return src.slice(start, n ? n.index : src.length)
}
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

test('bus family: tryDeliverAsk, deliverAside, deliverAnswerToAsker, the founding closure', () => {
  const t = bodyOf(/\nasync function tryDeliverAsk\(/)
  // no pane · record busy · registry SILENT (folded) · capture empty · gate ≠ deliver · record/screen
  // DISAGREE (v0.5.207, keyed per pane not per row) · box occupied (folded) · payload refused
  // (terminal, v0.5.189)
  expect(count(t, /logDecision\(\{/g)).toBe(8)
  expect(t).toContain("predicate: `paneFreedom=busy")
  expect(t).toContain('predicate: shown')
  expect(t).toContain('key: `freedomclash:${pane}`')
  expect(t).toContain('forgetDecision(`ask:${cur.id}`)')
  const a = bodyOf(/\nasync function deliverAside\(/)
  expect(count(a, /\brefused\('|\brefused\(`/g)).toBe(6)         // no pane · capture empty · paneAcceptsText · wedged · occupied · not-landed
  const d = bodyOf(/\nasync function deliverAnswerToAsker\(/)
  expect(count(d, /logDecision\(\{/g)).toBe(5)                    // closed row · dead asker · wedged/unreadable · timeout (unit 3) · not landed
  expect(count(src, /what: `founding \$\{p \? `ask \$\{p\.id\}` : 'message'\}`/g)).toBe(1)   // busDeliver=false in launchSpawn
})

test('bus family: every pre-createPending guard in the ask/ack/btw handler logs its refusal', () => {
  const start = src.indexOf("case 'ask': case 'ack': case 'btw':")
  expect(start).toBeGreaterThan(0)
  const body = src.slice(start, src.indexOf('createPending(', start))
  expect(count(body, /logDecision\(\{/g)).toBeGreaterThanOrEqual(12)
})

test('ctl family: slash pre-fail refusals, keys refusals, webapp composer refusals', () => {
  const s = bodyOf(/\nasync function relaySlashToSession\(/)
  expect(count(s, /logDecision\(\{/g)).toBe(4)                    // no pane · !paneRunsTypedInput · bashArmed · box occupied
  expect(s).toContain('key: `slash:${toSid}:${command}`')          // park polling repeats — guarded
  const kStart = src.indexOf("case 'keys':")
  expect(kStart).toBeGreaterThan(0)
  const k = src.slice(kStart, src.indexOf('daemon: bus keys', kStart))
  expect(count(k, /logDecision\(\{/g)).toBeGreaterThanOrEqual(9)
  const w = bodyOf(/\nasync function webappSessionAction\(/)
  expect(count(w, /logDecision\(\{/g)).toBeGreaterThanOrEqual(5)
})

test('the guard GC rides the bus sweep', () => {
  expect(bodyOf(/\nasync function sweepBus\(/)).toContain('gcDecisions(Date.now())')
})

// ---- Unit 2b (2026-08-17): the human / owner-direct / relay families, plus the two bus branches the 2a
// engineer found. Same contract: counts per function body, silent-by-design branches (design note §3.3–3.5)
// not counted. The four non-daemon files are enumerated by predicate text.
const other = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')

test('human family (daemon.ts): stranded pastes, bash box, the three handleInbound holds, the buffer paths, DM revival', () => {
  expect(count(bodyOf(/\nasync function recoverStrandedPastes\(/), /logDecision\(\{/g)).toBe(2)   // wait (keyed paste:) · drop
  expect(bodyOf(/\nasync function recoverStrandedPastes\(/)).toContain('key: `paste:${paneId}:${rec.chat}`')
  expect(count(bodyOf(/\nasync function offerStrandedPasteCard\(/), /logDecision\(\{/g)).toBe(1) // no targets (keyed paste-card:)
  expect(count(bodyOf(/\n(?:async )?function guardArmedBashBox\(/), /logDecision\(\{/g)).toBe(1)
  const h = bodyOf(/\nasync function handleInbound\(/)
  expect(h).toContain("predicate: 'resume picker on screen'")
  expect(h).toContain('key: `login:${effPane}`')
  expect(h).toContain('predicate: `recognizedScreen=false')
  expect(count(bodyOf(/\n(?:async )?function emitInbound\(/), /logDecision\(\{/g)).toBe(1)        // BUFFERED nothing focused
  expect(count(bodyOf(/\n(?:async )?function bufferEvent\(/), /logDecision\(\{/g)).toBe(1)        // DROPPED buffer write failed
  expect(count(bodyOf(/\nasync function reviveDmSession\(/), /logDecision\(\{/g)).toBe(3)         // no cwd · no pane · 90s deadline
})

test('owner family (daemon.ts): ownerDirectDispatch 4, ownerHermesAskCore 4', () => {
  expect(count(bodyOf(/\nasync function ownerDirectDispatch\(/), /logDecision\(\{/g)).toBe(4)
  expect(count(bodyOf(/\nasync function ownerHermesAskCore\(/), /logDecision\(\{/g)).toBe(4)
})

test('relay family (daemon.ts): the banner drop at all four sites, the sibling-stamp guard keyed, the unprimed cursor', () => {
  expect(count(src, /predicate: 'banner regex'/g)).toBe(4)
  const t = bodyOf(/\n(?:async )?function transcriptForPane\(/)
  expect(t).toContain('key: `transcript:${pane ?? \'-\'}`')
  expect(bodyOf(/\nasync function flushPendingTextFor\(/)).toContain("'unprimed relay cursor'")
})

test('bus family (2b extras): hermes dispatch failure after createPending, spawn-path repoDispatchPreflight', () => {
  expect(count(src, /predicate: `dispatchHermesAsk failed: \$\{start\.error\}`/g)).toBe(2)   // ask handler + ownerHermesAskCore
  expect(count(src, /predicate: `repoDispatchPreflight \(\$\{repoRoot\}\)`/g)).toBe(1)        // spawn path (the ask path already logged)
})

test('the four modules: access gate 7 of 9, pane-io lock give-up, owner-reply 5, transcript lost cursor', () => {
  const a = other('access.ts')
  for (const cls of ['dm-disabled', 'no-from', 'dm-not-allowlisted', 'pairing-replied-twice', 'pairing-table-full', 'group-unconfigured', 'group-sender-not-allowed'])
    expect(a).toContain(`predicate: 'access: ${cls}'`)
  expect(a).not.toMatch(/access: (mention|other)/)                                            // the two silent classes stay silent
  expect(other('pane-io.ts')).toContain('predicate: `lock timeout ${Math.round(waitMs / 1000)}s`')
  const o = other('owner-reply.ts')
  expect(count(o, /logDecision\(\{/g)).toBe(5)   // arm refused · aged out · evicted · retired · miss (keyed owner-route:)
  expect(o).toContain("predicate: 'route retired — session concluded a turn he did not start'")
  expect(o).toContain('key: `owner-route:${sid}`')
  const tr = other('transcript.ts')
  expect(count(tr, /logDecision\(\{/g)).toBe(1)   // the reader must not log per tick — one keyed line, lost cursor only
  expect(tr).toContain('key: `cursor:${file}`')
})

// The auto-install gate returned in silence for 19 days after `autoUpdate` was wiped out of prefs.json
// on 2026-07-30 (ask 769, 2026-08-18): the CLI stopped updating itself and daemon.log said nothing.
test('ctl family (updates.ts): the claude auto-install gate names the pref it refused on', () => {
  const u = other('updates.ts')
  expect(count(u, /logDecision\(\{/g)).toBe(1)                      // the autoUpdate gate — the sweep's other exits all log already
  expect(u).toContain("key: 'claude-install-sweep'")                // spawn-time calls repeat — guarded
  expect(u).toContain('predicate: `autoUpdate=${access.autoUpdate === undefined ? \'unset\' : String(access.autoUpdate)}`')
  expect(u).toContain('hint: PREFS_FILE')                           // an absent pref is only actionable with the file named
})
