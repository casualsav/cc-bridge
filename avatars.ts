// Send-only bot avatars (party-bus P3) — the PURE half: parse the avatars config into a
// name→token map and resolve an endpoint to its avatar. No fs/path/grammy here (AVATARS_FILE + the
// disk read live in the daemon), so it's unit-testable in isolation like party.ts. An "avatar" is an
// extra @BotFather bot token the daemon uses ONLY to send an agent's `tg post` under that bot's own
// name+picture — it never polls getUpdates, so it needs no token-lock and spawns no second daemon.
//
// Setup (per avatar): create a bot via @BotFather, ADD IT TO THE GROUP, then map the endpoint name to
// its token in ~/.claude/channels/telegram/avatars.json (mode 0600 — it holds secrets):
//   { "analysis": { "token": "123456:ABC-…" }, "executor": { "token": "789:…" } }
import { normalizeEndpointName } from './party.ts'

// The bot's OWN @BotFather name + picture ARE the shown identity, so no display name is configured.
export type Avatar = { token: string }

// Parse the raw avatars.json blob → normalized-endpoint-name → Avatar. Keyed by the SAME
// normalizeEndpointName the bus uses, so a post from "Analysis · main" finds avatar "analysis". Drops
// entries without a non-empty string token; on a DUPLICATE normalized name the FIRST wins (later dupes
// dropped) so the mapping is deterministic, never last-write-wins. Non-object input → empty map.
export function parseAvatars(raw: unknown): Map<string, Avatar> {
  const out = new Map<string, Avatar>()
  if (!raw || typeof raw !== 'object') return out
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const token = (v as { token?: unknown } | null)?.token
    if (typeof token !== 'string' || !token.trim()) continue
    const name = normalizeEndpointName(key)
    if (!name || out.has(name)) continue   // first-wins on a normalized-name collision
    out.set(name, { token: token.trim() })
  }
  return out
}

// The avatar for an endpoint (a display name or raw id), or null → the caller sends via the shared
// bridge bot. Normalizes the name the same way parseAvatars keyed the map.
export function resolveAvatar(name: string, avatars: Map<string, Avatar>): Avatar | null {
  return avatars.get(normalizeEndpointName(name)) ?? null
}
