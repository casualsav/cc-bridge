// Scheduled-message domain module.
//
// Owns the queue of future messages (persisted to disk), their setTimeout arming, and the
// Telegram-facing list/cancel UI. Extracted from daemon.ts as the first Phase 3 domain carve.
//
// The daemon wires it once via initScheduler(): the scheduler depends on the bot, the access
// loader, and a single injectToPane(paneId, text) callback that hides all the daemon's
// focus/PaneWatcher logic. Everything else here is self-contained.
import { InlineKeyboard, type Context } from 'grammy'
import { join } from 'node:path'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { escapeHtml } from './markdown.ts'
import { paneAlive } from './pane-io.ts'
import { toInputRichMessage, type InputRichMessage } from './richmsg.ts'
import { fmtWhen, nextRecurrence, recurrenceLabel } from './time.ts'
import type { Access, ScheduledMessage } from './types.ts'
import type { ChannelAdapter, Button } from './channel.ts'

// Button[][] → grammy InlineKeyboard, for scheduleDashboard's grammy-Context reply path (inbound;
// migrates in a later batch). Outbound sends use channel.sendText's neutral `buttons` directly.
function toKb(buttons: Button[][]): InlineKeyboard {
  const kb = new InlineKeyboard()
  buttons.forEach((row, i) => { if (i) kb.row(); for (const b of row) b.url ? kb.url(b.text, b.url) : kb.text(b.text, b.data ?? '') })
  return kb
}

const SCHEDULED_MSGS_FILE = join(STATE_DIR, 'scheduled-messages.json')
export const MAX_TIMEOUT = 2_147_483_647   // setTimeout's ceiling (~24.8 days); longer waits re-arm

// 'busy' — the daemon checked paneSafeToType (a FRESH capture) and the pane isn't safe for an
// unattended keystroke right now (a dialog, a working turn, a non-empty composer, …). Distinct from
// a delivery failure: fireScheduled re-arms the SAME row on 'busy' instead of removing/rolling it —
// a gated "not now" must never lose the message the way a plain failure report would.
type InjectOutcome = 'ok' | 'busy' | 'failed'

type SchedulerDeps = {
  channel: ChannelAdapter
  loadAccess: () => Access
  // Deliver `text` into a pane. The daemon implements this with its own focus state: inject (with
  // watcher pause) if the pane is focused, else plain paste — gated first on paneSafeToType, which
  // is where 'busy' comes from.
  injectToPane: (paneId: string, text: string) => Promise<InjectOutcome>
  // Recurring job whose session is gone: spawn a fresh session in `cwd`, wait for the REPL, and
  // deliver there — cron jobs outlive their sessions. Returns the new pane id, or null when the
  // spawn/delivery failed.
  reviveAndInject: (cwd: string, text: string) => Promise<string | null>
  // Send a panel as a rich message with the classic HTML string as its fallback. The daemon owns
  // the bot token and the fallback plumbing, so it injects this rather than scheduler.ts calling
  // the raw rich API itself.
  showPanel: (ctx: Context, rich: InputRichMessage, html: string, keyboard: InlineKeyboard) => Promise<void>
}

let deps: SchedulerDeps
let scheduledMsgs: ScheduledMessage[] = []
const scheduledTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function initScheduler(d: SchedulerDeps): void { deps = d }

function saveScheduledMsgs(): void { writeJsonFile(SCHEDULED_MSGS_FILE, scheduledMsgs) }

function armScheduled(msg: ScheduledMessage): void {
  const prev = scheduledTimers.get(msg.id); if (prev) clearTimeout(prev)
  const delay = Math.min(Math.max(0, msg.fireAt - Date.now()), MAX_TIMEOUT)
  scheduledTimers.set(msg.id, setTimeout(() => void fireScheduled(msg.id), delay))
}

export function cancelScheduled(id: string): void {
  const t = scheduledTimers.get(id); if (t) clearTimeout(t)
  scheduledTimers.delete(id)
  busyRetries.delete(id)
  scheduledMsgs = scheduledMsgs.filter(m => m.id !== id)
  saveScheduledMsgs()
}

// Chats + threaded-send for a message's own notices — shared by deliverScheduled's per-attempt
// notes and fireScheduled's give-up report, so the two can't drift onto different surfaces.
function chatNotifier(msg: ScheduledMessage): (t: string) => void {
  const chats = msg.chatId ? [msg.chatId] : deps.loadAccess().allowFrom
  return (t: string) => {
    for (const c of chats) {
      void deps.channel.sendText(String(c), t, { ...(msg.thread ? { threadId: String(msg.thread) } : {}) })
        .catch(() => msg.thread ? deps.channel.sendText(String(c), t, {}).catch(() => {}) : undefined)
    }
  }
}

// A 'busy' injectToPane outcome means the pane genuinely isn't safe to type into right now (a
// dialog, a working turn, …) — retried on its own short timer, keyed off the message id rather than
// the persisted row, so a restart simply forgets in-flight retries instead of mis-tracking them.
const BUSY_RETRY_MS = 30_000
const BUSY_RETRY_MAX = 60   // 30 minutes — long working turns are real; give-up drops a one-shot, so match the split-merge hold bound
const busyRetries = new Map<string, number>()

async function fireScheduled(id: string): Promise<void> {
  const msg = scheduledMsgs.find(m => m.id === id)
  if (!msg) return
  if (Date.now() < msg.fireAt - 1000) { armScheduled(msg); return }   // capped long wait → re-arm
  const result = await deliverScheduled(msg)
  if (result === 'busy') {
    const attempts = (busyRetries.get(id) ?? 0) + 1
    if (attempts <= BUSY_RETRY_MAX) {
      // Row untouched — a gated "not now" must not lose the message the way removing/rolling it
      // (the normal post-fire step below) would.
      busyRetries.set(id, attempts)
      scheduledTimers.set(id, setTimeout(() => void fireScheduled(id), BUSY_RETRY_MS))
      process.stderr.write(`scheduler: pane busy for "${msg.sessionLabel}" — retry ${attempts}/${BUSY_RETRY_MAX} in 30s\n`)
      return
    }
    busyRetries.delete(id)
    process.stderr.write(`scheduler: gave up on "${msg.sessionLabel}" after ${BUSY_RETRY_MAX} busy retries — pane never cleared\n`)
    chatNotifier(msg)(`⚠️ Gave up delivering your scheduled message to <b>${escapeHtml(msg.sessionLabel)}</b> — its pane kept showing a dialog/turn. It was NOT sent:\n\n${escapeHtml(msg.text)}`)
    // Falls through to the normal roll/remove below — a recurring job skips to its NEXT natural
    // occurrence rather than stacking a re-try of the one that just gave up.
  } else {
    busyRetries.delete(id)
  }
  if (msg.recur) {
    // Recurring: roll to the next occurrence instead of removing (cancel is the only way out).
    msg.fireAt = nextRecurrence(msg.recur, Date.now())
    saveScheduledMsgs()
    armScheduled(msg)
  } else {
    scheduledMsgs = scheduledMsgs.filter(m => m.id !== id)
    scheduledTimers.delete(id)
    saveScheduledMsgs()
  }
}

async function deliverScheduled(msg: ScheduledMessage): Promise<InjectOutcome> {
  const note = chatNotifier(msg)
  if (!msg.paneId || !(await paneAlive(msg.paneId))) {
    // Recurring jobs outlive sessions: revive one in the job's folder and deliver there. The new
    // pane becomes the job's target so the next fire injects directly.
    if (msg.recur && msg.cwd) {
      note(`⏰ <b>${escapeHtml(msg.sessionLabel)}</b> is gone — starting a session in <code>${escapeHtml(msg.cwd)}</code> for the scheduled job…`)
      const pane = await deps.reviveAndInject(msg.cwd, msg.text)
      if (pane) { msg.paneId = pane; saveScheduledMsgs() }   // next fire injects directly
      note(pane
        ? `📤 Sent the scheduled message to the new session:\n\n${escapeHtml(msg.text)}`
        : `⚠️ Couldn't start a session in <code>${escapeHtml(msg.cwd)}</code> — this run was skipped.`)
      return pane ? 'ok' : 'failed'
    }
    note(`⏰ Couldn't send your scheduled message — <b>${escapeHtml(msg.sessionLabel)}</b> is gone:\n\n${escapeHtml(msg.text)}`)
    return 'failed'
  }
  const result = await deps.injectToPane(msg.paneId, msg.text)
  if (result === 'busy') return 'busy'
  note(result === 'ok'
    ? `📤 Sent your scheduled message to <b>${escapeHtml(msg.sessionLabel)}</b>:\n\n${escapeHtml(msg.text)}`
    : `⚠️ Couldn't deliver your scheduled message to <b>${escapeHtml(msg.sessionLabel)}</b>.`)
  return result
}

// Queue a freshly-built message: persist, arm its timer, and report. Called by the daemon when
// a user replies to a /schedule force-reply.
export function addScheduled(msg: ScheduledMessage): void {
  scheduledMsgs.push(msg)
  saveScheduledMsgs()
  armScheduled(msg)
}

export function scheduledCount(): number { return scheduledMsgs.length }

// Structured view of the schedule (Mini App automation board): id + label fields only, no timers.
export function listScheduled(): Array<{ id: string; fireAt: number; sessionLabel: string; text: string; recurLabel: string | null }> {
  return scheduledMsgs.map(m => ({ id: m.id, fireAt: m.fireAt, sessionLabel: m.sessionLabel, text: m.text, recurLabel: m.recur ? recurrenceLabel(m.recur) : null }))
}

export function loadScheduledMsgs(): void {
  const arr = readJsonFile<unknown>(SCHEDULED_MSGS_FILE, null)
  if (Array.isArray(arr)) scheduledMsgs = arr.filter((m): m is ScheduledMessage =>
    m && typeof m.id === 'string' && typeof m.fireAt === 'number' && typeof m.text === 'string')
  for (const m of scheduledMsgs) armScheduled(m)   // overdue ones fire ~immediately
}

export function scheduledListText(): string {
  const lines = scheduledMsgs.map((m, i) =>
    `${i + 1}. ${m.recur ? `🔁 ${recurrenceLabel(m.recur)} (next ${fmtWhen(m.fireAt)})` : fmtWhen(m.fireAt)} → <b>${escapeHtml(m.sessionLabel)}</b>: ${escapeHtml(m.text.length > 40 ? m.text.slice(0, 39) + '…' : m.text)}`)
  return `📅 <b>Scheduled messages</b>\n${lines.join('\n')}\n\nTap to cancel:`
}

// Rich rendering of the same list: a native table, so the message no longer has to be truncated to
// 40 chars to keep the line short — the column wraps instead. A cell can't hold a raw "|" (it would
// split the column) or a newline (it would end the row), so both are neutralised.
export const escapeTableCell = (s: string): string => escapeHtml(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
export function scheduledListMarkdown(): string {
  const cell = escapeTableCell
  const rows = scheduledMsgs.map((m, i) => {
    const when = m.recur ? `🔁 ${cell(recurrenceLabel(m.recur))} · next ${cell(fmtWhen(m.fireAt))}` : cell(fmtWhen(m.fireAt))
    return `| ${i + 1} | ${when} | ${cell(m.sessionLabel)} | ${cell(m.text)} |`
  })
  return `## 📅 Scheduled messages\n\n| # | When | Session | Message |\n|---|---|---|---|\n${rows.join('\n')}\n\nTap to cancel:`
}

export function scheduledCancelKeyboard(): Button[][] {
  const rows: Button[][] = []
  let row: Button[] = []
  scheduledMsgs.forEach((m, i) => { row.push({ text: `🗑 ${i + 1}`, data: `schedcancel:${m.id}` }); if ((i + 1) % 4 === 0) { rows.push(row); row = [] } })
  if (row.length) rows.push(row)
  return rows
}

export async function scheduleDashboard(ctx: Context): Promise<void> {
  if (scheduledMsgs.length === 0) {
    await ctx.reply('📅 <b>No scheduled messages.</b>\n\nSchedule one with <code>/cron 2h ping the server</code> (also: <code>every 09:00 …</code> or a 5-field cron expr), or tap ➕ to compose one.',
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('➕ Add', 'sched:add') })
    return
  }
  const kb = toKb(scheduledCancelKeyboard())
  kb.row().text('➕ Add', 'sched:add')
  await deps.showPanel(ctx, toInputRichMessage(scheduledListMarkdown()), scheduledListText(), kb)
}
