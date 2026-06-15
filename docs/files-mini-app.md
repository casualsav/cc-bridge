# Spec: Files Mini App (browse · find · edit from Telegram)

Status: **proposal / plan** (branch `feat/files-mini-app`). Not yet implemented.

## 1. Goal
Give a paired user a real **filesystem explorer + editor** from Telegram: browse any directory
the session can reach (rooted at the session's repo cwd, navigable to the whole FS), **find** files,
**view/preview/download** them, and **edit** them. Delivered as a **Telegram Mini App** (Web App) —
an in-Telegram HTML/JS UI — rather than inline-keyboard button grids, because a tree view + a real
code editor (cursor, syntax highlighting, in-place edits, search) is dramatically better for this than
tap-menus.

The daemon is the perfect backend: it is a long-lived process that already has full FS access (the
same access the `--dangerously-skip-permissions` sessions have). The Mini App itself cannot touch the
filesystem — per Telegram's model it only talks to **our** backend — so all FS work stays in the daemon.

## 2. Why Mini App over inline keyboards / Rich Messages
- **Inline keyboards**: zero infra, but clunky — pagination, 64-byte callback-data limits, no real
  editor. Kept as the **no-infra baseline** (see Phase 0), not the primary path.
- **Rich Messages** (Bot API 10.1, 2026-06-11: `sendRichMessage` / `sendRichMessageDraft`): better
  *display* (collapsible blocks, tables, streaming) but not interactive nav/edit, renders only on
  updated clients, and post-dates our pinned grammy (1.41.1). Use later to prettify chat-side previews.
- **Mini App** (Bot API 6.0+ for `web_app` buttons; storage/fullscreen extras in 8.0/9.0): full custom
  UI. The right tool for browse + find + edit.

## 3. Architecture
```
Telegram client ──(opens web_app button URL)──▶ Mini App SPA (static HTML/JS/CSS)
        ▲                                              │
        │ initData (HMAC-signed with bot token)        │ fetch /api/* with initData header
        │                                              ▼
   grammy bot  ◀──────────────  Bun.serve HTTP server (in the daemon process)
   (existing)                    ├─ serves the static SPA bundle
                                 └─ JSON file API (ls/read/write/find/download)
                                          │ validates initData → allowlist
                                          ▼
                                   local filesystem
        ▲
        │ public HTTPS URL required by Telegram for web_app
   cloudflared quick-tunnel (bundled, zero-config, ephemeral URL)  ── or ──  user domain/reverse-proxy
```
- **New module `webapp.ts`** — `Bun.serve` HTTP server: static bundle + `/api/*` handlers + initData
  auth. Started by the daemon only when enabled.
- **Tunnel** (`webapp.ts` or `tunnel.ts`) — spawn/track `cloudflared tunnel --url http://127.0.0.1:<port>`,
  parse the assigned `https://*.trycloudflare.com` URL, expose it to the daemon. Quick-tunnel URLs are
  ephemeral, so the daemon injects the **current** URL into the `web_app` button at send time (and/or
  `setChatMenuButton`) rather than persisting it.
- **Launch** — a `/files` command posts a message with an inline `web_app` button (and/or set the chat
  **menu button**) opening the SPA. The session's starting cwd is passed via the `startapp`/URL param;
  it is re-validated server-side from the topic→session→cwd mapping, never trusted from the client.
- **Frontend** — small static SPA: file tree (left) + editor/preview (right) + search box. Editor:
  **CodeMirror 6** (lightweight, mobile-friendly, syntax highlighting). Theme synced to Telegram via
  `Telegram.WebApp.themeParams`. Shipped as a prebuilt bundle (no runtime build step).

## 4. Auth (this is a file read/write API over a public URL — treat as security-critical)
- On launch Telegram provides `initData`, HMAC-SHA256 signed with the **bot token**. The SPA sends it
  on every API call (e.g. `Authorization: tma <initData>`).
- The daemon validates each request: recompute the HMAC over the sorted data-check-string, compare to
  `hash`; reject if mismatched or `auth_date` is stale (> N minutes). Extract `user.id` and **require it
  in `loadAccess().allowFrom`** — the same gate as every other bridge action. (Group/topic mode: also
  confirm membership/policy.)
- Defense in depth: bind `Bun.serve` to `127.0.0.1` and reach it only through the tunnel; rate-limit
  writes; **audit every write to `daemon.log`** (path, user, bytes); resolve real paths and reject
  traversal/symlink escapes beyond an allowed root set; optional sensitive-path denylist
  (`~/.ssh`, `*.env`, credential files) — though note the session can already read those, so this is
  belt-and-suspenders, default off with a warning.
- The bot token is the HMAC key and is already secret — never log it; never expose it to the SPA.

## 5. Daemon file API (v1)
All endpoints require valid initData; all resolve+canonicalize paths and refuse escapes.
- `GET  /api/ls?path=…` → `{ path, parent, entries:[{name,type:"dir|file|symlink",size,mtime}] }` (dirs first).
- `GET  /api/read?path=…` → `{ path, size, mtime, encoding, truncated, content }` for text; binary/large → metadata + `downloadUrl`.
- `GET  /api/download?path=…` → raw bytes, `Content-Disposition: attachment`.
- `POST /api/write` `{ path, content, expectedMtime }` → optimistic-concurrency check vs `expectedMtime`;
  writes a `.bak` first; returns `{ mtime, size }`. 409 on mtime mismatch (file changed under you).
- `GET  /api/find?root=…&q=…&max=…` → `{ matches:[path…] }` (name/glob match, capped; skips `.git`,
  `node_modules` by default with a toggle).
- Out of v1 (later, guarded): `mkdir`, `rename`, `delete`.

## 6. Config (opt-in; off by default)
In `~/.claude/channels/telegram/.env` / `access.json`:
- `WEBAPP_ENABLED=true|false` (default false — adds a network surface, so explicit opt-in).
- `WEBAPP_TUNNEL=cloudflared|none` (cloudflared = zero-config; none = use a provided URL).
- `WEBAPP_PUBLIC_URL=https://…` (stable domain / named tunnel; overrides cloudflared).
- `WEBAPP_PORT=…` (localhost bind port; default e.g. 8787).
- `WEBAPP_WRITE=true|false` (allow edits; default false → read-only explorer until enabled).

## 7. Phasing
- **Phase 0 — inline baseline (independent, no infra):** the inline-keyboard `/files` explorer already
  mocked (browse · preview · download · find). Ships to everyone; survives where no HTTPS endpoint exists.
- **Phase 1 — Mini App read-only:** `webapp.ts` server + `/api/ls|read|download|find` + initData auth +
  static SPA (tree + view/preview/download) + cloudflared option + `/files` launch button. `WEBAPP_WRITE` off.
- **Phase 2 — editing:** `/api/write` (backup + optimistic concurrency) + CodeMirror editing + save/undo.
- **Phase 3 — polish:** in-app search UX, Rich-Message chat previews, guarded `mkdir`/`rename`/`delete`,
  stable named-tunnel docs.

## 8. Dependencies & unknowns
- **cloudflared**: bundle the binary vs require the user to install it? Quick tunnels need no account but
  give an ephemeral URL (handled by injecting the live URL into buttons). Decide bundling + platform matrix.
- **grammy 1.41.1**: `web_app` inline buttons + `setChatMenuButton` are old (Bot API 6.0) → supported.
  Rich Messages are not (out of v1).
- **CodeMirror 6** bundle size + mobile ergonomics (tree + editor on a phone). Prebuild + vendor the bundle.
- **Deploy loop**: a static SPA bundle + `webapp.ts` are new tracked files synced to the cache; the
  type-check (`bun build daemon.ts`) must include `webapp.ts`; the cache needs the bundle present.
- **Multi-instance**: each bridge instance needs its own port + tunnel (mirror the `@tg_bridge` instance id).

## 9. Open questions (for the human)
1. **Tunnel**: bundle `cloudflared` (zero-config, ephemeral URL) or require a stable domain/reverse-proxy?
2. **Editing default**: direct in-app write (natural in a Mini App) vs route edits through Claude ("ask
   the session to edit")? Could offer both — a "Save" and an "Ask Claude" action.
3. **Sensitive-path guard**: hard-block anything (`~/.ssh`, `*.env`)? The session already has access, so
   default is no block + an audit log — confirm.
4. **Baseline**: ship Phase 0 (inline explorer) now regardless, as the no-infra fallback? (Recommended.)
