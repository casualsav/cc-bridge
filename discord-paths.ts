// Discord-scoped state-dir paths — the analogue of common.ts's telegram paths (which point at
// ~/.claude/channels/telegram and must NOT be reused) and slack-paths.ts. Everything the Discord
// daemon persists lives under ~/.claude/channels/discord/, mirroring the per-channel layout decided
// in multi-channel.md §2.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DISCORD_STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
export const DISCORD_ENV_FILE = join(DISCORD_STATE_DIR, '.env')
export const DISCORD_ACCESS_FILE = join(DISCORD_STATE_DIR, 'access.json')
export const DISCORD_PID_FILE = join(DISCORD_STATE_DIR, 'daemon.pid')
export const DISCORD_SOCKET_PATH = join(DISCORD_STATE_DIR, 'daemon.sock')
export const DISCORD_LOG_FILE = join(DISCORD_STATE_DIR, 'daemon.log')
export const DISCORD_INBOX_DIR = join(DISCORD_STATE_DIR, 'inbox')

// Load ~/.claude/channels/discord/.env into process.env (real env wins) — mirrors common.ts's
// loader but discord-scoped. Best-effort: a missing file just leaves process.env as-is (the daemon
// then fails with its clear missing-token message).
export function loadDiscordEnv(): void {
  try {
    for (const line of readFileSync(DISCORD_ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}
