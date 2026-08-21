#!/usr/bin/env bun
// repo-state-probe.ts — run the REAL `tg repo` state block against a real checkout, and time it.
//
//   bun scripts/repo-state-probe.ts /home/ubuntu/projects/cc-bridge
//
// The check that can fail is ATTRIBUTION: on a box where a session has been editing a dirty file, the
// block must name that session, and it must name a session that has already ENDED for what it left
// behind. A unit test on fixtures cannot answer that — it proves the renderer, not that the identity
// chain resolves a live pane to the conversation whose subagents did the writing.
//
// It calls `gatherRepoState` itself, so what it prints is the daemon's own reads. The two daemon-shaped
// lookups — which sessions are in this repo, and which conversation each one is writing — are rebuilt
// here from the same records the daemon reads (topics.json, the CLI's session registry, the pane
// stamps), deliberately WITHOUT importing daemon.ts: that file starts a daemon on import, and a probe
// that shares the daemon's own resolution could not disagree with it.
//
// Read-only. It writes no owner store (`--store` opts into the persisted one) and touches no pane.
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { listAccounts, accountByName, MAIN_ACCOUNT } from '../accounts.ts'
import { STATE_DIR } from '../common.ts'
import { listPending } from '../agent-bus.ts'
import { paneFreedom, readRegistryRows, rowForPane, rowIsLive } from '../session-freedom.ts'
import { recordedTranscript } from '../transcript-owner.ts'
import { projectDirName } from '../transcript.ts'
import { getSessionEnd, endAgeLabel, timeOf } from '../session-end.ts'
import { listTopics } from '../topics.ts'
import { capsulePathTokens, loadBriefRecord } from '../repo-brief.ts'
import { renderRepoState } from '../repo-state.ts'
import { gatherRepoState, loadOwnerStore, ownerStorePath, type GatherSession } from '../repo-state-gather.ts'

const execFileAsync = promisify(execFile)
const root = process.argv[2]
if (!root) { console.error('usage: bun scripts/repo-state-probe.ts <repo path> [--store]'); process.exit(2) }
const usePersistedStore = process.argv.includes('--store')

const git = async (args: string[], cwd = root): Promise<string | null> => {
  try { return (await execFileAsync('git', args, { cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024 })).stdout } catch { return null }
}

/** sessionId → pane, from the tmux pane stamps the daemon writes (`@tg_session`). */
async function paneStamps(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const listed = await execFileAsync('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{@tg_session}'], { timeout: 5000 }).catch(() => null)
  for (const line of (listed?.stdout ?? '').split('\n')) {
    const [pane, sid] = line.split('\t')
    if (pane && sid) out.set(sid, pane)
  }
  return out
}

async function main(): Promise<void> {
  const worktrees = [root]
  for (const line of ((await git(['worktree', 'list', '--porcelain'])) ?? '').split('\n')) {
    if (line.startsWith('worktree ')) worktrees.push(line.slice(9).trim())
  }
  const now = Date.now()
  const stamps = await paneStamps()
  const configDirs = listAccounts().map(a => a.configDir)
  const registry = readRegistryRows(configDirs)
  const sessions: GatherSession[] = []
  for (const t of listTopics()) {
    if (!t.cwd || !worktrees.some(r => t.cwd === r || t.cwd.startsWith(r + '/'))) continue
    const open = !t.closed && t.killedAt == null
    const end = getSessionEnd(t.sessionId)
    const endedAt = t.killedAt ?? (end ? timeOf(end) : 0)
    if (!open && !(endedAt > 0 && now - endedAt <= 24 * 60 * 60 * 1000)) continue
    const pane = open ? stamps.get(t.sessionId) ?? null : null
    // Live: the CLI's own record for that pane (the daemon's `recordedConversation`). Ended: the row's
    // own conversation id under its account's projects dir.
    let transcript: string | null = null
    if (pane) {
      const row = rowForPane(pane, registry)
      const rec = recordedTranscript(row && rowIsLive(row) ? row : null, existsSync)
      transcript = rec.kind === 'file' ? rec.file : null
    } else if (t.agentSessionId) {
      const dir = (t.account ? accountByName(t.account) : null)?.configDir ?? MAIN_ACCOUNT.configDir
      const file = join(dir, 'projects', projectDirName(t.cwd), `${t.agentSessionId}.jsonl`)
      transcript = existsSync(file) ? file : null
    }
    sessions.push({
      name: t.name,
      live: open,
      ...(open ? {} : { endedAgo: endAgeLabel(Math.max(0, now - endedAt)) }),
      state: pane ? paneFreedom(pane, configDirs).status ?? 'unknown' : 'unknown',
      asks: open ? listPending().filter(p => p.toSid === t.sessionId && p.toKind === 'claude' && !p.expiredAt).map(p => ({
        id: p.id, from: p.fromName, ageMs: Math.max(0, now - p.createdAt),
        firstLine: p.text.replace(/\s+/g, ' ').trim().slice(0, 60), injected: p.injected,
      })) : [],
      transcript,
      cwd: t.cwd,
    })
  }

  const rec = loadBriefRecord(STATE_DIR, root)
  // TWICE, and both numbers matter. The first pays for every transcript from byte 0 — what a box pays
  // once, after a deploy wipes nothing and the store is simply new. The second is what `tg repo` costs
  // in steady state, and it is the one the block's own `read Nms` will report.
  let store = usePersistedStore ? loadOwnerStore(ownerStorePath(STATE_DIR)) : {}
  const run = () => gatherRepoState({
    root,
    sessions,
    lastReports: [],
    capsulePaths: rec ? { total: capsulePathTokens(rec.brief).length, missing: [] } : null,
    git: args => git(args),
    now,
    store,
    saveStore: s => { store = s },
  })
  const cold = await run()
  const state = await run()

  console.log(renderRepoState(state, Date.now()))
  console.log('')
  console.log(`— gather: cold ${cold.readMs}ms, warm ${state.readMs}ms · ${sessions.length} session(s) here, ${sessions.filter(s => s.transcript).length} with a conversation`)
  for (const s of sessions) console.log(`  @${s.name} ${s.live ? 'live' : `ended ${s.endedAgo}`} · ${s.transcript ?? 'NO CONVERSATION'}`)
  const unowned = state.owners.filter(o => !o.sessions.length).map(o => o.path)
  if (unowned.length) console.log(`  unowned: ${unowned.join(', ')}`)
}

void main()
