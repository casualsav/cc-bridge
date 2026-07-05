// Process + hashing primitives shared across the bridge.
// Side-effect free and importable (daemon.ts is not — it boots the bot on import),
// so these live here where they can be unit-tested and reused without starting a daemon.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

// Promisified execFile: `await exec('tmux', [...args], { timeout })`.
export const exec = promisify(execFile)

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function hashText(s: string): string {
  return createHash('md5').update(s).digest('hex')
}
