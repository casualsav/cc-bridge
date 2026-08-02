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

export type SlashPlan =
  | { kind: 'prose' }                                   // not a command at all — deliver as a message
  | { kind: 'pass'; command: string }                   // hand to the CLI, as today
  | { kind: 'model'; arg: string }                      // route to the session-only model path
  | { kind: 'effort'; arg: string }                     // route to the session-only effort path
  | { kind: 'exit' }                                    // owner-gated; routed to the close action
  | { kind: 'refuse'; reason: string }

// A command is one segment, no second slash. Without this `/tmp/foo is where I put it` was pasted
// at the CLI as a command, because "starts with a slash" was the whole test.
// The colon is not decoration: a plugin's command is `/plugin:skill`, and a token class that left
// it out would have turned every one of them into prose — the denylist quietly becoming an
// allowlist through a character class.
const COMMAND_TOKEN = /^\/[a-zA-Z][\w:-]*$/

// Full-screen dialogs, measured (see the header). `/model` and `/effort` are NOT here: bare they
// open a picker and are refused below, with an argument they route to the dial's own path.
const MODAL: Record<string, string> = {
  '/cost': 'opens a full-screen dashboard', '/usage': 'opens a full-screen dashboard',
  '/status': 'opens the CLI\'s Status screen', '/config': 'opens the CLI\'s Config screen',
  '/mcp': 'opens the MCP server list', '/hooks': 'opens the hooks editor',
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

// Names the BRIDGE owns that Claude Code does not. Pasting one gets "Unknown command" at best and a
// palette misfire at worst, so each says where it actually lives instead.
const BRIDGE_ONLY: Record<string, string> = {
  '/sessions': 'the Sessions tab', '/settings': 'the Settings tab', '/new': 'the + button on the Sessions tab',
  '/find': 'the Files tab', '/queue': 'the Scheduled tab', '/later': 'the Scheduled tab',
  '/budget': 'the Scheduled tab', '/pin': 'the chat', '/start': 'the chat', '/health': 'the chat',
  '/mode': 'the chat', '/plan': 'the chat', '/auto': 'the chat', '/acceptedits': 'the chat',
  '/bypass': 'the chat', '/yolo': 'the chat', '/agent': 'the chat', '/launch': 'the chat',
  '/harness': 'the chat', '/bind': 'the chat', '/unbind': 'the chat', '/claim': 'the chat',
  '/base': 'the chat', '/diff': 'the chat', '/terminal': 'the chat', '/reset': 'the chat',
}

export function planSlash(text: string): SlashPlan {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return { kind: 'prose' }
  const token = trimmed.split(/\s+/)[0]
  if (!COMMAND_TOKEN.test(token)) return { kind: 'prose' }
  const name = token.toLowerCase()
  const arg = trimmed.slice(token.length).trim()

  if (BRIDGE_ONLY[name]) return { kind: 'refuse', reason: `${name} is a bridge command, not a session command — it lives in ${BRIDGE_ONLY[name]}.` }
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
