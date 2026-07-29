#!/usr/bin/env bun
// Off-MCP actions CLI. A plugin-less session has no MCP reply tool, so it takes deliberate Telegram
// actions — send a file/photo, react, edit a status message — by talking to the daemon's unix socket
// directly with the same {t:'call'} the shim used. (Plain text replies are relayed automatically
// from the transcript; this is the rest.) The agent bus adds agent↔agent verbs (ask/answer/…).
//
// <chat> is `.` in a DM (resolves to the sole allowlisted chat) or an explicit id in a group.
//   tgctl send   <chat> <path> [caption|-]     send a file/photo (- reads caption from stdin)
//   tgctl react  <chat> <message_id> <emoji>   add an emoji reaction
//   tgctl edit   <chat> <message_id> <text|->  edit a message the bot sent (- reads stdin)
//   tgctl reply  <chat> <text|->               send a text message (- reads stdin)
// Agent bus (only inside a bridged session; the daemon resolves the caller from its tmux pane):
//   tgctl ask    <name> <text|-> [--ref p]…    ask another agent (async — turn ends, answer arrives later)
//   tgctl ack    <name> <text|-> [--ref p]…    tell another agent something; no answer expected, nothing queued
//   tgctl btw    <name> <text|-> [--ref p]…    an ASIDE — lands MID-TURN, between the target's tool calls
//   tgctl answer <id>   <text|-> [--ref p]…    answer an ask you received (id from its <tg …ask=N> block)
//   tgctl post   <text|->                       broadcast to the humans in the room
//   tgctl slash  <name> </cmd>                  inject a slash command into a target session's CLI
//   tgctl keys   <name> <key>… [--force]        send named keystrokes to a target session's pane
//   tgctl spawn  <name> [--dir p [--create]] [--model m] [--why "…"] [--effort e] [text|-]   start a NEW session in its own topic
//   tgctl kill   <name> [--force]               end a session you spawned (chat lane: any worker)
//   tgctl reopen <name>                         bring a closed session back up, conversation intact
//   tgctl roster                                who's live in the room
//   tgctl history [n]                           recent agent-bus activity
//   tgctl shared                                the room's shared-workspace dir (put deliverables here)
import net from 'node:net'
import { fstatSync, readFileSync } from 'node:fs'
import { frame, makeLineReader, SOCKET_PATH, type ShimToDaemon, type DaemonToShim } from './common.ts'
import { looksSpliced } from './spliced.ts'

const [, , cmd, chat_id, a, b] = process.argv

// A message body reaches us one of two ways, and only one of them is safe.
//
// `-` reads stdin: the text never passes through shell parsing, so it survives verbatim.
// Anything else is an argv string the shell has ALREADY expanded — and a session writing Markdown
// into a double-quoted body is writing `code spans` in backticks, which inside "…" is command
// substitution: the shell RUNS the command and splices its stdout into the message. Observed live —
// an answer explaining a `tg spawn …` bug executed it and shipped the usage text mid-sentence.
//
// We cannot undo that (it happened before this process existed), but the common case is a session
// quoting a `tg …` command, and that leaves our own output as a fingerprint (see spliced.ts).
// Refuse those loudly: a hard error the caller must fix beats relaying a mangled message they
// believe they wrote.
// Is a body waiting on stdin? A heredoc and a pipe are both FIFOs (bash spills a large heredoc to a
// temp FILE instead), while a command run with no redirection gets a tty interactively or /dev/null —
// a CHARACTER device — from the agent harnesses. Measured both ways on this box, and it is the whole
// discriminator: we read fd 0 only when something was actually written to it, so a plain briefless
// `tg spawn worker` can never block on a stdin nobody is going to close.
const stdinHasBody = (): boolean => {
  try { const s = fstatSync(0); return s.isFIFO() || s.isFile() } catch { return false }
}

const body = (raw: string | undefined, verb: string): string | undefined => {
  if (raw === '-') return readFileSync(0, 'utf8')
  // A heredoc with NO `-`. The body was written, and it used to be dropped on the floor in silence:
  //
  //     tg spawn worker --dir /x --model opus <<'EOF'   ← the brief goes nowhere
  //
  // Two real spawns lost multi-paragraph briefs exactly this way on 2026-07-27 — both sessions came
  // up briefless and sat idle until their orchestrator re-asked, and the only outward symptom was one
  // missing clause in the ok line. `spawn`'s body is OPTIONAL, so there is nothing to refuse here;
  // stdin itself says which case this is, so take the body the caller obviously meant.
  if (raw == null && stdinHasBody()) return readFileSync(0, 'utf8')
  if (raw != null && looksSpliced(raw)) {
    process.stderr.write(
      `tg ${verb}: refusing — this body has tg's own output spliced into it, which means your shell\n` +
      `ran a backticked command instead of quoting it. Inside "…", \`cmd\` EXECUTES; it does not make\n` +
      `a code span. Pipe the body in instead — stdin never touches the shell:\n` +
      `  printf '%s' "$BODY" | tg ${verb} <args> -\n`)
    process.exit(2)
  }
  return raw
}

// Per-subcommand usage. Without it `tg spawn --help` read `--help` as the session NAME and really
// spawned a session called "--help" (and a folder to match) — help must never be a live action.
// Only argv[3] counts as the help flag, so a `--help` inside a message body still sends as text.
const HELP: Record<string, string> = {
  send:    'tg send <chat> <path> [caption|-]   send a file/photo (- reads the caption from stdin)',
  react:   'tg react <chat> <message_id> <emoji>   add an emoji reaction to a message',
  edit:    'tg edit <chat> <message_id> <text|->   edit a message the bot sent (- reads stdin)',
  reply:   'tg reply <chat> <text|->   force a text send (plain replies relay automatically)',
  update:  'tg update [check]   upgrade the bridge (check = report the available version only)',
  ask:     'tg ask <name> <text|-> [--ref path]…   ask another agent; ASYNC — the answer arrives later as a <tg …re=ID> block',
  ack:     'tg ack <name> <text|-> [--ref path]…   acknowledge / FYI another agent — delivered like an ask,\n' +
           '  but nothing is waiting on it: no answer is expected and no open ask is left behind. Use it for\n' +
           '  "got it", "heads-up", "standing down" — anything an `tg ask` would leave hanging until it timed out.',
  btw:     'tg btw <name> <text|-> [--ref path]…   an ASIDE — the only bus message that lands while the\n' +
           '  target is MID-TURN, surfacing between its tool calls instead of queueing behind the whole turn.\n' +
           '  For steering that stops being true if it waits: "the owner changed X — if you are building the old\n' +
           '  X, stop", "skip Y, it is already fixed". No reply, no ask id, nothing queued. If the target cannot\n' +
           '  take it right now this FAILS back to you immediately rather than queueing — late steering is worse\n' +
           '  than none, so the decision to wait, escalate to `tg ask`, or tell a human stays yours.',
  answer:  'tg answer <id> <text|-> [--ref path]…   answer an ask you received (id from its <tg …ask=ID> block)',
  post:    'tg post <text|->   say something to the humans in the room',
  slash:   'tg slash <name> "/compact"   run a slash command in another session\'s CLI (rejected mid-turn; /exit is owner-only)',
  keys:    'tg keys <name> <key>… [--force]   send keystrokes to a wedged session\'s pane — the lever for a\n' +
           '  picker or permission prompt no message can reach (tg ask queues; tg slash needs a normal prompt).\n' +
           '  Named keys only: enter esc up down left right 1-9. Words are an `tg ask`, not a keystroke.\n' +
           '  Refused while the target is mid-turn, unless the wedge alert has fired — or --force, which\n' +
           '  carries esc (to interrupt it) and nothing else.',
  spawn:   'tg spawn <name> [--dir p [--create]] [--model fable|opus|sonnet|haiku] [--why "one line"]\n' +
           '             [--effort low…max] [text|-]\n' +
           '  start a NEW session in its own topic. --dir must already exist unless --create is passed;\n' +
           '  with no --dir the session gets a folder named after it under the base dir.\n' +
           '  The first message is delivered as an ask once its REPL is up.\n' +
           '  --why is one line on why THIS model fits THIS task; it shows on the owner\'s spawn card.\n' +
           '  Where the default is "auto" there is no configured model — name one, and say why.',
  kill:    'tg kill <name> [--force]   end a session you spawned (a chat lane may end any worker). Undo with tg reopen.\n' +
           '  A session with background shells still running refuses once and names them — killing it kills them.\n' +
           '  --force closes anyway; that second, explicit call is how a script says it meant it.',
  reopen:  'tg reopen <name>   bring a closed session back up — same folder, same name, same topic,\n' +
           '  resuming its own conversation where it left off',
  wait:    'tg wait <reason|-> | --clear   say what you are blocked on, so the roster shows it instead of\n' +
           '  reading you as idle: "CI run 18832", "@taste to answer". One line. It clears itself when your\n' +
           '  next turn starts, so you never have to remember to unset it.',
  repo:    'tg repo <path> [--refresh] [--stale "why"] | tg repo --list\n' +
           '  the routing brief for a work repo: what it IS, which directory a request means, what proves\n' +
           '  work there, what makes a task not routine. Cached per box — a repo already scouted answers\n' +
           '  instantly; a new one is discovered in the background (~1 min) and arrives as an ack.\n' +
           '  --stale "why" flags a brief you found wrong while working in that repo; never hand-edit one.',
  roster:  'tg roster   who is live on the bus',
  history: 'tg history [n]   recent agent-bus activity',
  shared:  'tg shared   print the room\'s shared-workspace dir (put deliverables there)',
  doctor:  'tg doctor   host-side install diagnostic (works with the daemon down)',
}
// Every verb that takes free text gets the stdin steer in its help — the shell mangles Markdown
// bodies (see `body` above), so `-` is the documented default, not the fallback.
const TEXT_VERBS = new Set(['send', 'edit', 'reply', 'ask', 'ack', 'btw', 'answer', 'post', 'spawn'])
const STDIN_NOTE =
  "\nBodies: pass them on stdin — printf '%s' \"$BODY\" | tg <verb> <args> -\n" +
  'A double-quoted body is parsed by the SHELL first: `backticks` run as commands (splicing their\n' +
  'output into your message) and $vars expand. Markdown code spans and shell quoting collide, so\n' +
  'stdin is the only way to send prose through unaltered.\n'
const usage = () => Object.values(HELP).map(h => `  ${h}`).join('\n')
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  process.stdout.write(`usage:\n${usage()}\n${STDIN_NOTE}`)
  process.exit(0)
}
if ((process.argv[3] === '--help' || process.argv[3] === '-h') && HELP[cmd]) {
  process.stdout.write(`${HELP[cmd]}\n${TEXT_VERBS.has(cmd) ? STDIN_NOTE : ''}`)
  process.exit(0)
}

// `tg doctor` — host-side install diagnostic (reads the setup directly; works even when the daemon is
// down, which is the whole point). Handled here, before the socket path, since it talks to no daemon.
if (cmd === 'doctor') {
  const { runDoctor } = await import('./doctor.ts')
  process.exit(await runDoctor())
}

// The caller's tmux pane rides along so the daemon can resolve `.` to THIS session's chat — and, for
// bus verbs, WHICH endpoint the caller is (pane → topic session) — without an explicit id.
const pane = process.env.TMUX_PANE
let name = '', args: Record<string, unknown> = {}

// Bus verbs take flag args (--ref, --await), so parse positionals + refs out of argv rather than
// the fixed chat/a/b slots the classic verbs use. Kept in a separate branch so classic verbs are
// byte-for-byte unchanged.
// NOTE: this set is the real gate — a `case` added to the switch below without a name added HERE is
// dead code that falls through to "unknown command". Cost one live probe run to find.
// `repo` is not agent-to-agent messaging, but it takes flags, and this branch is the flag-parsing
// one — same reason `wait` is here while the daemon deliberately keeps it out of AGENT_BUS_VERBS.
const BUS = new Set(['ask', 'ack', 'btw', 'answer', 'post', 'slash', 'keys', 'spawn', 'kill', 'reopen', 'roster', 'history', 'shared', 'wait', 'repo'])
if (BUS.has(cmd)) {
  const rest = process.argv.slice(3)
  const refs: string[] = []
  const flags: Record<string, string | boolean> = {}
  const pos: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const f = /^--(dir|model|effort|stale|why)$/.exec(rest[i]!)
    if (rest[i] === '--ref') { const v = rest[++i]; if (v != null) refs.push(v) }
    else if (f) { const v = rest[++i]; if (v != null) flags[f[1]!] = v }   // spawn's flags; harmless elsewhere
    else if (rest[i] === '--create') { flags.create = true }               // spawn: allow a missing --dir
    else if (rest[i] === '--force') { flags.force = true }                 // keys: carry esc into a working turn
    else if (rest[i] === '--clear') { flags.clear = true }                 // wait: drop the declaration early
    else if (rest[i] === '--refresh') { flags.refresh = true }             // repo: re-scout even if the brief is fresh
    else if (rest[i] === '--list') { flags.list = true }                   // repo: what this box already knows
    else if (rest[i] === '--await') { /* P1 is async-only; --await is accepted and ignored */ }
    else pos.push(rest[i]!)
  }
  // Belt and braces behind the per-subcommand help above: a leading dash is a mistyped flag, never a
  // session name — spawning/killing one would create a folder (and a topic) named after the typo.
  if ((cmd === 'spawn' || cmd === 'kill' || cmd === 'reopen') && pos[0]?.startsWith('-')) {
    process.stderr.write(`tg ${cmd}: '${pos[0]}' is not a session name (it starts with a dash) — try 'tg ${cmd} --help'\n`)
    process.exit(2)
  }
  switch (cmd) {
    case 'ask':     name = 'ask';     args = { pane, to: pos[0], text: body(pos[1], 'ask') ?? '', refs }; break
    case 'ack':     name = 'ack';     args = { pane, to: pos[0], text: body(pos[1], 'ack') ?? '', refs }; break
    case 'btw':     name = 'btw';     args = { pane, to: pos[0], text: body(pos[1], 'btw') ?? '', refs }; break
    case 'answer':  name = 'answer';  args = { pane, id: pos[0], text: body(pos[1], 'answer') ?? '', refs }; break
    case 'post':    name = 'post';    args = { pane, text: body(pos[0], 'post') ?? '' }; break
    case 'slash':   name = 'slash';   args = { pane, to: pos[0], command: pos[1] ?? '' }; break
    // Keys are argv words, never stdin: they're a fixed vocabulary, not a body.
    case 'keys':    name = 'keys';    args = { pane, to: pos[0], keys: pos.slice(1), ...flags }; break
    case 'spawn':   name = 'spawn';   args = { pane, name: pos[0], text: body(pos[1], 'spawn') ?? '', ...flags }; break
    case 'kill':    name = 'kill';    args = { pane, name: pos[0], ...flags }; break   // --force: close past the background-shell warning
    case 'reopen':  name = 'reopen';  args = { pane, name: pos[0] }; break
    // A reason short enough to read on a card is an argv string, so `-` stays available but is not
    // the documented shape here (nothing in a wait reason wants Markdown).
    case 'wait':    name = 'wait';    args = { pane, text: flags.clear ? '' : body(pos[0], 'wait') ?? '', ...flags }; break
    case 'repo':    name = 'repo';    args = { pane, path: pos[0], ...flags }; break
    case 'roster':  name = 'roster';  args = { pane }; break
    case 'history': name = 'history'; args = { pane, n: pos[0] }; break
    case 'shared':  name = 'shared';  args = { pane }; break
  }
} else {
  switch (cmd) {
    case 'send':  name = 'reply';        args = { chat_id, pane, files: [a], ...(b != null ? { text: body(b, 'send') } : {}) }; break
    case 'react': name = 'react';        args = { chat_id, pane, message_id: a, emoji: b }; break
    case 'edit':  name = 'edit_message'; args = { chat_id, pane, message_id: a, text: body(b, 'edit') }; break
    case 'reply': name = 'reply';        args = { chat_id, pane, text: body(a, 'reply') }; break
    // `tg update` / `tg update check` — the second token lands in `chat_id`.
    case 'update': name = 'update';      args = { mode: chat_id === 'check' ? 'check' : 'apply' }; break
    default:
      process.stderr.write(`tgctl: unknown command '${cmd}'\nusage:\n${usage()}\n`)
      process.exit(2)
  }
}

const id = String(Date.now())
const sock = net.createConnection(SOCKET_PATH)
const timer = setTimeout(() => { process.stderr.write('tgctl: timed out\n'); process.exit(1) }, 30_000)
sock.on('connect', () => sock.write(frame({ t: 'call', id, name, args } satisfies ShimToDaemon)))
// `tg shared` exists to be substituted — `--dir "$(tg shared)"` is the documented idiom — so its
// success output must be the bare path. With the usual `ok: ` prefix that idiom silently produced
// "ok: /path/…" and every caller either wrote to a bogus folder or had to sed the prefix off.
// Errors keep the prefix everywhere: they are read by humans, never substituted.
// `tg repo` joins it for the same reason: its success output IS the brief, and an `ok: ` glued to the
// front of a multi-line document is noise in the one place the output is meant to be read verbatim.
const VALUE_VERB = cmd === 'shared' || cmd === 'repo'
sock.on('data', makeLineReader<DaemonToShim>(msg => {
  if (msg.t !== 'result' || msg.id !== id) return   // ignore hello/other frames
  clearTimeout(timer)
  process.stdout.write(msg.ok && VALUE_VERB
    ? `${msg.text ?? ''}\n`
    : (msg.ok ? 'ok' : 'error') + (msg.text ? `: ${msg.text}` : '') + '\n')
  sock.destroy()
  process.exit(msg.ok ? 0 : 1)
}))
sock.on('error', e => { process.stderr.write(`tgctl: ${e}\n`); process.exit(1) })
