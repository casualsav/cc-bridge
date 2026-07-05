// Slack-scoped state-dir paths — the analogue of common.ts's telegram paths (which point at
// ~/.claude/channels/telegram and must NOT be reused). Everything the Slack daemon persists lives
// under ~/.claude/channels/slack/, mirroring the per-channel layout decided in multi-channel.md §2.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SLACK_STATE_DIR = process.env.SLACK_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'slack')
export const SLACK_ENV_FILE = join(SLACK_STATE_DIR, '.env')
export const SLACK_ACCESS_FILE = join(SLACK_STATE_DIR, 'access.json')
export const SLACK_PID_FILE = join(SLACK_STATE_DIR, 'daemon.pid')
export const SLACK_SOCKET_PATH = join(SLACK_STATE_DIR, 'daemon.sock')
export const SLACK_LOG_FILE = join(SLACK_STATE_DIR, 'daemon.log')
export const SLACK_INBOX_DIR = join(SLACK_STATE_DIR, 'inbox')

// Load ~/.claude/channels/slack/.env into process.env (real env wins) — mirrors common.ts's loader
// but slack-scoped. Best-effort: a missing file just leaves process.env as-is (the daemon then
// fails with its clear missing-token message).
export function loadSlackEnv(): void {
  try {
    for (const line of readFileSync(SLACK_ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}
