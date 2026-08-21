// "Sign in" — the ONLY action a signed-out account row offers, and deliberately NOT a launcher.
//
// The owner went looking for a way to end a login and found none (that gap became the logout
// feature, v0.5.194). The way BACK in was the same shape of gap wearing a different hat: the row's
// 🚀/Launch button opened the spawn sheet, so signing in meant starting a real session, picking a
// folder, and knowing that a config dir with no credentials lands on the login screen by itself.
// His ruling, 2026-08-21: *"if I'm adding a separate account, it should be able to just run a
// headless session for the login to succeed"* — and the launcher concept goes away entirely rather
// than being renamed.
//
// So: a headless pane on that account, no topic, no card, no picker, whose whole job is to reach the
// login screen. The bridge already relays the method picker and the sign-in link (relayLoginChoice /
// relayAuthUrlToTelegram, fired by the all-pane sweep), and since v0.5.197 both escalate
// `own targets → fleetSurfaceFor → ownerCardChats()` when a pane has no surface of its own.
//
// THAT ESCALATION IS THE PRECONDITION FOR THIS WHOLE FEATURE, and it is why "make the login pane
// headless" would have been the wrong call a day earlier: a headless pane is surfaceless by
// definition, and until 0b82962 the relay returned on an empty target list — `auth-url card … → NO
// TARGETS (not sent)`, four times, on the owner's own pane. Narrow that escalation and this goes
// dark silently.
//
// cwd is $HOME, not the config dir (his ruling, twice: "'in that account's config dir' meant the
// account, not the working directory"). The account is CLAUDE_CONFIG_DIR — that is what decides
// which login is being established — and running claude with cwd ~/.claude-<name> would mint a
// self-referential projects/ entry inside the config dir for no gain.

/** A live sign-in pane, persisted so it survives the daemon restart that outlives its timer. */
export type SigninRecord = {
  account: string
  configDir: string
  pane: string
  sessionId: string
  /**
   * ABSOLUTE deadline, never a duration. A daemon that comes back mid-window finishes the ORIGINAL
   * window instead of starting a fresh one — the rule the live /terminal card was rebuilt on
   * (v0.5.189), against 149 daemon restarts in nine days.
   */
  until: number
}

/** 30 minutes: long enough to find the link on a phone, short enough that a forgotten pane goes. */
export const SIGNIN_TTL_MS = 30 * 60_000

export type SigninPlan =
  | { kind: 'spawn' }
  /**
   * A pane is already up for this account — ADOPT it rather than spawning a rival. A second tap is
   * what a human does when the first card is slow, and two panes racing one login is a way to lose
   * the code: the reply is routed to the pane that ASKED, so the loser's screen is the live one.
   */
  | { kind: 'adopt'; record: SigninRecord }
  /** Already signed in — the row should not have offered this. Never spawns. */
  | { kind: 'already' }

export function planSignin(loggedIn: boolean, live: SigninRecord | null, now: number): SigninPlan {
  if (loggedIn) return { kind: 'already' }
  // An expired record is not a live pane: the sweep retires it, and a tap arriving in that gap must
  // start a fresh one rather than adopt something already being torn down.
  if (live && live.until > now) return { kind: 'adopt', record: live }
  return { kind: 'spawn' }
}

export type SigninSweepVerdict =
  /** Credentials appeared — the login landed. Retire the pane, drop the row, say so once. */
  | { kind: 'done' }
  /** The window closed with no login. Retire the pane and SAY SO — silence here reads as success. */
  | { kind: 'expired' }
  /** The pane died under us (he closed it, the box bounced). Drop the row; nothing to report. */
  | { kind: 'gone' }
  | { kind: 'wait' }

export function planSigninSweep(
  r: SigninRecord,
  loggedIn: boolean,
  /** `'unknown'` is a FAILED tmux read, never evidence of absence — the standing rule here. */
  paneAlive: boolean | 'unknown',
  now: number,
): SigninSweepVerdict {
  // Success is tested FIRST, and independently of the pane: the login can land in the same tick the
  // pane dies (the CLI exits once it has written credentials), and the file is the fact that matters.
  if (loggedIn) return { kind: 'done' }
  if (paneAlive === false) return { kind: 'gone' }
  if (now >= r.until) return { kind: 'expired' }
  return { kind: 'wait' }
}

/** What the owner is told when a sign-in window closes with nothing signed in. */
export function signinExpiredText(account: string): string {
  return `🔑 The sign-in pane for ${account} timed out and was closed — nothing was signed in. ` +
    `Tap Sign in on its row to try again.`
}

/** What he is told when it works. The row going green is the other half of the answer. */
export function signinDoneText(account: string): string {
  return `✅ ${account} is signed in on this box. Its sign-in pane has been closed.`
}
