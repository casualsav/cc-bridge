#!/usr/bin/env bun
// Drive ONE real turn on a pane-backed Hermes endpoint, outside the daemon.
//
//   bun scripts/hermes-pane-turn.ts <profile> "<prompt>" [session-id]
//
// It runs the SAME `runHermesTurn` loop the daemon runs (hermes-pane.ts) against a real tmux pane and
// the real `hermes` binary — which is the point: the daemon's own path can only be exercised by
// asking an agent something on a live surface, and a loop that can only be debugged in production is
// a loop nobody debugs. Prints the reply and the session id + watermark to carry into the next run;
// pass that id back as the third argument and the second turn must remember the first.
import { exec, sleep } from '../proc.ts'
import { stripAnsi } from '../prompt.ts'
import { hermesEnv } from '../hermes-driver.ts'
import { hermesChatArgv, hermesAtPrompt, parseHermesExport, parseSessionIds, runHermesTurn } from '../hermes-pane.ts'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const [profile, prompt, resumeId] = process.argv.slice(2)
if (!profile || !prompt) { console.error('usage: hermes-pane-turn.ts <profile> "<prompt>" [session-id]'); process.exit(2) }
const env = hermesEnv()
const tmux = `cc-hermes-probe-${profile}`
const sh = (args: string[], timeout = 30_000) => exec(args[0]!, args.slice(1), { timeout, env })

const paneOf = async (): Promise<string | null> => {
  try { return (await sh(['tmux', 'list-panes', '-t', tmux, '-F', '#{pane_id}'], 4000)).stdout.trim().split('\n')[0] || null } catch { return null }
}
let pane = await paneOf()
if (!pane) {
  const argv = hermesChatArgv({ name: profile, profile }, resumeId ?? null)
  console.log(`launching: ${argv.join(' ')}`)
  await sh(['tmux', 'new-session', '-d', '-s', tmux, '-x', '200', '-y', '50', '-c', tmpdir(), ...argv], 10_000)
  for (let i = 0; i < 90 && !pane; i++) {
    await sleep(1000)
    const p = await paneOf()
    if (p && hermesAtPrompt(stripAnsi((await sh(['tmux', 'capture-pane', '-p', '-t', p])).stdout))) pane = p
  }
  if (!pane) { console.error('pane never reached a prompt'); process.exit(1) }
}
console.log(`pane ${pane}`)

const r = await runHermesTurn({
  capture: async () => stripAnsi((await sh(['tmux', 'capture-pane', '-p', '-t', pane!])).stdout),
  deliver: async text => {
    // Plain paste + Enter: outside the daemon there is no delivery chain to serialize on, and this
    // probe is the only writer to its own pane.
    await sh(['tmux', 'set-buffer', '-b', 'hprobe', '--', text])
    await sh(['tmux', 'paste-buffer', '-b', 'hprobe', '-t', pane!])
    await sleep(300)
    await sh(['tmux', 'send-keys', '-t', pane!, 'Enter'])
    return true
  },
  sessionIds: async () => parseSessionIds((await sh(['hermes', '--profile', profile, 'sessions', 'list'], 30_000)).stdout),
  exportSession: async id => {
    const out = join(tmpdir(), `hprobe-${id}.jsonl`)
    try {
      await sh(['hermes', '--profile', profile, 'sessions', 'export', '--format', 'jsonl', '--session-id', id, '--yes', out], 60_000)
      return parseHermesExport(readFileSync(out, 'utf8'))
    } finally { try { rmSync(out, { force: true }) } catch {} }
  },
  sleep, now: Date.now,
}, prompt, { sessionId: resumeId ?? null, seen: Number(process.env.HERMES_SEEN ?? 0) })

console.log(r.ok ? `\n--- reply ---\n${r.reply}` : `\nFAILED: ${r.error}`)
console.log(`\nstate: ${JSON.stringify(r.state ?? null)}   (re-run with the id, and HERMES_SEEN=<seen>)`)
console.log(`pane still up as tmux session "${tmux}" — kill it with: tmux kill-session -t ${tmux}`)
