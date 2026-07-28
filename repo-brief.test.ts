// The caps are enforced by this code or by nothing. The fixture below is not invented: it is the
// VERBATIM output of a sonnet scout run against /home/ubuntu/projects/taste during the design pilot,
// which was given every cap in a table under the sentence "Every cap is a hard limit — exceed one and
// the field is discarded" — and broke five of them anyway. Its sibling run broke six. That is the
// whole reason this module exists, so the test that proves enforcement uses the real violation.
import { test, expect } from 'bun:test'
import {
  CAPS, RENDER_CEILING, SCHEMA_VERSION, isStale, parseBriefJson, renderBrief, validateBrief,
} from './repo-brief.ts'

// Verbatim pilot output (taste), narration line included — one scout really did prefix its answer.
const PILOT_TASTE = `I have enough to produce the routing JSON.

\`\`\`json
{
  "name": "web-design-taste",
  "what": "Retrieval-augmented design-taste corpus + Skill/hooks that upgrade UI/UX quality for Claude Code sessions building web UI.",
  "stack": "Node >=20, npm; test: npm run validate; lint: npm run lint:design -- <file>; build tokens: npm run tokens:build",
  "surfaces": [
    "corpus/{production,expressive} — exemplars, patterns, tokens, principles, sources.json",
    ".claude/skills/web-design-taste — the Skill + references (craft layer)",
    ".claude/hooks + .claude/agents/design-critic.md — Phase 2 guardrail hooks & critic subagent",
    "tooling/ — harvest, capture, distill, evolve, reflect, design-lint, control-bot scripts",
    "tokens/ — tokens.json source and built tokens.css",
    "sites/ — directory site build (build.py) served from corpus"
  ],
  "deploy": "main branch; evolve PRs auto-open per-site, auto-merge.yml merges after 48h; deploy-site.yml redeploys taste.extant.cc on merge",
  "conventions": [
    "Never edit a taste repo's principles/, examples/, or SKILL.md as a side effect of unrelated work",
    "Adding an exemplar must go through capture → distill pipeline (tooling/capture.mjs, distill.mjs), never hand-written from a screenshot",
    "After capture/distill: npm run validate, npm run index:build, push captures branch before pushing main"
  ],
  "hazards": [
    "Self-evolving loop runs in GitHub Actions using a Telegram bot + repo secrets (CLAUDE_CODE_OAUTH_TOKEN) — real external services",
    "corpus/*/screenshots and raw/ are git-ignored and must be synced to a separate orphan 'captures' branch or deploy fails",
    "Stop-gate/hooks fail-open but gate 'done' status on lint errors and a mandatory visual (screenshot) pass"
  ],
  "docs": ["README.md", "docs/ARCHITECTURE.md", "CLAUDE.md"],
  "unknown": [
    "Whether tests beyond npm run validate/lint:design exist (no dedicated test suite found)",
    "Contents/state of proposals/ and whether any are pending review"
  ]
}
\`\`\``

test('the fence is extracted from a reply that narrates before it', () => {
  const parsed = parseBriefJson(PILOT_TASTE) as Record<string, unknown>
  expect(parsed).not.toBeNull()
  expect(parsed.what).toContain('Retrieval-augmented')
})

test('a real scout output that violates the caps is corrected, and every correction is reported', () => {
  const { brief, violations, usable } = validateBrief(parseBriefJson(PILOT_TASTE))
  expect(usable).toBe(true)

  // Every field is inside its cap afterwards — the property the daemon actually relies on.
  for (const [k, cap] of Object.entries(CAPS)) {
    const v = brief[k as keyof typeof brief]
    if (Array.isArray(v)) {
      expect(v.length).toBeLessThanOrEqual(cap.items!)
      for (const item of v) expect(item.length).toBeLessThanOrEqual(cap.chars)
    } else {
      expect(v.length).toBeLessThanOrEqual(cap.chars)
    }
  }
  // …and it did not pass silently. Note WHICH violations survive: this fixture broke five caps as the
  // pilot originally set them, and the revised caps absorb four of those — that is what "raised
  // because the overflow was routing content" means, checked rather than asserted. What remains is
  // the pre-pilot `name` field, which the schema now refuses because a scout-invented name is the one
  // field that can manufacture a misroute (this one said "web-design-taste" for a repo whose live
  // session is @taste).
  expect(violations).toEqual(["dropped unknown field 'name'"])
  expect(brief.aka).toBe('')          // and it is NOT quietly promoted into aka
})

// The sibling pilot run. Under the revised caps this one still overflows, which is why the fixture is
// here: a cap nothing violates proves nothing about enforcement.
const PILOT_MEMES = {
  what: 'Deterministic crypto trading-signal stack (no LLM) that scans Robinhood Chain + KTA/Base + ETH/SOL, scores wallets, fires Telegram confluence alerts, and paper-trades signals for the owner.',
  stack: 'Python 3, venv at .venv (duckdb, requests, eth_account); run daemons directly e.g. `.venv/bin/python hoodwatch.py`; ad hoc tests via `.venv/bin/python -m pytest test_hoodwatch_notifications.py` (no formal test/lint config found)',
  surfaces: ['hoodwatch.py — Robinhood Chain live ingest/scoring/alert daemon, writes hoodscan.duckdb'],
  deploy: 'runs as long-lived daemons on this box, relaunched every 5 min by keepalive.sh via cron; git push to origin is separate from deployment',
  conventions: ['Any backfill/bulk/indexing job MUST follow BACKFILL.md (throttle, nice/ionice, stream, checkpoint) before running'],
  hazards: ['hoodscan.duckdb is 6.2GB and ledger/kta.duckdb are live-written by running daemons — treat as a shared/live resource, not a static file'],
  docs: ['RUNBOOK.md', 'BACKFILL.md', 'HANDOFF.md'],
  unknown: ['whether test_hoodwatch_notifications.py (untracked, uncommitted) represents an established test convention or a one-off in progress'],
}

test('the second real scout output is clipped where it still overflows, and says so', () => {
  const { brief, violations, usable } = validateBrief(PILOT_MEMES)
  expect(usable).toBe(true)
  expect(brief.stack.length).toBe(CAPS.stack.chars)      // 228c of prose, clipped to the cap
  expect(brief.stack.endsWith('…')).toBe(true)
  expect(brief.unknown[0]!.length).toBeLessThanOrEqual(CAPS.unknown.chars)
  expect(violations.some(x => x.startsWith('stack: 228c'))).toBe(true)
  expect(violations.some(x => x.startsWith('unknown:'))).toBe(true)
})

test('a clipped field is marked, so a truncated line is distinguishable from a short one', () => {
  const { brief } = validateBrief({ what: 'x'.repeat(400), surfaces: ['a — b'] })
  expect(brief.what.endsWith('…')).toBe(true)
  expect(brief.what.length).toBe(CAPS.what.chars)
})

// The guard on the guard: if `validateBrief` silently accepted everything, the test above would still
// pass on a compliant fixture. Prove the checker can fail before trusting that it passed.
test('a compliant brief produces no violations at all', () => {
  const { violations, usable } = validateBrief({
    aka: 'market-edge', what: 'A repo.', stack: 'bun', verify: 'bun test',
    surfaces: ['x/ — a thing'], deploy: 'main', conventions: [], hazards: [], docs: ['README.md'], unknown: [],
  })
  expect(violations).toEqual([])
  expect(usable).toBe(true)
})

test('a brief missing what/surfaces is not usable — the caller re-runs rather than storing it', () => {
  expect(validateBrief({ stack: 'bun' }).usable).toBe(false)
  expect(validateBrief(null).usable).toBe(false)
  expect(validateBrief('not an object').usable).toBe(false)
})

test('the render never exceeds the ceiling, and says what it dropped to get there', () => {
  // Every field at its cap: the worst case the schema permits.
  const max = {
    aka: 'a'.repeat(60), what: 'w'.repeat(200), stack: 's'.repeat(160), verify: 'v'.repeat(120),
    surfaces: Array(6).fill('u'.repeat(100)), deploy: 'd'.repeat(180),
    conventions: Array(3).fill('c'.repeat(140)), hazards: Array(3).fill('h'.repeat(140)),
    docs: Array(3).fill('o'.repeat(80)), unknown: Array(3).fill('n'.repeat(100)),
  }
  const { brief } = validateBrief(max)
  const out = renderBrief(brief, { path: '/repo' })
  expect(out.length).toBeLessThanOrEqual(RENDER_CEILING)
  // what/verify/surfaces are never shed — a brief without them is not a brief.
  expect(out).toContain('w'.repeat(200))
  expect(out).toContain('v'.repeat(120))
})

test('a normal brief renders whole — the ceiling catches the outlier, it does not shape the median', () => {
  const { brief, violations } = validateBrief(parseBriefJson(PILOT_TASTE))
  const out = renderBrief(brief, { path: '/home/x/taste', age: '2h ago', violations: violations.length })
  expect(out).not.toContain('dropped:')
  expect(out).toContain('schema violation(s) corrected')
  expect(out.length).toBeLessThan(RENDER_CEILING)
})

test('staleness needs age AND a moved HEAD — never a commit alone, never age alone', () => {
  const now = 1_000_000_000_000
  const base = { path: '/r', brief: validateBrief({}).brief, generatedAt: now, gitHead: 'aaa', violations: 0, schemaVersion: SCHEMA_VERSION }
  const old = now - 20 * 86_400_000
  expect(isStale(base, 'bbb', now)).toBe(false)                          // moved, but fresh
  expect(isStale({ ...base, generatedAt: old }, 'aaa', now)).toBe(false)  // old, but untouched
  expect(isStale({ ...base, generatedAt: old }, 'bbb', now)).toBe(true)   // both
  expect(isStale({ ...base, stale: 'wrong surfaces' }, 'aaa', now)).toBe(true)      // a worker said so
  expect(isStale({ ...base, schemaVersion: SCHEMA_VERSION - 1 }, 'aaa', now)).toBe(true)  // shape changed
})
