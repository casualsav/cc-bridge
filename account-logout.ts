// The confirmation a Claude-account log-out shows before it runs — ONE formatter for both surfaces,
// so the mini app's dialog and the Telegram card cannot word the same irreversible act differently.
//
// The owner went looking for this button and found none: `Remove` on an account row unregisters the
// config dir and says so ("the files on disk stay"), `claude:main` had no row action at all, and
// `/logout` is refused in a pane by slash-policy. So this is the first surface from which a login on
// this box can actually be ended, and the three facts in the text below are each MEASURED rather
// than cautionary (2026-08-21, against claude 2.1.238 on a throwaway config dir):
//
//   · `claude auth logout` deletes the WHOLE `<configDir>/.credentials.json`, and that file carries
//     the `mcpOAuth` map as well as `claudeAiOauth` — so every MCP server login stored beside the
//     Anthropic one goes with it. Stated rather than avoided (his ruling): the surgical alternative,
//     stripping one key out of the file, skips the server-side revoke and is a worse logout.
//   · There is no undo. It writes `backups/.claude.json.backup.<ts>` — that is PREFERENCES; the
//     credentials are not backed up anywhere.
//   · It opens TLS to api.anthropic.com before reporting success, i.e. it asks for a server-side
//     revoke — but it reported success for a fabricated token too, so a failed revoke is invisible.
//     The wording therefore promises exactly what is true of the FILE: this box is signed out.
//     Nothing here claims anything about his other machines (his ruling, and the reason the note
//     leaves whether Anthropic scopes that revoke per-token or per-account as an open finding).
export type LogoutSession = { name: string; working: boolean }

export type LogoutPlan = {
  account: string
  configDir: string
  /** Whose login it is, from `claude auth status` — null when the CLI could not say. */
  identity: string | null
  /** MCP server names stored in the same credentials file; all of them go too. */
  mcp: string[]
  /** Live sessions running on this config dir. They are NAMED, never a reason to refuse. */
  sessions: LogoutSession[]
}

const list = (xs: string[], max = 4): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')}, +${xs.length - max} more`

export function logoutConfirmText(p: LogoutPlan): string {
  const who = p.identity ? `${p.identity} (${p.account})` : p.account
  const lines = [
    `Log out ${who}?`,
    '',
    `This signs THIS BOX out of ${p.configDir}. Your other machines are not affected.`,
  ]
  if (p.mcp.length) {
    lines.push(`• It also signs out ${p.mcp.length} MCP server login${p.mcp.length === 1 ? '' : 's'} stored in the same file: ${list(p.mcp)}.`)
  }
  // WARN, NEVER REFUSE (his ruling). Refusing while a session is live would make `main` — the account
  // the coding fleet always occupies — permanently unloggable-out, which is the gap this closes. And
  // a live session does not die at logout: the CLI holds its token in memory and fails at the next
  // refresh, so the reason to name them is that the failure is otherwise silent and hours away.
  if (p.sessions.length) {
    const named = p.sessions.map(s => `@${s.name}${s.working ? ' (working)' : ''}`)
    const one = p.sessions.length === 1
    lines.push(`• ${p.sessions.length} live session${one ? '' : 's'} on this account: ${list(named)}. ` +
      `${one ? 'It keeps' : 'They keep'} running until ${one ? 'its' : 'their'} current token expires, then fail${one ? 's' : ''} until you sign in again.`)
  }
  lines.push('• No undo — signing back in means a fresh login link.')
  return lines.join('\n')
}

/** The one-line outcome both surfaces report, from the CLI's own words. */
export function logoutResultText(account: string, cliSaid: string): string {
  // The CLI's sentence already ends in a full stop; appending ours produced "account.." on the first
  // live run. Trim its terminator rather than dropping our own — a CLI that stops punctuating still
  // gets a clean sentence.
  const said = (cliSaid.trim().split('\n').find(l => l.trim()) ?? '').replace(/[.!]+$/, '')
  return `👤 Logged out of ${account} on this box${said ? ` — ${said}` : ''}. Launch it again to sign in.`
}
