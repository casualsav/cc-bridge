// installed-copies.ts — the off-mcp convention block that lives OUTSIDE the plugin cache, in the
// user's own `~/.claude/CLAUDE.md`, and therefore does not ship with a build.
//
// THE CLASS THIS EXISTS TO CLOSE. Everything a session reads at startup comes from files the plugin
// cache does not own. `/update` refreshed them (update.ts's `syncInstalledCopies`); `bun run deploy`
// never did. A dev box ships by deploy, so its installed convention froze at whatever the last
// `/update` wrote — measured 2026-08-06: 127 lines against a 180-line template, missing exactly the
// `## Handoffs` section added two days earlier, so every worker spawned here since had no handoff
// convention in context at all. The bug was invisible because both halves worked: the template was
// correct in the repo, and the installed copy was correct for the version that installed it.
//
// DELIBERATE DUPLICATE. `update.ts` keeps its own inlined copy of this logic and must: `startUpdate`
// (updates.ts) copies update.ts ALONE to `$STATE_DIR/update-run.ts` and runs it there, so it has no
// siblings on disk and a relative import would throw at startup. The marker constants are the part
// that has to agree — a block written under one BEGIN string is invisible to a reader looking for
// another — so `installed-copies.test.ts` asserts update.ts's literals still match these. Change a
// marker here and that test tells you the other copy needs it too.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONV_BEGIN = '<!-- BEGIN claude-tg (off-mcp convention — auto-synced by /update; edits inside are overwritten) -->'
export const CONV_END = '<!-- END claude-tg -->'
// First line of off-mcp/CLAUDE.md across its lifetimes, for installs predating the markers.
export const CONV_HEADINGS = ['# Telegram bridge (no MCP)', '# Reachable over Telegram (no MCP)']

/**
 * Rewrite the convention block in `<home>/.claude/CLAUDE.md` from `<srcDir>/off-mcp/CLAUDE.md`.
 *
 * Conservative in the same three ways update.ts is, and for the same reasons: it never CREATES the
 * file (absent means the user opted out of the convention, not that it needs installing), it only
 * ever replaces content it can identify as its own (a marker pair, or the legacy heading through to
 * the next top-level `#`), and it preserves everything outside that span. Returns a note when it
 * wrote, `null` when there was nothing to do — a caller reports the note and never fails on `null`.
 */
export function syncConventionBlock(srcDir: string, home: string): string | null {
  try {
    const template = readFileSync(join(srcDir, 'off-mcp', 'CLAUDE.md'), 'utf8').trim()
    const dest = join(home, '.claude', 'CLAUDE.md')
    if (!existsSync(dest)) return null
    const wrapped = `${CONV_BEGIN}\n${template}\n${CONV_END}`
    const cur = readFileSync(dest, 'utf8')
    // Match a marker block under ANY past project name (by its signature) and rewrite it to the
    // current pair, so renaming the project never doubles the block.
    const mk = cur.match(/<!-- BEGIN (\S+) \(off-mcp convention — auto-synced by \/update; edits inside are overwritten\) -->/)
    const begin = mk?.[0] ?? CONV_BEGIN
    const end = mk ? `<!-- END ${mk[1]} -->` : CONV_END
    const b = cur.indexOf(begin), e = cur.indexOf(end)
    if (b !== -1 && e !== -1 && e > b) {
      const next = cur.slice(0, b) + wrapped + cur.slice(e + end.length)
      if (next === cur) return null
      writeFileSync(dest, next)
      return 'refreshed the off-mcp convention in ~/.claude/CLAUDE.md'
    }
    // Legacy, marker-less: replace from our heading to the next top-level "# " (or EOF), migrating
    // it into markers. Our block has only the one top-level heading, so this span is exact.
    const heading = CONV_HEADINGS.find(h => cur.includes(h))
    if (!heading) return null
    const hi = cur.indexOf(heading)
    const after = cur.indexOf('\n# ', hi + heading.length)
    const tail = after === -1 ? '' : cur.slice(after + 1)
    writeFileSync(dest, cur.slice(0, hi) + wrapped + (tail ? '\n\n' + tail : '\n'))
    return 'migrated + refreshed the off-mcp convention in ~/.claude/CLAUDE.md'
  } catch { return null }
}
