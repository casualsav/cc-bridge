// Slack bridge daemon — the MVP loop (multi-channel.md P3). A NEW thin entrypoint composing the
// already-neutral core (pane-io, transcript, prompt) with SlackAdapter; it does NOT import from,
// and never touches, the Telegram daemon.ts. Where daemon.ts has glue we need (pane discovery,
// bracket-paste inject, prompt-answer keystrokes, the single-instance guard) we reimplement a slim
// copy here, citing the source lines. Run in the foreground for now: `bun slack-daemon.ts`.
import net from 'node:net'
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { exec, sleep, hashText } from './proc.ts'
import { capturePane, paneAlive, paneCwd, sendKeys, waitForSettle, navigateDown } from './pane-io.ts'
import { resolveTranscript, finalRepliesAfter, latestFinalReply } from './transcript.ts'
import { detectPermissionPrompt, detectUserPrompt, onNormalPrompt, type PermissionPrompt, type PromptInfo } from './prompt.ts'
import { SlackAdapter } from './slack-adapter.ts'
import type { InboundMsg, MsgRef, Button } from './channel.ts'
import {
  SLACK_STATE_DIR, SLACK_ACCESS_FILE, SLACK_PID_FILE, SLACK_SOCKET_PATH, SLACK_LOG_FILE,
  SLACK_INBOX_DIR, loadSlackEnv,
} from './slack-paths.ts'

const BRIDGE_PANE_OPT = '@tg_bridge'   // same adopt marker as Telegram — a Claude session is a Claude session
const INJECT_BUFFER = 'slk-inbound'

function log(msg: string): void {
  const line = `${new Date().toISOString()} slack: ${msg}\n`
  try { appendFileSync(SLACK_LOG_FILE, line) } catch {}
  process.stderr.write(line)
}

// ---- Config + token validation ----
loadSlackEnv()
const APP_TOKEN = process.env.SLACK_APP_TOKEN ?? ''
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
if (!APP_TOKEN || !BOT_TOKEN) {
  const missing = [!APP_TOKEN && 'SLACK_APP_TOKEN (xapp-…)', !BOT_TOKEN && 'SLACK_BOT_TOKEN (xoxb-…)'].filter(Boolean).join(' and ')
  process.stderr.write(
    `slack-daemon: missing ${missing}.\n` +
    `Add it to ${SLACK_STATE_DIR}/.env and restart:\n` +
    `  SLACK_APP_TOKEN=xapp-…   (Socket Mode app-level token, scope connections:write)\n` +
    `  SLACK_BOT_TOKEN=xoxb-…   (Bot User OAuth token)\n`)
  process.exit(1)
}

// ---- Single-instance guard (after daemon.ts socketAlive/acquireInstance ~8927) ----
async function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(SLACK_SOCKET_PATH)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1000)
  })
}
async function acquireInstance(): Promise<boolean> {
  try {
    const pid = parseInt(readFileSync(SLACK_PID_FILE, 'utf8'), 10)
    if (pid > 1 && pid !== process.pid) {
      let alive = false
      try { process.kill(pid, 0); alive = true } catch {}
      if (alive && await socketAlive()) { log(`another instance running (pid=${pid}), exiting`); return false }
    }
  } catch {}
  try { unlinkSync(SLACK_SOCKET_PATH) } catch {}
  mkdirSync(SLACK_STATE_DIR, { recursive: true, mode: 0o700 })
  return true
}

// ---- Access control (MVP: { allowFrom: string[] } of Slack user ids) ----
function loadAllow(): string[] {
  try { const a = JSON.parse(readFileSync(SLACK_ACCESS_FILE, 'utf8')); return Array.isArray(a?.allowFrom) ? a.allowFrom : [] } catch { return [] }
}

// ---- Pane discovery (after daemon.ts findOffMcpPanes ~1588; slim — no remote-control filter) ----
async function findBridgePanes(): Promise<string[]> {
  let out = ''
  try {
    const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', `#{pane_id}\t#{${BRIDGE_PANE_OPT}}`], { timeout: 3000 })
    out = stdout
  } catch { return [] }
  const panes: string[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [paneId, mark] = line.split('\t')
    if (mark === '1') panes.push(paneId)   // default instance id (slot 1)
  }
  return panes
}
// Most-recently-created pane wins: tmux pane ids (%N) increment, so the highest N is newest.
function newestPane(panes: string[]): string | null {
  if (panes.length === 0) return null
  return [...panes].sort((a, b) => Number(b.replace('%', '')) - Number(a.replace('%', '')))[0]
}

// ---- Pane injection (after daemon.ts injectPaste ~334) ----
// Bracket-paste `text` as one block (embedded newlines don't submit early), then Enter to submit.
async function injectPaste(paneId: string, text: string): Promise<boolean> {
  if (!(await paneAlive(paneId))) return false
  await exec('tmux', ['set-buffer', '-b', INJECT_BUFFER, '--', text], { timeout: 2000 })
  await exec('tmux', ['paste-buffer', '-d', '-p', '-b', INJECT_BUFFER, '-t', paneId], { timeout: 2000 })
  await waitForSettle(paneId, 200, 4000)
  await sendKeys(paneId, ['Enter'])
  await waitForSettle(paneId, 300, 5000)
  return true
}

// ---- Daemon state (one-pane MVP) ----
const channel = new SlackAdapter(APP_TOKEN, BOT_TOKEN)
let activePane: string | null = null
let relayCursor = ''                                  // last relayed assistant-reply uuid
let replyTarget: { chatId: string; threadId?: string } | null = null   // where relayed replies + prompt cards go
let lastPromptHash = ''                               // dedup the same prompt across pane repaints
let promptCard: { ref: MsgRef; pane: string; kind: 'perm' | 'select'; options: number } | null = null
let injectChain: Promise<unknown> = Promise.resolve()  // serialize inbound so pastes never interleave

function enqueueInject(fn: () => Promise<unknown>): Promise<unknown> {
  injectChain = injectChain.then(fn, fn)
  return injectChain
}

// The inbound block the pane's Claude session reads (off-mcp/CLAUDE.md convention: <tg ID …>TEXT</tg>;
// downloaded files ride as att="path"). Reuses the <tg …> tag so the session's existing CLAUDE.md
// parsing applies unchanged.
function inboundBlock(m: InboundMsg, attPaths: string[]): string {
  const esc = (v: string) => v.replace(/"/g, '&quot;')
  const a: string[] = []
  if (m.messageId) a.push(m.messageId)
  if (m.chatKind === 'group' && m.sender.name) a.push(`@${m.sender.name}`)
  for (const p of attPaths) a.push(`att="${esc(p)}"`)
  return `<tg${a.length ? ' ' + a.join(' ') : ''}>${m.text ?? ''}</tg>`
}

async function handleMessage(m: InboundMsg): Promise<void> {
  const allow = loadAllow()
  if (allow.length === 0) {
    log(`pairing: first contact from user ${m.sender.id} — add "${m.sender.id}" to allowFrom in ${SLACK_ACCESS_FILE}`)
    await channel.sendText(m.chatId, `I'm not paired yet. Add your Slack user id \`${m.sender.id}\` to *allowFrom* in \`${SLACK_ACCESS_FILE}\`, then message me again.`,
      m.threadId ? { threadId: m.threadId } : {}).catch(() => {})
    return
  }
  if (!allow.includes(m.sender.id)) { log(`ignored message from non-allowed user ${m.sender.id}`); return }
  if (m.isEdit) return   // MVP: don't re-inject edits

  const pane = activePane
  if (!pane) { await channel.sendText(m.chatId, 'No bridge session is attached yet — launch one with `claude-tg`.', m.threadId ? { threadId: m.threadId } : {}).catch(() => {}); return }
  replyTarget = { chatId: m.chatId, ...(m.threadId ? { threadId: m.threadId } : {}) }

  // Plain-text controls: exactly "stop"/"esc" → Escape into the pane (interrupt), no inject.
  const trimmed = (m.text ?? '').trim().toLowerCase()
  if (trimmed === 'stop' || trimmed === 'esc') {
    await enqueueInject(async () => { await sendKeys(pane, ['Escape']); await waitForSettle(pane, 150, 2000) })
    return
  }

  // Download any attachments to the inbox and append them as att= paths.
  const attPaths: string[] = []
  for (const att of m.attachments ?? []) {
    try { attPaths.push(await channel.downloadAttachment(att.fileId, SLACK_INBOX_DIR, att.name)) }
    catch (e) { log(`attachment download failed: ${e}`) }
  }
  const block = inboundBlock(m, attPaths)
  await enqueueInject(async () => {
    const ok = await injectPaste(pane, block)
    if (!ok) { await channel.sendText(m.chatId, "Couldn't reach the session's terminal.", m.threadId ? { threadId: m.threadId } : {}).catch(() => {}) }
  })
}

// ---- Prompt card rendering (minimal — the neutral markdown adapter renders it to mrkdwn) ----
function renderPermCard(p: PermissionPrompt): { text: string; buttons: Button[][] } {
  const lines = [`🔐 *${p.question}*`]
  if (p.preview) lines.push('```\n' + p.preview + '\n```')
  const buttons = p.options.map(o => [{ text: o.label.slice(0, 74), data: `pperm:${o.n}` }])
  return { text: lines.join('\n'), buttons }
}
function renderSelectCard(p: PromptInfo): { text: string; buttons: Button[][] } {
  const lines = [`❓ *${p.question}*`, '']
  p.options.forEach((o, i) => { lines.push(`*${i + 1}.* ${o.label}`); if (o.description) lines.push(`_${o.description}_`) })
  const buttons: Button[][] = []
  let row: Button[] = []
  p.options.forEach((_, i) => { row.push({ text: String(i + 1), data: `psel:${i + 1}` }); if ((i + 1) % 3 === 0) { buttons.push(row); row = [] } })
  if (row.length) buttons.push(row)
  return { text: lines.join('\n'), buttons }
}

async function handleTap(t: { data: string; ref: MsgRef; sender: { id: string } }): Promise<void> {
  if (!loadAllow().includes(t.sender.id)) return
  const pane = promptCard?.pane ?? activePane
  if (!pane || !(await paneAlive(pane).catch(() => false))) return
  const perm = /^pperm:(\d+)$/.exec(t.data)
  if (perm) { await enqueueInject(() => paneKeys(pane, [perm[1], 'Enter'])); lastPromptHash = ''; return }
  const sel = /^psel:(\d+)$/.exec(t.data)
  if (sel) {   // single-select: N-1 Down presses then Enter (after daemon.ts login/resume drive ~7589)
    const idx = Number(sel[1]) - 1
    await enqueueInject(async () => { await navigateDown(pane, idx); await sendKeys(pane, ['Enter']); await waitForSettle(pane, 300, 5000) })
    lastPromptHash = ''
  }
}

async function paneKeys(paneId: string, keys: string[]): Promise<void> {
  await sendKeys(paneId, keys)
  await waitForSettle(paneId, 300, 5000)
}

// Reactions-as-controls: 👍 / ok on the bot's last prompt card → approve (Enter picks the
// highlighted default); 👎 → Escape (cancel). Only fires on the prompt card's own message.
async function handleReaction(r: { ref: MsgRef; sender: { id: string }; added: string[] }): Promise<void> {
  if (!loadAllow().includes(r.sender.id)) return
  if (!promptCard || r.ref.messageId !== promptCard.ref.messageId) return
  const pane = promptCard.pane
  if (!(await paneAlive(pane).catch(() => false))) return
  const approve = r.added.some(n => n === '+1' || n === 'thumbsup' || n === 'ok_hand')
  const reject = r.added.some(n => n === '-1' || n === 'thumbsdown')
  if (approve) { await enqueueInject(() => paneKeys(pane, ['Enter'])); lastPromptHash = '' }
  else if (reject) { await enqueueInject(() => paneKeys(pane, ['Escape'])); lastPromptHash = '' }
}

// ---- Poll loops ----
// Discover / re-discover the bridge pane every 5s; adopt the newest, seed the relay cursor so we
// never dump the transcript backlog on first attach.
async function discoverTick(): Promise<void> {
  const panes = await findBridgePanes()
  const newest = newestPane(panes)
  if (panes.length > 1) log(`multiple bridge panes ${panes.join(',')}; using newest ${newest}`)
  if (newest && newest !== activePane) {
    activePane = newest
    const cwd = await paneCwd(newest).catch(() => null)
    const file = cwd ? resolveTranscript(cwd) : null
    relayCursor = file ? (latestFinalReply(file)?.uuid ?? '') : ''
    log(`adopted pane ${newest} (cwd ${cwd ?? '?'})`)
  } else if (!newest && activePane) {
    log(`bridge pane ${activePane} gone`)
    activePane = null
  }
}

// Relay new concluded assistant replies from the pane's transcript to the originating chat.
async function relayTick(): Promise<void> {
  if (!activePane || !replyTarget) return
  const cwd = await paneCwd(activePane).catch(() => null)
  const file = cwd ? resolveTranscript(cwd) : null
  if (!file) return
  for (const r of finalRepliesAfter(file, relayCursor)) {
    if (!r.uuid || r.uuid === relayCursor) continue
    try { await channel.sendText(replyTarget.chatId, r.text, replyTarget.threadId ? { threadId: replyTarget.threadId } : {}) }
    catch (e) { log(`reply relay failed: ${e}`); break }
    relayCursor = r.uuid
  }
}

// Detect a live permission / select prompt on the pane and relay it as a card with buttons; dedup
// by prompt-question hash so a repaint doesn't re-card. Clears the dedup once the pane is idle.
async function promptTick(): Promise<void> {
  if (!activePane || !replyTarget) return
  const cap = await capturePane(activePane).catch(() => '')
  if (!cap) return
  const perm = detectPermissionPrompt(cap)
  const sel = perm ? null : detectUserPrompt(cap)
  if (!perm && !sel) { if (onNormalPrompt(cap)) lastPromptHash = ''; return }
  const question = perm ? perm.question : sel!.question
  const h = hashText(question)
  if (h === lastPromptHash) return
  lastPromptHash = h
  const { text, buttons } = perm ? renderPermCard(perm) : renderSelectCard(sel!)
  try {
    const ref = await channel.sendText(replyTarget.chatId, text, { buttons, ...(replyTarget.threadId ? { threadId: replyTarget.threadId } : {}) })
    promptCard = { ref, pane: activePane, kind: perm ? 'perm' : 'select', options: (perm ? perm.options : sel!.options).length }
  } catch (e) { log(`prompt relay failed: ${e}`) }
}

// ---- Main ----
if (!(await acquireInstance())) process.exit(0)
process.umask(0o077)
const server = net.createServer(s => s.destroy())   // holds the single-instance lock (socketAlive probes it)
await new Promise<void>(resolve => server.listen(SLACK_SOCKET_PATH, () => {
  writeFileSync(SLACK_PID_FILE, String(process.pid), { mode: 0o600 })
  resolve()
}))

function shutdown(): void {
  log('shutting down')
  try { unlinkSync(SLACK_PID_FILE) } catch {}
  try { unlinkSync(SLACK_SOCKET_PATH) } catch {}
  void channel.stop().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', e => log(`unhandled rejection: ${e}`))

try {
  await channel.start({
    onMessage: handleMessage,
    onButtonTap: handleTap,
    onReaction: handleReaction,
    onStarted: async ({ botName }) => log(`connected as ${botName}; listening (Socket Mode)`),
  })
} catch (e) {
  log(`fatal: Slack connect failed — ${e}`)
  process.exit(1)
}

await discoverTick()
setInterval(() => void discoverTick(), 5000)
setInterval(() => void relayTick(), 1500)
setInterval(() => void promptTick(), 1000)
