// usage-warn.ts — pure planning for the BOX-LEVEL usage-warning consolidation, extracted from
// daemon.ts's maybeWarn (modeled on ctx-warn.ts). The box runs more than one Anthropic account, and
// each account's own 50/75/90 ladder (per-account, per reset period — UNCHANGED, see maybeWarn) fires
// independently: two accounts crossing 75% in the same week each sent their own "You've used 75% of
// your weekly limit" ping, and the owner got two notices about one box.
//
// Detection stays per-account (collapsing it would risk swallowing a legitimate crossing — the exact
// hazard ctx-warn.ts's bug-12 note describes for a shared watermark). This is a SEPARATE, delivery-
// layer decision: given the box's last-sent marker for this limit `type`, should THIS crossing also
// send, or is the box already covered?
//
// `resetKey` identifies a reset period (epoch-derived from a live snapshot, descriptor-derived from a
// pane-banner scrape) exactly as the per-account ladder already uses it — see daemon.ts's maybeWarn.
export type UsageWarnMarker = { threshold: number; accountName: string; resetKey: string; at: number }
export type UsageWarnCandidate = { type: string; threshold: number; accountName: string; resetKey: string }

// `prevMarker` — the box's last-sent marker for this `type`, or null if nothing has fired yet.
// `candidate` — the crossing under consideration (already past its own account's per-account ladder).
// `currentResetKeyForMarkerAccount` — THIS poll's resetKey for `prevMarker.accountName` (same `type`),
// or null when that account's snapshot could not be read this tick. Unused when `prevMarker` is null.
//
// SUPPRESS iff a marker exists, its threshold already covers this crossing (>=), AND it is still
// fresh — meaning the firing account's CURRENT period matches the one the marker was set under. A
// missing/unreadable snapshot for the marker's account is treated as STILL FRESH: we cannot prove the
// period rolled, and the failure mode of assuming so wrongly (a second ping) is exactly the bug this
// exists to fix, so the conservative read is silence, not a resend.
export function planBoxUsageWarn(
  prevMarker: UsageWarnMarker | null,
  candidate: UsageWarnCandidate,
  currentResetKeyForMarkerAccount: string | null,
  now: number = Date.now(),
): { send: boolean; nextMarker: UsageWarnMarker } {
  const fresh = !prevMarker || currentResetKeyForMarkerAccount == null || currentResetKeyForMarkerAccount === prevMarker.resetKey
  const covered = !!prevMarker && fresh && prevMarker.threshold >= candidate.threshold
  if (covered) return { send: false, nextMarker: prevMarker! }
  return {
    send: true,
    nextMarker: { threshold: candidate.threshold, accountName: candidate.accountName, resetKey: candidate.resetKey, at: now },
  }
}
