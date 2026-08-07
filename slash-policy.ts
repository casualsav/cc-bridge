// slash-policy.ts — what a slash command typed into a MINI APP session chat should do.
//
// Pure classification, no IO, so the table below can be read and tested as the one place the answer
// lives. daemon.ts does the routing; this decides.
//
// The shape is a DENYLIST, not an allowlist, and that is forced by the requirement: every regular
// CLI command has to work, including the user's own skill commands, which nothing here can enumerate.
// So anything not named below is pasted at the CLI exactly as it always was.
//
// Every entry in MODAL was measured on a live CLI 2.1.220 pane rather than guessed: type the
// command, settle, capture, and ask whether the pane came back to its resting prompt. The ones that
// did not are here, because a full-screen dialog is a state the mini app has no way to drive — the
// observed failure was `/status` parking Claude Code's Settings screen and refusing every send after
// it with "the session is showing a dialog", from a composer that had just reported success.

import { panelKindOf, type PanelKind } from './panel-readout.ts'

export type SlashPlan =
  | { kind: 'prose' }                                   // not a command at all — deliver as a message
  | { kind: 'pass'; command: string }                   // hand to the CLI, as today
  | { kind: 'model'; arg: string }                      // route to the session-only model path
  | { kind: 'effort'; arg: string }                     // route to the session-only effort path
  | { kind: 'exit' }                                    // owner-gated; routed to the close action
  | { kind: 'navigate'; to: NavTarget; note: string }   // a bridge command with a destination IN this app
  | { kind: 'readout'; panel: PanelKind }               // a full-screen CLI panel the bridge can read and hand back
  | { kind: 'card'; card: CardKind; arg: string }       // a bridge command that RENDERS in the chat
  | { kind: 'mode'; arg: CcModeName }                   // a permission-mode switch, routed like model/effort
  | { kind: 'refuse'; reason: string }

// The bridge commands that answer with a rendered card rather than a refusal. Each one was a
// BRIDGE_ONLY entry saying "it lives in the chat" until v0.4.393 — true of the Telegram bot and
// false of this app, which can show all three.
export type CardKind = 'terminal' | 'diff' | 'health'

// Claude Code's permission modes, by the name `switchToMode` takes. Spelled here rather than
// imported from daemon.ts because this file is the pure classifier and imports no daemon state.
export type CcModeName = 'default' | 'plan' | 'auto' | 'acceptEdits' | 'bypassPermissions'

// The client's three views plus the browse sheet. `files` is not a view: browsing is a sheet inside
// the session that owns the folder, so it is the one target that needs that session's cwd.
export type NavTarget = 'sessions' | 'settings' | 'scheduled' | 'files'

// A command is one segment, no second slash. Without this `/tmp/foo is where I put it` was pasted
// at the CLI as a command, because "starts with a slash" was the whole test.
// The colon is not decoration: a plugin's command is `/plugin:skill`, and a token class that left
// it out would have turned every one of them into prose — the denylist quietly becoming an
// allowlist through a character class.
const COMMAND_TOKEN = /^\/[a-zA-Z][\w:-]*$/

// Full-screen dialogs, measured (see the header). `/model` and `/effort` are NOT here: bare they
// open a picker and are refused below, with an argument they route to the dial's own path.
// The six that MOVED OUT of this table, and why: `/cost` `/context` `/usage` `/status` `/mcp`
// `/hooks` are exactly `panelKindOf`'s set — the panels the bridge can DRIVE and read back (type the
// command, capture the screen, Esc the pane home) rather than merely refuse. The refusal was correct
// about the CLI's own screen and wrong about ours, and the reader it needed already ships and is
// already proven on `tg cost` and `@name /cost`. What stays here is the rest: screens with no reader,
// where "this chat can't drive it" is still the whole truth.
const MODAL: Record<string, string> = {
  '/config': 'opens the CLI\'s Config screen',
  '/permissions': 'opens the permission-rule editor', '/export': 'opens an export picker',
  '/release-notes': 'opens the release-notes browser', '/help': 'opens the help screen',
  '/rewind': 'opens the checkpoint picker', '/resume': 'opens the session picker',
  '/privacy-settings': 'opens the privacy screen',
}

// Box-wide or irreversible, and deliberately NOT probed: running them to find out what they do is
// the failure. A session chat is the wrong place to end the CLI's login for every session on the
// machine, or to start an installer.
// `/login` is NOT here on purpose: it signs in the pane's whole config dir, but the daemon relays
// the interactive flow — the method-picker buttons, then the sign-in link and the code reply — to
// the session's chat (relayLoginChoice / relayAuthUrlToTelegram), so a session chat IS a working
// place to run it; it is the owner's recover path after a blanked credential. `/logout` is the
// irreversible half and stays blocked: it ends the login for every session on that config dir at
// once, with no relay to recover from.
const BLOCKED: Record<string, string> = {
  '/logout': 'signs the CLI out for the whole machine, not this session',
  '/upgrade': 'changes the plan for the whole account',
  '/install-github-app': 'runs an interactive installer',
  '/migrate-installer': 'reinstalls the CLI itself',
  '/terminal-setup': 'rewrites terminal keybindings for the machine',
  '/bug': 'opens an interactive report flow', '/feedback': 'opens an interactive report flow',
}

// Bridge commands that have a DESTINATION IN THIS APP. That question — not "is it ours" — is the
// layer's whole definition: a name the bridge owns and the app can show goes there, and a name the
// bridge owns and the app cannot show says where it lives instead (BRIDGE_ONLY below).
//
// `/files` was in NEITHER table, so it fell through to the CLI, where the slash palette fuzzy-matched
// it — observed on the owner's screen, one palette predicate from running `/fable-method` in a live
// coding session. That is the bug this table closes, and the reason it is a table rather than a
// special case for one command.
// `note` is EMPTY where the screen that opens is the answer. This app retired success confirmations
// on the rule that the surface behind the bar already shows the outcome, and a navigation is the
// most visible outcome there is — so a note is carried only where the destination does NOT explain
// itself: landing on Settings after typing `/voice` shows you a screen without saying why.
const NAVIGATE: Record<string, { to: NavTarget; note: string }> = {
  '/files':    { to: 'files',     note: '' },
  '/sessions': { to: 'sessions',  note: '' },
  '/settings': { to: 'settings',  note: '' },
  '/cron':     { to: 'scheduled', note: '' },
  '/new':      { to: 'sessions',  note: 'The + button spawns a session.' },
  '/launch':   { to: 'sessions',  note: 'The + button starts a fresh session.' },
  '/account':  { to: 'settings',  note: 'Accounts live in settings.' },
  '/harness':  { to: 'settings',  note: 'Providers live in settings, under accounts.' },
  '/voice':    { to: 'settings',  note: 'Voice replies are a settings row.' },
  '/stream':   { to: 'settings',  note: 'Reply streaming is a settings row.' },
  '/queue':    { to: 'scheduled', note: 'Queued prompts live on the Scheduled board.' },
  '/later':    { to: 'scheduled', note: 'Queued prompts live on the Scheduled board.' },
  '/budget':   { to: 'scheduled', note: 'The daily cap lives on the Scheduled board.' },
}

// Names the BRIDGE owns that this app CANNOT show — so each says where it actually lives. Pasting one
// at the CLI gets "Unknown command" at best and a palette misfire at worst.
//
// The destinations these name are the ones a reader will go looking for, so they must track the app:
// the 2026-07-30 restructure deleted the tab ROW, leaving three views reached as the command center,
// the Scheduled pill and the ⋮ menu. `/find` used to point at a "Files tab" that no longer exists at
// all, and the recursive search it names has no home in the app yet — so it says that rather than
// sending someone to a screen that cannot do it.
const BRIDGE_ONLY: Record<string, string> = {
  '/find': 'no home in this app yet — browse the session’s folder from the paperclip instead',
  '/pin': 'the chat', '/start': 'the chat', '/agent': 'the chat',
  '/bind': 'the chat', '/unbind': 'the chat', '/claim': 'the chat',
  '/base': 'the chat', '/reset': 'the chat',
  // The session-baton pair. They are BOT commands — the daemon bundles their instruction text and
  // injects it through the normal inbound path — and the CLI has no command by either name, so
  // reaching the pane is the worst outcome available: an unregistered slash falls through to the
  // TUI's palette, which fuzzy-matches it (probed live: `/opus` offered `/fable` as its top match).
  // They were in neither table until v0.4.381, which is the same hole `/files` fell through.
  // `/audit` is registered in the same daemon loop as the two above and had the identical hole.
  '/handoff': 'the chat', '/continue': 'the chat', '/audit': 'the chat',
}

// Bridge commands the app RENDERS. The membership test is the one BRIDGE_ONLY's comment states and
// this is its other side: a name the bridge owns and the app can show. These three answer a question
// about the session or the bridge, so a card in the chat IS the answer — where NAVIGATE's members
// answer by opening the screen that holds it.
//
// The hidden aliases are here because the muscle memory is real: `/t` and `/doctor` are live in
// Telegram, and a name that works there and falls through to the CLI's fuzzy-matching palette here
// is the `/files` hole again.
const CARDS: Record<string, CardKind> = {
  '/terminal': 'terminal', '/t': 'terminal',
  '/diff': 'diff',
  '/health': 'health', '/doctor': 'health',
}

// The permission-mode switches. They route exactly as `/model <name>` and `/effort <level>` do —
// through the session-only path that applies to THIS pane — and for the same reason: the mode is a
// property of the session you are standing in.
//
// `/default` is in this table though it was never in BRIDGE_ONLY: it is a live Telegram mode command
// whose name the CLI does not register, so before this it fell through to the palette, which
// fuzzy-matches. That is the same hole `/files` fell through, on a sibling of the five names being
// routed here — leaving it open while closing its family would be the harder thing to explain.
const MODES: Record<string, CcModeName> = {
  '/plan': 'plan', '/auto': 'auto', '/default': 'default',
  '/acceptedits': 'acceptEdits', '/bypass': 'bypassPermissions', '/yolo': 'bypassPermissions',
}

// `/mode <alias>` — the argument form. Mirrors daemon.ts's MODE_ALIASES; bare `/mode` opens a picker
// in Telegram, which is the undriveable dialog this app refuses everywhere else.
const MODE_ARGS: Record<string, CcModeName> = {
  default: 'default', normal: 'default', plan: 'plan', auto: 'auto',
  acceptedits: 'acceptEdits', accept: 'acceptEdits', edits: 'acceptEdits',
  bypass: 'bypassPermissions', bypasspermissions: 'bypassPermissions', yolo: 'bypassPermissions',
}

/** Why this command can't be run at a session, or null if it isn't a bridge command. */
export function bridgeOnlyReason(name: string): string | null {
  const where = BRIDGE_ONLY[name.toLowerCase()]
  return where ? `${name} is a bridge command, not a session command — it lives in ${where}.` : null
}

export function planSlash(text: string): SlashPlan {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return { kind: 'prose' }
  const token = trimmed.split(/\s+/)[0]
  if (!COMMAND_TOKEN.test(token)) return { kind: 'prose' }
  const name = token.toLowerCase()
  const arg = trimmed.slice(token.length).trim()

  // Navigation is checked FIRST: a bridge command with a destination must never reach the CLI, and
  // must never be refused with prose for a screen this app can simply open.
  const nav = NAVIGATE[name]
  if (nav) return { kind: 'navigate', to: nav.to, note: nav.note }
  // A panel the bridge can read. Ahead of BRIDGE_ONLY and MODAL because both of those are ways of
  // saying "not here", and this one IS here. `panelKindOf` is the single enumeration every surface
  // reads — the Telegram command, the owner's `@name /cmd` routing, the bus verbs, `tg slash`'s
  // refusal — so a panel cannot be readable on one surface and a wedge on another.
  //
  // Bare spellings only, which `panelKindOf` already enforces: `/context all` is a wider INLINE dump
  // that never takes the screen, so it relays as an ordinary command and needs none of this.
  // `arg` is checked here, not inside panelKindOf: this function matched on the bare TOKEN, so
  // `/context all` reached the enumeration as `/context` and was classified as a panel — turning the
  // wider inline dump into a screen-read. The enumeration is bare-spellings-only by design; honouring
  // that means asking it only about a command that HAS no argument.
  const panel = arg ? null : panelKindOf(name)
  if (panel) return { kind: 'readout', panel }
  // A bridge command this app renders. Ahead of BRIDGE_ONLY for the same reason `navigate` is: both
  // of those tables are ways of saying "not here", and these three are here. `arg` rides along —
  // `/terminal 60` is a line count, and the card producer is the one that bounds it.
  const card = CARDS[name]
  if (card) return { kind: 'card', card, arg }
  // A permission-mode switch. Bare `/mode` opens the picker, which is the same undriveable dialog
  // MODAL names — so it is refused toward the control that does this properly, exactly as bare
  // `/model` and `/effort` are.
  const mode = MODES[name]
  if (mode) return { kind: 'mode', arg: mode }
  if (name === '/mode') {
    const picked = arg && MODE_ARGS[arg.toLowerCase().replace(/[-_\s]/g, '')]
    if (picked) return { kind: 'mode', arg: picked }
    return { kind: 'refuse', reason: arg
      ? `${arg} isn't a mode — try plan, auto, acceptEdits, bypass or default.`
      : 'Bare /mode opens a picker the chat can\'t drive — use /mode <name>, or /plan, /auto, /acceptedits, /bypass.' }
  }
  const bridgeOnly = bridgeOnlyReason(name)
  if (bridgeOnly) return { kind: 'refuse', reason: bridgeOnly }
  if (BLOCKED[name]) return { kind: 'refuse', reason: `${name} ${BLOCKED[name]}, so it isn't available from a session chat.` }
  if (MODAL[name]) return { kind: 'refuse', reason: `${name} ${MODAL[name]} in the terminal, which this chat can't drive. Run it in the session's own pane.` }
  // Bare /model and /effort open a picker — the same undriveable dialog as anything in MODAL — so
  // they point at the control that already does this properly. With an argument they route to the
  // dial's session-only path, which is the whole reason they are singled out: typed at the CLI,
  // `/model sonnet` ALSO rewrites ~/.claude/settings.json and changes the default for every new
  // session on the box. Observed, on this machine, from a composer.
  if (name === '/model') return arg ? { kind: 'model', arg: arg.toLowerCase() } : { kind: 'refuse', reason: 'Bare /model opens a picker the chat can\'t drive — use the model button beside the composer, or /model <name>.' }
  if (name === '/effort') return arg ? { kind: 'effort', arg: arg.toLowerCase() } : { kind: 'refuse', reason: 'Bare /effort opens a picker the chat can\'t drive — use the model button beside the composer, or /effort <level>.' }
  if (name === '/exit' || name === '/quit') return { kind: 'exit' }
  return { kind: 'pass', command: trimmed }
}
