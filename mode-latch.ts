import type { CcMode } from './prompt.ts'

// The permission mode a session's card shows, held across the frames that cannot see it.
//
// `detectCurrentMode` reads the mode off Claude Code's footer indicator ("⏵⏵ bypass permissions on
// …"), and that footer slot is SHARED with the CLI's transient hints. A frame showing "paste again to
// expand" carries no indicator at all, so the read falls through to 'default' — measured on the
// owner's own chat lane 2026-07-29, 1 frame in 50 at a 5s cadence, which on the sessions card is the
// mode chip blinking out and back. That lane hits it most often because the daemon PASTES every
// inbound message into its pane, but nothing about the mechanism is chat-specific.
//
// So a captured 'default' is TWO states wearing one name: genuinely Ask mode, and "no indicator on
// this frame". One frame cannot tell them apart — Ask mode renders no ⏵⏵ line either — so this latches
// the last mode actually SEEN and serves it for the ambiguous reads. Only a visible indicator ever
// writes the latch, so it can never invent a mode the pane did not show.
//
// It DECAYS, and that is the half that keeps it honest: a user who cycles the pane to Ask by hand
// produces nothing but ambiguous reads from then on, and a permanent latch would keep claiming the old
// mode forever. Five minutes is orders of magnitude longer than a hint frame (seconds) and short
// enough that a real switch to Ask converges on its own.
export const MODE_LATCH_MS = 5 * 60 * 1000
export type ModeLatch = Map<string, { mode: CcMode; at: number }>

export function latchMode(latch: ModeLatch, key: string, seen: CcMode, now: number = Date.now()): CcMode {
  if (seen !== 'default') {
    latch.set(key, { mode: seen, at: now })
    return seen
  }
  const held = latch.get(key)
  if (held && now - held.at < MODE_LATCH_MS) return held.mode
  latch.delete(key)
  // Sessions come and go for as long as the daemon runs, so an entry nobody reads again must not be
  // immortal. Pruned on the one path that already proves entries can be stale, and only above a size
  // no real fleet reaches.
  if (latch.size > 200) for (const [k, v] of latch) if (now - v.at >= MODE_LATCH_MS) latch.delete(k)
  return 'default'
}
