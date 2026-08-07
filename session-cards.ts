// session-cards.ts — the DATA behind the bridge commands that render as a card.
//
// `/terminal`, `/diff` and `/health` each answer a question about a session or about the bridge.
// Until v0.4.393 each answer existed only as Telegram HTML, built inline at the command handler, so
// the mini app could not show one without a second implementation of the same question — and two
// implementations of "what does /diff mean" is exactly how two surfaces come to disagree.
//
// So the gathering lives here and returns STRUCTURE; the rendering stays at each surface, because
// Telegram renders HTML into a message and the mini app renders elements into a feed, and those are
// genuinely different jobs. daemon.ts's `sendDiff` and the webapp's card path both call
// `collectDiff` — neither parses git output itself.
//
// `/health` is the stated exception and does NOT live here: its inputs are a dozen pieces of live
// daemon state (adopted panes, queue depths, the watchdog pid, the log tail), so a module boundary
// would be twelve parameters wide and would buy nothing. It is extracted as `collectHealth` inside
// daemon.ts instead — same rule, same single producer, no new seam.

import { exec } from './proc.ts'

/** One file's line churn, off `git diff --stat`. */
export type DiffFile = { path: string; added: number; removed: number }

export type DiffCard = {
  cwd: string
  /** Nothing to show: the working tree matches HEAD and there are no untracked files. */
  clean: boolean
  files: DiffFile[]
  /** `git diff --stat` verbatim. The mini app renders `files`; Telegram has always shown this block
   *  and keeps doing so, so moving the gathering here changes no message the owner already reads. */
  stat: string
  untracked: string[]
  /** The unified patch, capped. Empty when the only changes are untracked files. */
  patch: string
  truncated: boolean
}

/** Anything the card producers can fail with, rendered as the card's own error state. */
export type CardError = { error: string }

// The cap is the same 16k the Telegram path has always relayed. It is a CHAR cap and not a line cap
// because the thing being protected is the payload, and one minified file's diff is a single line.
export const DIFF_PATCH_CAP = 16_000

// `git diff --stat`'s body rows are `path | N +++---`, with a trailing summary line that has no
// pipe. A binary file reads `path | Bin 0 -> 12 bytes` and has no +/- run at all, which is why the
// counts come from the plus/minus GLYPHS rather than from the number before them: that number is
// the total churn for text files and a byte count for binaries, and reporting bytes as added lines
// is a wrong answer that looks right.
//
// The glyph run is what `--stat` scales to the terminal width, so on a very wide change git prints
// a proportional bar rather than one glyph per line. Reading it is therefore a RATIO applied to the
// stated total, not a count — which is exact in the common case (total ≤ the width git allots) and
// proportional in the rare one, the same approximation git's own display makes.
export function parseDiffStat(stat: string): DiffFile[] {
  const out: DiffFile[] = []
  for (const line of stat.split('\n')) {
    const m = /^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)\s*$/.exec(line)
    if (!m) continue
    const [, path, totalRaw, glyphs] = m
    const total = Number(totalRaw)
    const plus = (glyphs!.match(/\+/g) ?? []).length
    const minus = (glyphs!.match(/-/g) ?? []).length
    const shown = plus + minus
    // No glyphs at all (a mode change, or a rename with no content churn) — the total is the truth
    // and there is nothing to split it by, so it is reported as neither added nor removed.
    if (!shown) { out.push({ path: path!, added: 0, removed: 0 }); continue }
    const added = Math.round((plus / shown) * total)
    out.push({ path: path!, added, removed: total - added })
  }
  return out
}

/**
 * The session folder's uncommitted state: churn per file, untracked names, and the capped patch.
 * `cwd` must already be resolved from the pane — this function does not read tmux.
 */
export async function collectDiff(cwd: string): Promise<DiffCard | CardError> {
  try {
    const { stdout: porcelain } = await exec('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 4000 })
    const untracked = porcelain.split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3).trim()).filter(Boolean)
    if (!porcelain.trim()) return { cwd, clean: true, files: [], stat: '', untracked: [], patch: '', truncated: false }
    const { stdout: stat } = await exec('git', ['-C', cwd, 'diff', 'HEAD', '--stat'], { timeout: 6000 }).catch(() => ({ stdout: '' }))
    const { stdout: raw } = await exec('git', ['-C', cwd, 'diff', 'HEAD'], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 }).catch(() => ({ stdout: '' }))
    const truncated = raw.length > DIFF_PATCH_CAP
    return {
      cwd, clean: false, files: parseDiffStat(stat), stat: stat.trim(), untracked,
      patch: truncated ? raw.slice(0, DIFF_PATCH_CAP) : raw, truncated,
    }
  } catch (e) {
    const msg = String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e)
    // "Not a repo" is a normal state a session can be in, not a fault — it gets its own sentence so
    // the card can say what is true instead of showing a git error to someone who did nothing wrong.
    return { error: /not a git repository/i.test(msg) ? `${cwd} isn't a git repository, so there's nothing to diff.` : msg.slice(0, 600) }
  }
}

// ---- The patch, classified for rendering ----
//
// Both surfaces colour a diff by line class, and both were about to write the same four-branch test.
// It is one function here so a hunk header cannot read as context on one surface and as a heading on
// the other. `+++`/`---` are checked BEFORE `+`/`-`: a file header starts with the same character as
// an added line, and testing in the other order paints every file header green.
export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context'

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') ||
      line.startsWith('deleted file') || line.startsWith('similarity ') ||
      line.startsWith('rename ') || line.startsWith('old mode') || line.startsWith('new mode')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}
