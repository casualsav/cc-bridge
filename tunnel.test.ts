// Tests for cloudflared URL parsing + binary discovery. Run: bun test tunnel.test.ts
import { test, expect } from 'bun:test'
import { parseTunnelUrl, findCloudflared, cfAsset, cfVersionAtLeast, parseCfVersion } from './tunnel.ts'

test('parses the trycloudflare URL out of cloudflared’s boxed banner', () => {
  const banner = [
    '2026-06-15T07:00:00Z INF +----------------------------------------------------------+',
    '2026-06-15T07:00:00Z INF |  Your quick Tunnel has been created! Visit it at:         |',
    '2026-06-15T07:00:00Z INF |  https://random-three-word-name.trycloudflare.com         |',
    '2026-06-15T07:00:00Z INF +----------------------------------------------------------+',
  ].join('\n')
  expect(parseTunnelUrl(banner)).toBe('https://random-three-word-name.trycloudflare.com')
})

test('ignores api.trycloudflare.com (the startup API host, not the tunnel) and unrelated URLs', () => {
  expect(parseTunnelUrl('INF Requesting new quick Tunnel on https://api.trycloudflare.com/tunnel ...')).toBeNull()
  expect(parseTunnelUrl('connecting to https://example.com and 1.2.3.4')).toBeNull()
  expect(parseTunnelUrl('')).toBeNull()
})

test('still parses the real URL even if the api host appears in the same buffer', () => {
  const mixed = 'INF ...api.trycloudflare.com... \nINF |  https://blue-cat-runs-fast.trycloudflare.com  |'
  expect(parseTunnelUrl(mixed)).toBe('https://blue-cat-runs-fast.trycloudflare.com')
})

test('findCloudflared returns null when absent and honors an explicit existing path', () => {
  const noPath = () => null   // stub the PATH probe so the test is hermetic on hosts that have cloudflared installed
  expect(findCloudflared('/nonexistent-state-dir', undefined, noPath)).toBeNull()
  expect(findCloudflared('/nonexistent-state-dir', '/definitely/not/here', noPath)).toBeNull()
  expect(findCloudflared('/tmp', '/bin/sh')).toBe('/bin/sh')   // explicit existing path wins before the PATH probe
})

test('cfAsset maps platform/arch to the right release asset', () => {
  expect(cfAsset('linux', 'arm64')).toEqual({ name: 'cloudflared-linux-arm64', key: 'linux-arm64', tgz: false })
  expect(cfAsset('linux', 'x64')).toEqual({ name: 'cloudflared-linux-amd64', key: 'linux-amd64', tgz: false })
  expect(cfAsset('darwin', 'arm64')).toEqual({ name: 'cloudflared-darwin-arm64.tgz', key: 'darwin-arm64', tgz: true })
  expect(cfAsset('win32', 'x64')).toEqual({ name: 'cloudflared-windows-amd64.exe', key: 'windows-amd64', tgz: false })
  expect(cfAsset('freebsd', 'x64')).toBeNull()
})

// The pin is also the floor. These pin the comparator, because the bug it fixes was invisible for
// months: a system cloudflared 2026.3.0 shadowed a pinned 2026.6.0 and nothing ever said so.
test('cfVersionAtLeast accepts at-or-above the floor and rejects below it', () => {
  const banner = (v: string) => `cloudflared version ${v} (built 2026-03-09-14:08 UTC)`
  expect(cfVersionAtLeast(banner('2026.6.0'), '2026.6.0')).toBe(true)    // equal meets the floor
  expect(cfVersionAtLeast(banner('2026.7.3'), '2026.6.0')).toBe(true)
  expect(cfVersionAtLeast(banner('2027.1.0'), '2026.6.0')).toBe(true)
  expect(cfVersionAtLeast(banner('2026.6.1'), '2026.6.0')).toBe(true)
  expect(cfVersionAtLeast(banner('2026.3.0'), '2026.6.0')).toBe(false)   // the binary on this box
  expect(cfVersionAtLeast(banner('2025.12.9'), '2026.6.0')).toBe(false)
  expect(cfVersionAtLeast(banner('2026.5.99'), '2026.6.0')).toBe(false)
  // The comparison must be NUMERIC. cloudflared's middle component is a month, so it crosses 9→10
  // every year, and a string compare puts "2026.10.0" BELOW "2026.6.0" — which would re-download the
  // pin over a newer binary forever, silently, the mirror image of the bug this floor fixes.
  expect(cfVersionAtLeast(banner('2026.10.0'), '2026.6.0')).toBe(true)
  expect(cfVersionAtLeast(banner('2026.6.10'), '2026.6.9')).toBe(true)
  expect(cfVersionAtLeast(banner('2026.6.0'), '2026.10.0')).toBe(false)
})

// Unparseable must read as BELOW the floor: fetching a build we know is the safe direction, and the
// fetch-failure fallback still uses the odd binary rather than leaving the user with no tunnel.
test('an unreadable version is treated as below the floor, never as passing', () => {
  expect(cfVersionAtLeast(null, '2026.6.0')).toBe(false)
  expect(cfVersionAtLeast('', '2026.6.0')).toBe(false)
  expect(cfVersionAtLeast('cloudflared version unknown', '2026.6.0')).toBe(false)
  expect(cfVersionAtLeast('not a version at all', '2026.6.0')).toBe(false)
})

test('parseCfVersion pulls the triple out of the real --version banner', () => {
  expect(parseCfVersion('cloudflared version 2026.3.0 (built 2026-03-09-14:08 UTC)')).toEqual([2026, 3, 0])
  expect(parseCfVersion('2026.6.0')).toEqual([2026, 6, 0])
  expect(parseCfVersion('no digits here')).toBeNull()
  expect(parseCfVersion(null)).toBeNull()
})
