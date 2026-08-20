// refresh-exit.ts — the restart lanes' `/exit`, and the one thing it must do that a raw sendKeys
// cannot: READ THE CLI'S ANSWER.
//
// `/exit` is not a keystroke, it is a request. When a session still has work running — a subagent, a
// background shell, a scheduled task — the CLI answers with a confirmation instead of exiting, and a
// lane that does not look leaves a live session wedged on a modal nobody asked for. That is what the
// stale-session sweep did to @hourlyedge on 2026-08-20: `/exit` at 04:33:2x, wedged until @chat sent
// Escape 88 seconds later, and not one log line named the cause.
//
// The loop is HERE, with its primitives injected, for the same reason `runHermesTurn` is: a probe
// that re-implements it against a real pane proves only that the probe works. `scripts/
// refresh-exit-guard.ts` drives THIS function over two real panes, and `refresh-exit.test.ts` drives
// it over a scripted one — the daemon binds tmux to it and adds nothing.
import { isExitConfirmDialog } from './prompt.ts'

// A pane holding the dialog stays agent-alive for every one of these, so the bound is what caps the
// wedge window, not what caps a normal exit (which ends in two or three settles). 40 × ≤1.5s.
export const EXIT_SETTLE_ROUNDS = 40

export type ExitPanePrimitives = {
  sendKeys: (keys: string[]) => Promise<unknown>
  capture: () => Promise<string>
  agentLive: () => Promise<boolean>
  settle: () => Promise<unknown>
}

// 'declined' = the CLI reported background work and we backed out. The pane is left exactly as it
// was found: at its own prompt, its work running, its session on its old build. The caller must read
// that as "not now" — never as a failed restart, and never as a restart that happened.
//
// ESCAPE, NEVER ENTER. Option 1 of that dialog is "Exit and stop tasks" and it is PRESELECTED, so
// the keystroke that reads as "yes, do the thing we asked for" is the one that stops the very work
// the dialog exists to protect. `escapeKeys` is the caller's interrupt (`['Escape']`); there is
// deliberately no parameter by which a caller could pass Enter.
//
// The dialog is checked on EVERY settle, not once after the loop: checking late would hold the
// session on the modal for the full ~8-17s the loop runs, and the entire value of this function is
// that an unattended sweep leaves nothing behind it.
export async function runRestartExit(p: ExitPanePrimitives, exitKeys: string[], escapeKeys: string[]): Promise<'exited' | 'declined'> {
  await p.sendKeys(exitKeys)
  for (let i = 0; i < EXIT_SETTLE_ROUNDS && await p.agentLive(); i++) {
    await p.settle()
    if (!isExitConfirmDialog(await p.capture())) continue
    await p.sendKeys(escapeKeys)
    return 'declined'
  }
  return 'exited'
}
