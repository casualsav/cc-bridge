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
  /**
   * MCP server names stored in the same credentials file; all of them go too. `null` means the file
   * could not be READ — a different fact from "there are none", and folding the two is the
   * unreadable≠absent inversion this repo has ruled on twice (v0.5.160, v0.5.181).
   */
  mcp: string[] | null
  /** Live sessions running on this config dir. They are NAMED, never a reason to refuse. */
  sessions: LogoutSession[]
  /**
   * Panes that could not be classified at all (tmux unreachable mid-scan). Counted and stated, never
   * silently dropped: a failed read is not evidence of absence, and the warning is the deliverable
   * here — "a warning he receives should be true" (his ruling, v0.5.181).
   */
  unknownSessions: number
}

const list = (xs: string[], max = 4): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')}, +${xs.length - max} more`

export function logoutConfirmText(p: LogoutPlan): string {
  const who = p.identity ? `${p.identity} (${p.account})` : p.account
  const lines = [
    `Log out ${who}?`,
    '',
    `This signs THIS BOX out of ${p.configDir}. Your other machines are not affected.`,
    // UNCONDITIONAL, and the antecedent every "that file" below depends on. Until v0.5.200 the text
    // named no file at all: its only reference to one was the MCP sentence's "stored in the same
    // file", which is conditional — so on the common plan (no MCP logins) the reader was never told
    // that a logout DELETES anything. The CLI does not strip a key, it removes the file; the
    // surgical alternative skips the server-side revoke and is a worse logout (his ruling A6), so
    // the cost is stated rather than avoided.
    `• It deletes ${p.configDir}/.credentials.json outright.`,
  ]
  // Three states, three sentences. Silence is reserved for the one case where silence is TRUE.
  // Measured 2026-08-21: every config dir on this box holds zero mcpOAuth entries, so the middle
  // branch has never rendered live — which is exactly why the unconditional line above is the one
  // carrying the weight, and why an unreadable file must not borrow that silence.
  if (p.mcp === null) {
    lines.push('• That file could not be read just now, so any MCP server logins in it cannot be named here — they go with it too.')
  } else if (p.mcp.length) {
    lines.push(`• It carries ${p.mcp.length} MCP server login${p.mcp.length === 1 ? '' : 's'} as well: ${list(p.mcp)}. Those go with it.`)
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
  // An unchecked pane is UNKNOWN, not absent. `planAccountLogout` reads three stores through tmux,
  // and a failed read there used to remove a session from this list silently — so the loudest
  // possible understatement ("no live sessions") was also the cheapest failure mode.
  if (p.unknownSessions > 0) {
    const one = p.unknownSessions === 1
    lines.push(`• ${p.unknownSessions} more pane${one ? '' : 's'} couldn't be checked, so ${one ? 'it' : 'they'} may be on this account too.`)
  }
  lines.push('• No undo — signing back in means a fresh login link.')
  return lines.join('\n')
}

// A logout has THREE outcomes, not two. `claude auth logout` deletes the credentials file before it
// can fail on the network revoke, so a non-zero exit does not mean nothing happened — reporting it
// as a plain failure puts "couldn't log out" on screen above a row that has already gone grey, and
// leaves the honest reading ("the file is gone; the revoke is unknown") available to neither
// surface. Same split `callTelegram` enforces between a REFUSAL and an UNKNOWN OUTCOME (richmsg.ts):
// only the outcome that is genuinely "nothing happened" may be reported as one.
export type LogoutOutcome =
  | { kind: 'ok'; said: string }
  | { kind: 'partial'; error: string }   // credentials gone, revoke unknown
  | { kind: 'failed'; error: string }    // credentials still there, nothing happened

/** The one-line outcome both surfaces report, from the CLI's own words. */
export function logoutResultText(account: string, cliSaid: string): string {
  // The CLI's sentence already ends in a full stop; appending ours produced "account.." on the first
  // live run. Trim its terminator rather than dropping our own — a CLI that stops punctuating still
  // gets a clean sentence.
  const said = (cliSaid.trim().split('\n').find(l => l.trim()) ?? '').replace(/[.!]+$/, '')
  // "Sign in on its row", not "Launch it again": the row's own action is the way back in, and the
  // Launch button this used to name is being retired with the whole launcher concept (owner,
  // 2026-08-21). Pointing at a button that will not exist is worse than pointing at nothing.
  return `👤 Logged out of ${account} on this box${said ? ` — ${said}` : ''}. Sign in on its row to come back.`
}

/**
 * The half-outcome: the credentials file is gone, so this box IS signed out, but the CLI exited
 * non-zero and nothing here can say whether Anthropic revoked the token server-side. Never phrased
 * as a failure — the row has already gone grey, and a message contradicting it is the defect.
 */
export function logoutPartialText(account: string, error: string): string {
  return `⚠️ ${account} is signed out on this box — its credentials file is gone — but the CLI exited with an error, ` +
    `so whether the token was revoked server-side is unknown: ${error}. Sign in on its row to come back.`
}
