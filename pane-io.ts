// Low-level tmux / pane I/O adapter.
//
// This is the single seam through which the bridge reads from and drives a session's
// terminal. It is deliberately side-effect free and importable (unlike daemon.ts, which
// boots the bot on import), so the fragile screen-scraping + key-injection primitives can
// be unit-tested and mocked in one place. Higher-level pane logic that depends on daemon
// state (PaneWatcher, injection guards, the focused-pane registry) stays in daemon.ts and
// calls down into these primitives.
import { exec, sleep, hashText } from './proc.ts'
import { logDecision } from './delivery-log.ts'

// Capture the visible pane contents (joined wrapped lines, ANSI preserved).
export async function capturePane(paneId: string): Promise<string> {
  const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', paneId, '-J'], { timeout: 3000 })
  return stdout
}

// The same capture with the terminal's attributes KEPT (`-e`). Exactly one question needs them: is
// the text in the input box something a person typed, or the CLI's own faint suggestion ghost
// (`inputBoxOccupant`). Every other detector keeps reading the plain capture above — colour is
// theme-dependent and parsing it is the trap prompt.ts's palette note describes.
export async function capturePaneStyled(paneId: string): Promise<string> {
  const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', paneId, '-J', '-e'], { timeout: 3000 })
  return stdout
}

// Pane validation + injection guard (opus-direct Block B).
//
// Three-valued on purpose. `paneAlive` answers a yes/no question with a "no" whether tmux said "there
// is no such pane" or tmux could not be reached at all — and those are opposite facts to anyone about
// to DELETE state on the strength of a death. On 2026-07-30 a daemon that could not exec tmux at all
// (deleted cwd → ENOENT) read every pane as gone and reaped the owner's chat-lane binding. Callers
// that only gate an action keep using paneAlive (refusing on 'unknown' is right for them); callers
// that destroy something ask for the third value and do nothing when they get it.
//
// The discriminator is execFile's own error shape: a NUMERIC `code` means tmux ran and exited nonzero
// (it looked, and there is no such pane), while a string code (ENOENT/ETIMEDOUT) or a kill signal
// means we never got an answer.
export type PaneLiveness = 'alive' | 'gone' | 'unknown'
export async function paneLiveness(paneId: string): Promise<PaneLiveness> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_id}'], { timeout: 2000 })
    return stdout.trim() === paneId ? 'alive' : 'gone'
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean }
    return typeof err?.code === 'number' && !err.killed ? 'gone' : 'unknown'
  }
}
export async function paneAlive(paneId: string): Promise<boolean> {
  return (await paneLiveness(paneId)) === 'alive'
}

export async function sendKeys(paneId: string, keys: string[]): Promise<boolean> {
  if (!(await paneAlive(paneId))) return false
  await exec('tmux', ['send-keys', '-t', paneId, ...keys], { timeout: 2000 })
  invalidateCapture(paneId)   // pane state just changed — force the next shared read fresh
  return true
}

// Send a literal string into the pane (tmux -l), so codes/URLs with characters
// that would otherwise be read as key names ("Enter", "C-c", "-foo") are typed
// verbatim. The trailing `--` guards strings that begin with a dash.
export async function sendKeysLiteral(paneId: string, text: string): Promise<boolean> {
  if (!(await paneAlive(paneId))) return false
  await exec('tmux', ['send-keys', '-l', '-t', paneId, '--', text], { timeout: 2000 })
  invalidateCapture(paneId)   // pane state just changed — force the next shared read fresh
  return true
}

// Move the option cursor down `n` rows, one press at a time. Sending the Downs as
// a single batch makes this TUI coalesce/drop them (the cursor doesn't move), so we
// space them out and let it settle before the caller's follow-up key.
export async function navigateDown(paneId: string, n: number): Promise<void> {
  if (n <= 0) return
  for (let i = 0; i < n; i++) {
    await sendKeys(paneId, ['Down'])
    await sleep(140)
  }
  await waitForSettle(paneId, 150, 2000)
}

// Block until the pane stops changing (its capture hash is stable for two polls) or
// `maxMs` elapses. Used after a key injection so the resulting redraw isn't mistaken
// for a new prompt/event.
export async function waitForSettle(paneId: string, pollMs: number, maxMs: number): Promise<void> {
  let lastHash = ''
  let sameCount = 0
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const text = await capturePane(paneId)
      const h = hashText(text)
      if (h === lastHash) {
        if (++sameCount >= 2) return
      } else {
        sameCount = 0
        lastHash = h
      }
    } catch { return }
    await sleep(pollMs)
  }
}

// Send submit keys and PROVE they landed, retrying once. A batched paste+Enter can outrun a pane's
// TUI and leave the block typed-but-unsubmitted (the topic-pane paste→submit race) — and because
// tmux happily reports success either way, that stuck delivery used to be recorded as delivered.
// This is the ONE implementation of that dance; `landed` is the caller's because "accepted" differs
// per surface (an emptied input box vs a disarmed bash box), and duplicating the retry instead is
// how two defences drift apart.
//
// The retry has its own race: if the first submit DID take but the TUI has not repainted, the
// capture still reads as pending and a second submit goes into a now-working pane. That is why the
// check happens only after waitForSettle — and it is safe besides: a stray Enter on an emptied box
// mid-turn is a no-op (observed on a live pane, it neither started a turn nor disturbed the one
// running). Failing to retry a genuinely swallowed key is the worse error.
export async function submitVerified(paneId: string, keys: string[], landed: (cap: string) => boolean): Promise<boolean> {
  // STYLED (`-e`), because `landed` reads the input box and the box is where the CLI paints its own
  // faint suggestion ghost. On a plain capture that ghost is indistinguishable from a stranded
  // delivery, and every submit onto a pane showing one would be re-Entered. The rest of pane-io keeps
  // reading plain captures — this is the one question that needs the attributes back.
  const took = async () => {
    const cap = await capturePaneStyled(paneId).catch(() => '')
    return !cap || landed(cap)   // pane unreadable: don't invent a delivery failure
  }
  await sendKeys(paneId, keys)
  await waitForSettle(paneId, 300, 5000)
  if (await took()) return true
  await sendKeys(paneId, keys)
  await waitForSettle(paneId, 300, 5000)
  return took()
}

// Clear a typed-but-unsubmitted line, ONLY when what is sitting there is our own. C-u clears without
// pressing Enter, so nothing runs. Two rules, and both matter: the pane must not be left holding half a
// command for the next injection to stack onto (that is how a retried `/compact` became
// `/compact/compact` on 2026-07-30), and it must not lose anyone else's text — whatever we did not type
// is somebody's draft and is not ours to erase. Shared by every path that types a command, so the two
// cannot drift apart. `boxContent` is injected because the input-box reader lives in prompt.ts and this
// module deliberately depends on nothing but proc.ts.
export async function clearOwnTypedLine(paneId: string, typed: string, boxContent: (cap: string) => string | null): Promise<void> {
  const box = boxContent(await capturePane(paneId).catch(() => '')) ?? ''
  if (!box || !typed.startsWith(box.split(/\s/)[0])) return
  await sendKeys(paneId, ['C-u'])
  await waitForSettle(paneId, 200, 3000)
}

// Paste text that starts with "/" into a pane and PROVE the submit landed — the mini-app composer's
// path, and the last member of the slash-verification family (v0.4.277 fixed the relay's `injectSlash`;
// this one still pressed a bare Enter and reported success whatever happened to it).
//
// It lives here, not in daemon.ts, for the reason the delivery lock does: daemon.ts boots the bot on
// import, so a test there could only re-implement this dance, and a re-implementation that drifts is a
// test that proves nothing about what ships. The predicates are injected for the same reason
// `submitVerified` takes `landed` — "occupied", "would misfire" and "accepted" are prompt.ts's reading
// of a screen, and this module stays free of that dependency.
//
// The caller supplies the lock and the watcher pause; this function assumes it already has its turn.
export type PastedSlash =
  | { ok: true }
  | { ok: false; occupied: string }      // someone's text was already in the box — nothing was typed
  | { ok: false; offered: string[] }     // the palette would have run something else — nothing submitted
  | { ok: false; unsubmitted: true }     // typed, two Enters swallowed, our own line cleared
export async function pasteSlashVerified(paneId: string, text: string, p: {
  submitKeys: string[]
  boxContent: (cap: string) => string | null
  boxOccupant: (styledCap: string) => string | null
  wouldMisfire: (cap: string, text: string) => string[] | null
  landed: (cap: string) => boolean
}): Promise<PastedSlash> {
  if (!(await paneAlive(paneId))) return { ok: false, offered: [] }
  // Refuse an occupied box rather than typing over it — `tg slash`'s rule, applied to this surface.
  // The read is taken HERE, after our turn in the delivery queue, so unlike a pre-queue gate it cannot
  // have gone stale by the time we paste. STYLED, and read through boxOccupant rather than boxContent:
  // this is the surface where the owner hit the CLI's suggestion ghost, and refusing his slash command
  // against text he never typed is the bug, not the guard.
  const before = await capturePaneStyled(paneId).catch(() => '')
  const occupied = before ? p.boxOccupant(before) : null
  if (occupied) return { ok: false, occupied }
  const buf = injectBuffer(paneId)
  await exec('tmux', ['set-buffer', '-b', buf, '--', text], { timeout: 2000 })
  await exec('tmux', ['paste-buffer', '-d', '-p', '-b', buf, '-t', paneId], { timeout: 2000 })
  await waitForSettle(paneId, 200, 4000)
  const offered = p.wouldMisfire(await capturePane(paneId).catch(() => ''), text)
  if (offered) {
    // Unconditional C-u here, exactly as injectSlash's palette guard does it: we pasted a moment ago
    // and pressed no Enter, so the box holds OUR text and nobody else's — the ownership check the
    // unsubmitted path needs would only risk leaving our own line behind if a palette overlay confused
    // the box reader. Leave the pane exactly as it was found.
    await sendKeys(paneId, ['C-u'])
    await waitForSettle(paneId, 200, 3000)
    return { ok: false, offered }
  }
  if (!(await submitVerified(paneId, p.submitKeys, p.landed))) {
    await clearOwnTypedLine(paneId, text, p.boxContent)
    return { ok: false, unsubmitted: true }
  }
  await waitForSettle(paneId, 300, 30_000)
  return { ok: true }
}

export async function windowHeightOf(paneId: string): Promise<number | null> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{window_height}'], { timeout: 2000 })
    const n = parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

export async function resizeWindowOf(paneId: string, rows: number): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{window_id}'], { timeout: 2000 })
    const win = stdout.trim()
    if (!win) return false
    await exec('tmux', ['resize-window', '-t', win, '-y', String(rows)], { timeout: 2000 })
    return true
  } catch { return false }
}

// Return a window to AUTOMATIC client-following size, undoing any manual `resize-window -y`. This is
// the robust restore after the /cost grow-to-80: a daemon crash/restart between grow and the restore
// would otherwise leave the window pinned tall, where Claude renders into a giant pane and the
// statusline (which the pin scraper reads) is unreadable. Idempotent — a no-op on a normal window.
export async function autoSizeWindowOf(paneId: string): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{window_id}'], { timeout: 2000 })
    const win = stdout.trim()
    if (!win) return false
    await exec('tmux', ['resize-window', '-t', win, '-A'], { timeout: 2000 })   // -A: size to the largest attached client
    return true
  } catch { return false }
}

export async function paneCommand(paneId: string): Promise<string> {
  try { const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_command}'], { timeout: 2000 }); return stdout.trim() } catch { return '' }
}

// Pane cwd with a short TTL cache — paneCwd is hit on every relay tick, and the tmux
// round-trip dominates. The cache is local to this module (the only reader of it).
const PANE_CWD_TTL_MS = 5_000
const _paneCwdCache = new Map<string, { at: number; cwd: string | null }>()
export async function paneCwd(paneId: string): Promise<string | null> {
  const hit = _paneCwdCache.get(paneId)
  if (hit && Date.now() - hit.at < PANE_CWD_TTL_MS) return hit.cwd
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', paneId, '#{pane_current_path}'], { timeout: 2000 })
    const cwd = stdout.trim() || null
    _paneCwdCache.set(paneId, { at: Date.now(), cwd })
    return cwd
  } catch { return null }
}

// Short-TTL shared capture of a pane's VISIBLE contents. The relay tick reads the focused pane every
// ~1.5s while its PaneWatcher already captures it every 800ms; capturePaneCached lets the relay reuse
// the watcher's recent capture (primed below) instead of spawning its own `tmux capture-pane`.
// Deliberately NOT used by PaneWatcher.tick / waitForSettle, which need FRESH reads to detect change.
// A key injection invalidates the entry (sendKeys/sendKeysLiteral/withInjection) so a stale
// pre-injection capture can never show an already-answered prompt and drive a double-inject.
const CAPTURE_TTL_MS = 700
const _captureCache = new Map<string, { at: number; text: string }>()
export function invalidateCapture(paneId: string): void { _captureCache.delete(paneId) }
function primeCapture(paneId: string, text: string): void { _captureCache.set(paneId, { at: Date.now(), text }) }
export async function capturePaneCached(paneId: string): Promise<string> {
  const hit = _captureCache.get(paneId)
  if (hit && Date.now() - hit.at < CAPTURE_TTL_MS) return hit.text
  const text = await capturePane(paneId)
  primeCapture(paneId, text)
  return text
}

// Delivery serialisation for pane writes. Lives HERE rather than in daemon.ts so the race it
// exists to prevent can be driven against a real tmux pane by a harness that imports the very
// same function — daemon.ts boots the bot on import, so a test there could only ever re-implement
// this, and a re-implementation that drifts is a test that proves nothing about what ships.

// ---- Delivery serialisation -------------------------------------------------------------------
// Getting text into a pane is NOT atomic: it is a paste followed by a separate Enter, tens of
// milliseconds to tens of seconds apart. Two deliveries overlapping in that window interleave —
// paste A, paste B into the same input box, then A's Enter submits BOTH as one message. Observed in
// production, on the owner's own session: an attach at 23:19:50.541 and a `send chars=24` at
// 23:19:52.393 arrived as a single transcript entry reading `…</tg>` + the second message's text.
//
// `PaneWatcher.withInjection` is NOT the guard against this and never was: it sets a boolean that
// pauses the watcher's polling, so two concurrent calls both set it, run interleaved, and the first
// to finish clears it while the second is still injecting. The focused pane was never safer than any
// other; it just also woke its watcher early.
//
// PER-PANE, not global: unrelated sessions must not queue behind one another's 30-second settles,
// and this box runs a dozen panes. FIFO, not try-lock: ordering is part of the contract — two
// messages from one person must arrive in the order they were sent, which is exactly the case that
// exposed this.
const paneDelivery = new Map<string, Promise<void>>()
// A session key survives a transactional %old → %fresh pane replacement. Callers that cannot yet
// resolve a registered session retain the historical per-pane isolation.
export const deliveryLockKey = (paneId: string, sessionId: string | null | undefined): string =>
  sessionId ? `session:${sessionId}` : `pane:${paneId}`
// A caller that cannot get its turn gives up rather than waiting forever. Comfortably past the
// longest legitimate hold (pasteGuarded's slash path can sit in a 30s settle), so this fires only
// when something is genuinely stuck.
export const DELIVERY_WAIT_MS = 45_000
// Overridable ONLY so the give-up path can be driven in a test in under a second instead of 45.
// A guard that has never been seen firing is a guard nobody has checked; see
// scripts/pane-delivery-race.ts. Nothing in the daemon writes it.
let waitMs = DELIVERY_WAIT_MS
export function setDeliveryWaitForTest(ms: number): void { waitMs = ms }
// NOT REENTRANT — a promise chain cannot be. Nothing wrapped in this may call anything else wrapped
// in it for the same pane, or the inner call waits on a tail its own caller is holding. The one
// place that could is pasteGuarded, whose non-slash branch delegates to injectText/pasteToPane and
// therefore deliberately does NOT wrap itself.
export async function withPaneDelivery<T>(paneId: string, fn: () => Promise<T>, timedOut: () => T): Promise<T> {
  const prev = paneDelivery.get(paneId) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(r => { release = r })
  // THE LOAD-BEARING LINE. What goes in the map is a tail that ALWAYS RESOLVES; the caller's own
  // rejection travels back through the value this function returns, never through the chain. Store
  // the rejecting promise instead and one failed delivery poisons every later delivery to that pane
  // — the lock turns a single lost message into a permanently wedged session.
  const tail = prev.then(() => mine)
  paneDelivery.set(paneId, tail)
  let timer: ReturnType<typeof setTimeout> | undefined
  const mineTurn = await Promise.race([
    prev.then(() => true),
    new Promise<boolean>(r => { timer = setTimeout(() => r(false), waitMs) }),
  ])
  if (timer) clearTimeout(timer)
  // NO STEALING. A timeout skips this delivery and reports failure; it never barges into a critical
  // section, because barging mid-paste is precisely the corruption being fixed. Losing a message
  // with a visible error beats corrupting one silently — every caller already surfaces a false.
  if (!mineTurn) { logDecision({ family: 'human', what: 'paste', target: paneId, pane: paneId, decision: 'REFUSED', predicate: `lock timeout ${Math.round(waitMs / 1000)}s` }); release(); return timedOut() }
  try { return await fn() }
  finally {
    release()
    // Don't accumulate one entry per pane the daemon has ever delivered to. If someone queued behind
    // us they have already replaced the tail, and this leaves theirs alone.
    if (paneDelivery.get(paneId) === tail) paneDelivery.delete(paneId)
  }
}

// Deliveries in flight or queued, right now. The map holds a tail per pane while anyone is holding
// or waiting for that pane's turn, and deletes it when the last one finishes — so its size IS the
// answer, with no second bookkeeping to drift.
export function paneDeliveriesInFlight(): number { return paneDelivery.size }

// Wait, bounded, for every pane delivery to finish. Called on shutdown, because process death inside
// the paste→Enter window is the one failure the in-process recovery cannot see: the message is
// already in the box and the Enter dies with the daemon. Draining removes that window instead of
// recovering from it (2026-08-03: a deploy killed the daemon 0.7s after the owner's message was
// pasted into the chat lane, and it sat unsent until a human pressed Enter).
//
// Bounded because a shutdown that waits forever is a worse failure than a stranded message: the
// caller reports the timeout and exits anyway, and the provenance record covers what was lost.
export async function drainPaneDeliveries(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (paneDelivery.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50))
  }
  return paneDelivery.size === 0
}

// The pasted payload's tmux buffer, PER PANE. It was one shared name, and deliveries to different
// panes run concurrently by design — so pane A's set-buffer, pane B's set-buffer, pane A's
// paste-buffer put B's message into A's session. Milliseconds wide and never reported, unlike the
// merge above, but the same root cause and worse in kind: a message in the wrong session.
// The queue does nothing for it, because the queue is per pane and this race is between panes.
// The rule already existed in one place — BANG_BUFFER was split out with the note that "a concurrent
// inbound paste could clobber a shared buffer mid-flight". This generalises it.
// The `tg-in-` prefix is not decoration: a sanitised pane id like `%149` becomes `-149`, and tmux
// would read a leading dash as an option.
export const injectBuffer = (paneId: string) => `tg-in-${paneId.replace(/[^A-Za-z0-9]+/g, '-')}`

// The paste dance, returning the outcome the boolean threw away. This is `CLAUDE.md` §Outbound's rule
// carried to the pane: **a failed delivery is either a REFUSAL or an UNKNOWN OUTCOME, and only a
// refusal may be re-sent.**
//
//   'occupied'    — somebody's real text was already in the box. NOTHING was typed, and a retry is
//                   right only once that text is gone — see the note on the check itself below.
//   'failed'      — tmux refused the paste. NOTHING reached the input box, so a full retry is right.
//   'unsubmitted' — the paste took, the Enter was not confirmed. The text IS in the box. A retry must
//                   press Enter again and MUST NOT paste again.
//   'landed'      — pasted and submitted.
//
// The middle one is the whole reason this exists. `submitVerified` returns false for two situations it
// cannot tell apart — nothing submitted, and "I could not confirm what submitted" — and a caller that
// reads that as "nothing was delivered" re-pastes. On 2026-08-02 that put the same @system ack into
// the chat lane twice, 6s apart (ledger held one row for it; the transcript held two copies), waking a
// Fable lane twice for one event. Re-pasting is also how a block can end up in the box TWICE with one
// Enter to submit both as one message — the interleave §Pane delivery already documents.
//
// The boundary is `paste-buffer`, not `set-buffer`: a buffer that was set but never pasted leaves the
// box untouched. Everything after a SUCCESSFUL paste-buffer is 'unsubmitted' on any failure, including
// a thrown one — the text is in the box whatever went wrong afterwards, and that is the fact the
// retry needs.
export type PasteOutcome = 'landed' | 'unsubmitted' | 'failed' | 'occupied'

// `occupant` is REQUIRED, not optional, and that is the point: a paste into an occupied box
// concatenates, and the single Enter that follows submits the stranded draft and this message as ONE
// turn — someone else's half-written words delivered as instructions under our envelope. The slash
// paths have refused on this since they were written; prose never checked at all, which is why asks
// kept landing while slashes refused on 2026-08-03. Making it a parameter rather than an import keeps
// this module free of prompt.ts (see the header); making it required means the next paste path cannot
// forget it.
//
// It must be GHOST-AWARE (`inputBoxOccupant`, never `inputBoxContent`): the CLI paints a suggested
// next message in the box itself, and refusing on that would brick the bus's main verb on text nobody
// typed. The read is taken here, inside the caller's delivery lock, so it cannot go stale before the
// paste — a pre-lock gate would be a TOCTOU.
export async function pasteVerified(
  paneId: string, text: string, keys: string[], landed: (cap: string) => boolean,
  occupant: (styledCap: string) => string | null,
): Promise<PasteOutcome> {
  const before = await capturePaneStyled(paneId).catch(() => '')
  if (before && occupant(before)) return 'occupied'
  const buf = injectBuffer(paneId)
  try {
    await exec('tmux', ['set-buffer', '-b', buf, '--', text], { timeout: 2000 })
    await exec('tmux', ['paste-buffer', '-d', '-p', '-b', buf, '-t', paneId], { timeout: 2000 })
  } catch { return 'failed' }
  try {
    await waitForSettle(paneId, 200, 4000)
    return (await submitVerified(paneId, keys, landed)) ? 'landed' : 'unsubmitted'
  } catch { return 'unsubmitted' }
}

// The recovery for 'unsubmitted': press Enter again at a box that already holds the block. Never
// pastes, so it cannot duplicate — which is the entire point of splitting the outcome.
export async function resubmitVerified(
  paneId: string, keys: string[], landed: (cap: string) => boolean,
): Promise<PasteOutcome> {
  try { return (await submitVerified(paneId, keys, landed)) ? 'landed' : 'unsubmitted' }
  catch { return 'unsubmitted' }
}

// PaneWatcher — ONE poll loop per active session (opus-direct Block C). Captures the pane every
// 800ms; when the content hash changes it fires onEvent, and onPoll fires every tick (even when
// unchanged) to drive a live working signal. All daemon coupling enters through the constructor
// callbacks, so the loop itself depends only on the pane-io primitives.
export class PaneWatcher {
  private lastHash = ''
  private injecting = false
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private paneId: string,
    private onEvent: (text: string) => void,
    private onDead: () => void,
    private onPoll?: (text: string) => void,   // every tick (even when unchanged) — drives typing
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 800)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async withInjection<T>(fn: () => Promise<T>): Promise<T> {
    this.injecting = true
    try { return await fn() }
    finally {
      // Re-baseline the change-detection hash AND refresh the shared cache with the post-injection
      // state, so a reader that runs right after doesn't reuse a pre-injection capture.
      try { const t = await capturePane(this.paneId); primeCapture(this.paneId, t); this.lastHash = hashText(t) } catch {}
      this.injecting = false
    }
  }

  private async tick(): Promise<void> {
    if (this.injecting) return
    let text: string
    try { text = await capturePane(this.paneId) }
    catch {
      // A failed capture is not proof of death — it is also what a daemon that cannot reach tmux at
      // all sees, for every pane at once (2026-07-30: `daemon: pane %330 died` for the owner's live
      // chat lane, whose binding the death handler then reaped). Confirm before declaring it, and
      // keep polling on 'unknown': the pane is either fine or will read 'gone' on a later tick.
      if ((await paneLiveness(this.paneId)) !== 'gone') return
      this.stop(); this.onDead(); return
    }
    primeCapture(this.paneId, text)     // write-through: let the relay tick reuse this fresh capture
    this.onPoll?.(text)                 // every poll — a live working signal even when static
    const h = hashText(text)
    if (h === this.lastHash) return
    this.lastHash = h
    this.onEvent(text)
  }
}
