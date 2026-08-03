// The OAuth usage endpoint's response, parsed. The fixture below is the SHAPE OF A REAL RESPONSE,
// recorded from `GET https://api.anthropic.com/api/oauth/usage` on 2026-08-03 (percentages kept, ids
// dropped) — a hand-invented shape would have proved only that the parser matches my imagination.
//
// What a broken version looks like: reading `seven_day_opus`/`seven_day_fable` for the per-model row.
// There is no such field — the scoped windows live in `limits[]`, and the fixture keeps the nulls that
// would have made that mistake pass a shallower test.
import { test, expect } from 'bun:test'
import { parseUsageResponse } from './usage-api.ts'

const LIVE = {
  five_hour: { utilization: 7.0, resets_at: '2026-08-03T22:00:00.121138+00:00', limit_dollars: null },
  seven_day: { utilization: 14.0, resets_at: '2026-08-09T16:00:00.121162+00:00', limit_dollars: null },
  seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, cinder_cove: null,
  extra_usage: { is_enabled: false, used_credits: null, user_disabled: true },
  limits: [
    { kind: 'session', group: 'session', percent: 7, resets_at: '2026-08-03T22:00:00.121138+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 14, resets_at: '2026-08-09T16:00:00.121162+00:00', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 10, resets_at: '2026-08-09T16:00:00.121447+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, enabled: false },
}

test('the live response yields both account windows and the scoped Fable row', () => {
  const r = parseUsageResponse(LIVE)!
  expect(r.fiveHour).toEqual({ pct: 7, resetsAt: Date.parse('2026-08-03T22:00:00.121138+00:00') })
  expect(r.sevenDay!.pct).toBe(14)
  expect(r.scoped).toEqual([{ label: 'Fable', pct: 10, resetsAt: Date.parse('2026-08-09T16:00:00.121447+00:00') }])
})

// `session`/`weekly_all` share the array with the scoped rows and carry `scope: null`. Taking them too
// would render "🔮 undefined 7%" beside the 5h row that already says the same thing.
test('only weekly_scoped entries with a model become rows', () => {
  const r = parseUsageResponse(LIVE)!
  expect(r.scoped.map(s => s.label)).toEqual(['Fable'])
})

// The scoped row is a truth about the account, not a fixture of it: an account without one gets NO row.
// A synthesized 0% would read as "you have used none of your Fable week", which is a different claim.
test('no scoped entry yields no scoped rows, never a zero', () => {
  const r = parseUsageResponse({ ...LIVE, limits: LIVE.limits.filter(l => l.kind !== 'weekly_scoped') })!
  expect(r.scoped).toEqual([])
  expect(r.fiveHour).toBeDefined()
})

// resets_at is an ISO STRING here; the statusline snapshot's is epoch SECONDS. Parsing one as the other
// is a silent 1970 (or a countdown ~55 years long), so the two sources' types are pinned separately.
test('resets_at parses as ISO-8601, and an unparseable one degrades to unknown rather than NaN', () => {
  const r = parseUsageResponse({ ...LIVE, five_hour: { utilization: 7, resets_at: 'not-a-date' } })!
  expect(r.fiveHour).toEqual({ pct: 7, resetsAt: 0 })
})

test('the spend meter is read as a bound: amount, currency, and whether anything is enabled', () => {
  const r = parseUsageResponse(LIVE)!
  expect(r.spend).toEqual({ usedMinor: 0, currency: 'USD', enabled: false, extraUsage: false })
})

// Nothing datable ⇒ null ⇒ the caller falls back to the statusline snapshot. `spend` alone is not a
// reading: it cannot date a header, and a header that cannot be dated is not shown at all.
test('a response with no windows and no scoped rows is not a reading', () => {
  expect(parseUsageResponse({ five_hour: null, seven_day: null, limits: [], spend: LIVE.spend })).toBeNull()
  expect(parseUsageResponse(null)).toBeNull()
  expect(parseUsageResponse('nope')).toBeNull()
})

// A percentage the server did not state must never be invented — `utilization: null` is "no reading",
// which is not the same as 0%.
test('a null utilization is absence, not zero', () => {
  const r = parseUsageResponse({ ...LIVE, five_hour: { utilization: null, resets_at: LIVE.five_hour.resets_at } })!
  expect(r.fiveHour).toBeUndefined()
  expect(r.sevenDay!.pct).toBe(14)
})
