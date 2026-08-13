// installed-copies.ts — the off-mcp convention that lives OUTSIDE the plugin cache: the doc itself
// in `~/.claude/cc-bridge.md` (wholly ours, overwritten on sync) plus one `@cc-bridge.md` import
// line between markers in the user's own `~/.claude/CLAUDE.md`. Neither ships with a build.
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
// What lives between the markers since the convention moved into its own file: one import line.
export const CONV_IMPORT = '@cc-bridge.md'

/**
 * Sync the convention from `<srcDir>/off-mcp/CLAUDE.md`: write the doc to
 * `<home>/.claude/cc-bridge.md` and keep the marker block in `<home>/.claude/CLAUDE.md` down to
 * the one `@cc-bridge.md` import line — a fat pre-import block (marker-wrapped, or the legacy
 * heading through to the next top-level `#`) collapses to it.
 *
 * Conservative in the same three ways update.ts is, and for the same reasons: it never CREATES
 * `CLAUDE.md` (absent means the user opted out of the convention, not that it needs installing),
 * it only ever replaces content it can identify as its own, and it preserves everything outside
 * that span — `cc-bridge.md` is written only for an install that carries our block. Returns a
 * note when it wrote, `null` when there was nothing to do — a caller reports the note and never
 * fails on `null`.
 */
export function syncConventionBlock(srcDir: string, home: string): string | null {
  try {
    const template = readFileSync(join(srcDir, 'off-mcp', 'CLAUDE.md'), 'utf8').trim() + '\n'
    const dest = join(home, '.claude', 'CLAUDE.md')
    if (!existsSync(dest)) return null
    const cur = readFileSync(dest, 'utf8')
    const wrapped = `${CONV_BEGIN}\n${CONV_IMPORT}\n${CONV_END}`
    // Match a marker block under ANY past project name (by its signature) and rewrite it to the
    // current pair, so renaming the project never doubles the block.
    const mk = cur.match(/<!-- BEGIN (\S+) \(off-mcp convention — auto-synced by \/update; edits inside are overwritten\) -->/)
    const begin = mk?.[0] ?? CONV_BEGIN
    const end = mk ? `<!-- END ${mk[1]} -->` : CONV_END
    const b = cur.indexOf(begin), e = cur.indexOf(end)
    let next: string | null = null
    if (b !== -1 && e !== -1 && e > b) {
      next = cur.slice(0, b) + wrapped + cur.slice(e + end.length)
    } else {
      const heading = CONV_HEADINGS.find(h => cur.includes(h))
      const hi = heading ? cur.indexOf(heading) : -1
      if (heading && hi !== -1) {
        const after = cur.indexOf('\n# ', hi + heading.length)
        const tail = after === -1 ? '' : cur.slice(after + 1)
        next = cur.slice(0, hi) + wrapped + (tail ? '\n\n' + tail : '\n')
      }
    }
    if (next == null) return null   // no block of ours anywhere — the user opted out
    const doc = join(home, '.claude', 'cc-bridge.md')
    const docStale = !existsSync(doc) || readFileSync(doc, 'utf8') !== template
    if (docStale) writeFileSync(doc, template)
    if (next !== cur) {
      writeFileSync(dest, next)
      return 'migrated ~/.claude/CLAUDE.md to the @cc-bridge.md import'
    }
    return docStale ? 'refreshed the off-mcp convention in ~/.claude/cc-bridge.md' : null
  } catch { return null }
}
