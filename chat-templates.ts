// What to do about the chat account's CLAUDE.md on this boot. Pure, so the decision table can be
// tested without a daemon, a bot or a second instance — which is what it took to find the hole it
// closes.
//
// THE INCIDENT (2026-07-28, attributed to the millisecond). Two bridge instances share one chat
// account dir (~/.claude-chat) and keep SEPARATE state and logs. At 21:09:59.071 the canary instance
// copied the new template and logged it; 54ms later the main instance found the file already
// byte-identical, took its silent early-return, and recorded the new baseline. The result: the
// operator's own bot said NOTHING about a change to his chat agent's instructions, and its log had
// no line to explain the silence. Nothing was broken — the refresh was correct — but the only
// evidence of it was in the other instance's log, and the notice went out over the other instance's
// bot. "Correct and invisible" is the failure mode this table exists to remove.
//
// The distinction that makes it safe: a baseline we have NEVER recorded means this box is new to us
// (provisioning wrote that file moments ago), and announcing a "refresh" there would be a notice
// about something that never happened. A baseline we recorded and that has since MOVED means the
// operator's instructions really did change under us, whoever wrote them.
export type RefreshPlan =
  // The steady state, and the common one: nothing to do and nothing to say. Deliberately silent —
  // a line here would be printed on every boot of every instance forever, which is how a log stops
  // being read.
  | { do: 'nothing' }
  // The live file already matches the template. `announce` separates "it changed under us" (say so)
  // from "we have never seen this box" (record it and stay quiet).
  | { do: 'record'; announce: boolean }
  // Untouched by the operator and out of date: overwrite it, then say so.
  | { do: 'copy' }
  // The operator edited it. Never overwritten; they are told a newer one exists.
  | { do: 'leave' }

export function planTemplateRefresh(a: {
  tplH: string
  liveH: string
  baseline?: string
  unedited: boolean
}): RefreshPlan {
  if (a.tplH === a.liveH) {
    if (a.baseline === a.tplH) return { do: 'nothing' }
    return { do: 'record', announce: a.baseline !== undefined }
  }
  return a.unedited ? { do: 'copy' } : { do: 'leave' }
}
