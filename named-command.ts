// named-command.ts — pure argument parsing for the commands that act on ANOTHER session, extracted
// from the daemon monolith so the rules that decide WHICH session a command hits can be
// characterized in isolation. Getting these wrong doesn't produce a wrong message; it produces a
// clear/restart/exit landing on the wrong pane, so they're worth pinning.
//
// There is exactly ONE supported spelling, target-first: `@worker /exit`. Everything here exists to
// catch the OTHER spelling — `/exit @worker` — and refuse it. That refusal is not tidiness: left
// unhandled, `/exit @worker` reaches the local relay, which reads it as a plain `/exit` and ends the
// session the caller is typing in. Not wiring the argument form and refusing it are opposite
// outcomes, and only one of them is safe.

// Does this command argument look like an attempt at the argument spelling? Deliberately broader
// than "exactly one @name": `/clear @worker now` is the same mistake, and refusing it costs nothing,
// where acting on it locally clears the wrong conversation. `/restart all` and a bare command are
// unaffected — they don't start with `@`.
//
// APPLY THIS PER COMMAND, NEVER AS GLOBAL MIDDLEWARE. Four call sites doing the same thing is an
// inviting hoist, and the hoist is wrong: **`/queue @reset <text>`** is a live local command whose
// LEGITIMATE argument starts with `@` (it queues a prompt for the 5h rollover). A blanket "refuse
// any @-leading argument" would break it, silently, and the breakage would look like the refusal
// working. Only /clear, /compact and /restart opt in — the three whose local target is the caller's
// own pane, so a mistyped `@name` would act on the wrong session. /exit is stricter still and has
// its own rule below.
export function looksLikeArgForm(arg: string): boolean {
  return /^@\S/.test(arg.trim())
}

// The argument to a /exit or /quit, or null when there is none. Null means the caller typed a bare
// `/exit`, which is the ONLY form that may end the session you're in; anything else is the argument
// spelling and gets refused.
//
// The `@` on the target is optional because `/exit worker` is the same mistake as `/exit @worker`
// and must not reach the local relay either. `botUsername` handles Telegram's own `/exit@thisbot`
// suffix on a tapped command in a group: ours is stripped, another bot's returns null so the message
// is left alone for the path that already ignores other bots' commands.
export function exitCommandArg(text: string, botUsername?: string | null): string | null {
  const m = /^\/(?:exit|quit)(?:@(\w+))?\s+@?(\S+)$/i.exec(text.trim())
  if (!m) return null
  if (m[1] && botUsername && m[1].toLowerCase() !== botUsername.toLowerCase()) return null
  return m[2]
}
