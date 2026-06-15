// tunnel.ts — front the local webapp with public HTTPS via a cloudflared quick tunnel.
// Quick tunnels need no Cloudflare account or domain: `cloudflared tunnel --url http://127.0.0.1:<port>`
// connects out to Cloudflare's edge and prints an ephemeral https://<rand>.trycloudflare.com URL that
// proxies to the local port. We spawn it, parse that URL, expose it, and relaunch if it dies. Because
// the URL changes per run, the daemon injects the CURRENT url() into the Mini App launch button at
// send time rather than persisting it. See docs/files-mini-app.md §3.

import { spawn, type Subprocess, which } from 'bun'
import { join } from 'node:path'
import { existsSync, chmodSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'

// Exclude `api.trycloudflare.com` — cloudflared logs that (its API host) at startup BEFORE the real
// assigned `https://<random-words>.trycloudflare.com` URL, and we must not mistake it for the tunnel.
const TRYCF_RE = /https:\/\/(?!api\.)[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i

// cloudflared prints the assigned URL inside a boxed banner on stderr; pull the first trycloudflare URL.
export function parseTunnelUrl(text: string): string | null {
  const m = text.match(TRYCF_RE)
  return m ? m[0] : null
}

// Locate the cloudflared binary: explicit path → PATH → cached under <stateDir>/bin. Returns null if
// absent (callers then auto-fetch via ensureCloudflared, or fall back to WEBAPP_PUBLIC_URL).
export function findCloudflared(stateDir: string, explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  const onPath = which('cloudflared')
  if (onPath) return onPath
  const win = join(stateDir, 'bin', 'cloudflared.exe')
  if (existsSync(win)) return win
  const cached = join(stateDir, 'bin', 'cloudflared')
  return existsSync(cached) ? cached : null
}

// Pinned cloudflared release. Cloudflare publishes NO checksums file, so the sha256 below were computed
// from the official release binaries and pinned here; platforms without a pin verify by --version after
// download (HTTPS + the immutable versioned URL is the integrity floor). Bump VERSION + hashes together.
const CF_VERSION = '2026.6.0'
const CF_SHA256: Record<string, string> = {
  'linux-arm64': '8482ebf1e74a2a4a1a9f1e090e17e3de08423f94100ece6789287cb26fb9480f',
}
// Map node platform/arch → the release asset (and whether it's a .tgz needing extraction).
export function cfAsset(platform = process.platform, arch = process.arch): { name: string; key: string; tgz: boolean } | null {
  const la: Record<string, string> = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }
  if (platform === 'linux' && la[arch]) return { name: `cloudflared-linux-${la[arch]}`, key: `linux-${la[arch]}`, tgz: false }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64'))
    return { name: `cloudflared-darwin-${arch === 'x64' ? 'amd64' : 'arm64'}.tgz`, key: `darwin-${arch === 'x64' ? 'amd64' : 'arm64'}`, tgz: true }
  if (platform === 'win32') return { name: 'cloudflared-windows-amd64.exe', key: 'windows-amd64', tgz: false }
  return null
}

// Ensure a cloudflared binary exists: reuse a system/cached one, else fetch the pinned release into
// <stateDir>/bin (checksum-verified where pinned, else --version-checked) and chmod +x. Null on failure.
export async function ensureCloudflared(stateDir: string, log: (m: string) => void, explicit?: string): Promise<string | null> {
  const found = findCloudflared(stateDir, explicit)
  if (found) return found
  const asset = cfAsset()
  if (!asset) { log('tunnel: no cloudflared build for this platform — set WEBAPP_PUBLIC_URL'); return null }
  const binDir = join(stateDir, 'bin')
  const dest = join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/${asset.name}`
  try {
    await mkdir(binDir, { recursive: true })
    log(`tunnel: fetching cloudflared ${CF_VERSION} (${asset.name})…`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (asset.tgz) {                                   // darwin ships a gzipped tar holding `cloudflared`
      const tmp = join(binDir, 'cf.tgz')
      await Bun.write(tmp, bytes)
      await spawn(['tar', '-xzf', tmp, '-C', binDir, 'cloudflared']).exited
      await rm(tmp, { force: true })
    } else {
      await Bun.write(dest, bytes)
    }
    chmodSync(dest, 0o755)
    const want = CF_SHA256[asset.key]
    if (want) {
      const got = createHash('sha256').update(new Uint8Array(await Bun.file(dest).arrayBuffer())).digest('hex')
      if (got !== want) { await rm(dest, { force: true }); throw new Error(`sha256 mismatch (got ${got})`) }
      log(`tunnel: cloudflared ${CF_VERSION} installed (sha256 verified)`)
    } else {
      const v = await new Response(spawn([dest, '--version']).stdout).text()
      if (!v.includes(CF_VERSION)) log(`tunnel: WARNING cloudflared --version unexpected: ${v.trim()}`)
      else log(`tunnel: cloudflared ${CF_VERSION} installed (version-checked)`)
    }
    return dest
  } catch (e) {
    log(`tunnel: cloudflared fetch failed (${(e as Error).message}) — install it or set WEBAPP_PUBLIC_URL`)
    return null
  }
}

export interface Tunnel { url(): string | null; stop(): void }

// Spawn cloudflared, stream-scan its output for the trycloudflare URL, and relaunch on exit. `onUrl`
// fires whenever the public URL (re)appears so the daemon can refresh any launch buttons.
export function startTunnel(opts: {
  port: number; bin: string; log: (m: string) => void; onUrl?: (u: string) => void
}): Tunnel {
  let url: string | null = null
  let proc: Subprocess | null = null
  let stopped = false

  const scan = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return
    const dec = new TextDecoder()
    for await (const chunk of stream) {
      const found = parseTunnelUrl(dec.decode(chunk))
      if (found && found !== url) { url = found; opts.log(`tunnel: up at ${url}`); opts.onUrl?.(url) }
    }
  }

  const launch = () => {
    proc = spawn([opts.bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${opts.port}`],
      { stdout: 'pipe', stderr: 'pipe' })
    void scan(proc.stdout as ReadableStream<Uint8Array>)
    void scan(proc.stderr as ReadableStream<Uint8Array>)
    void proc.exited.then(code => {
      if (stopped) return
      opts.log(`tunnel: cloudflared exited (code ${code}); relaunching in 2s`)
      url = null
      setTimeout(launch, 2000)
    })
  }
  launch()
  return { url: () => url, stop: () => { stopped = true; try { proc?.kill() } catch {} } }
}
