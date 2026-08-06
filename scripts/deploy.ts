#!/usr/bin/env bun
// One-shot deploy: bump version → sync the checkout into the plugin cache + marketplace mirror →
// type-check in the cache → restart the live daemon → verify it came up on the new code.
//
// Why this exists: the live daemon runs from ~/.claude/plugins/cache, NOT this checkout, and the
// cache is keyed by the version string. Shipping code without bumping `version` in BOTH
// .claude-plugin/plugin.json and marketplace.json leaves every install running its cached old
// build forever (Claude Code sees "version already installed" and never re-copies). This script
// makes that ritual atomic and unforgettable.
//
//   bun run deploy            # bump patch (0.0.56 → 0.0.57), sync, type-check, restart
//   bun run deploy minor      # 0.0.56 → 0.1.0
//   bun run deploy major      # 0.0.56 → 1.0.0
//   bun run deploy 0.1.2      # set an explicit version
//   bun run deploy --no-restart            # ship to cache but leave the running daemon alone
//   bun run deploy --commit "msg"          # also commit (version files only) + push after a clean deploy
//   bun run deploy --dry-run               # print the plan (files, version bump, cache path) and exit
//   bun run deploy --with daemon.ts …      # ship YOUR uncommitted edit to that file (repeatable)
//   bun run deploy --without webapp/index.html …   # a dirty file you are NOT releasing: ships as committed
//
// WHERE THE BYTES COME FROM: a commit, not the tree — see payload-provenance.ts. A tracked file that is
// dirty and unnamed refuses the deploy instead of riding along, because this checkout is shared and one
// session's release used to carry another's mid-task edits. `--with <path>` claims a file as yours.
//
// Multi-plugin (multi-channel.md P4): one repo, three plugins in one marketplace.json —
//   bun run deploy                         # = --plugin tg (default, byte-identical to before)
//   bun run deploy --plugin slack [bump]   # assemble + ship the Slack plugin cache
//   bun run deploy --plugin discord [bump] # assemble + ship the Discord plugin cache
//   bun run deploy --plugin slack --materialize   # regenerate the committed plugin dir only (no ship)
// The tg payload is the whole git checkout (source "./"); slack/discord payloads are the platform
// files + the neutral core modules they import (a hardcoded closure — see PLUGINS below) plus the
// plugin's own manifest dir. Slack/discord deploys NEVER touch the Telegram daemon.
//
// Type-check runs against the cache copy BEFORE the checkout's version files are touched, so a
// failed build never mutates your working tree.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { shipGate } from '../ship-gate.ts'
import { strandedVersion } from '../stranded-version.ts'
import { provenanceGate, dirtyPayloadPaths, materializePayload } from '../payload-provenance.ts'
import { syncConventionBlock } from '../installed-copies.ts'
import { stopSupervisors, healthCheck, rollback, markHealthy, stampGitref, pruneOldVersions } from '../upgrade-core.ts'

// PLUGIN-DIR CONTENTS ARE DEPLOY-GENERATED. The shared runtime lives at the repo ROOT (channel.ts,
// slack-daemon.ts, common.ts, channel-ctl.ts, the slk/dsc ctls, …) — that is the single source of
// truth. Claude Code installs a plugin by copying ONLY its marketplace `source` subtree into the
// cache (verified: tg source "./" → full cache; a subdir source → just that subdir), so each
// non-tg plugin dir (plugins/claude-slack, plugins/claude-discord) must be SELF-CONTAINED in git.
// A slack/discord deploy (and `--materialize`) therefore copies that plugin's full runtime closure
// + a pinned package.json stub into its plugin dir as REAL files (never symlinks — install copy
// semantics for symlinks are unverified) and commits them. Edit the root files, not these copies;
// every deploy regenerates them.

const GRAMMY_PIN = '1.41.1' // keep in sync with package.json + ensure-daemon.ts

const REPO = dirname(import.meta.dir) // scripts/ → repo root
// Marketplace id (also the plugin-cache parent dir name); the marketplace.json is SHARED by all
// three plugins, each an entry keyed by its plugin `name`.
const MKT_ID = 'cc-bridge'
const CACHE_ROOT = join(homedir(), '.claude', 'plugins', 'cache', MKT_ID)
const MKT = join(homedir(), '.claude', 'plugins', 'marketplaces', MKT_ID)
// The shared marketplace manifest lives at the repo-root .claude-plugin — one file, all plugins.
const MARKET_JSON = join('.claude-plugin', 'marketplace.json')

function die(msg: string): never { console.error(`\n✗ ${msg}`); process.exit(1) }
function step(msg: string) { console.log(`• ${msg}`) }

// spawnSync, normalized so a failed spawn can't crash a caller. On ENOENT (command not found, e.g.
// `bunx` absent) or a signal kill, raw spawnSync returns a null status AND null stdout/stderr — so any
// `.slice`/`.split`/`.trim` on its output throws a bare TypeError instead of failing usefully. Here that
// becomes a nonzero status with the spawn error surfaced as stderr, making every call site below safe
// and every `die()` message real.
function sh(cmd: string, args: string[], cwd?: string, env?: Record<string, string>): { status: number; stdout: string; stderr: string } {
  // 64 MiB, because the default is 1 MiB and `bun build` prints the WHOLE bundle to stdout — which
  // crossed 1 MiB at v0.4.100 (1,064,568 bytes). spawnSync SIGTERMs a child that overruns maxBuffer,
  // so the type-check gate below started reporting "type-check failed" while printing a complete,
  // correct bundle and an empty stderr: a growing daemon.ts silently became an unshippable one.
  // Bounded rather than Infinity — this box is memory-tight and a runaway command should still stop.
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) })
  const stdout = r.stdout ?? ''
  // Name the signal when there is one: a signal-killed child otherwise reports an empty stderr, and
  // every die() below prefers stderr — which is how the maxBuffer kill above read as a build error.
  const killed = r.status === null && r.signal ? `${cmd}: killed by ${r.signal}` : ''
  const stderr = [killed, r.stderr ?? (r.error ? `${cmd}: ${r.error.message}` : '')].filter(Boolean).join('\n')
  const status = r.status ?? (r.error ? 127 : 1)   // null status ⇒ spawn failed / signal-killed ⇒ treat as failure
  return { status, stdout, stderr }
}

// `origin` (casualsav/cc-bridge) is the single source of truth AND the marketplace end-user installs
// pull from — so a plain `git push` to origin both ships the code and releases it. No mirror/dual-push.

// ---- per-plugin config -------------------------------------------------------------------------
// Each plugin ships from the SAME marketplace.json but with its own version, cache dir, payload,
// and daemon deps. `cacheName` is the dir under cache/cc-bridge/<cacheName> (= the plugin `name`).
// `pluginJson` is the manifest whose version we bump alongside this plugin's marketplace entry.
// A payload file, addressed two ways: `cacheDest` is its FLAT position in the plugin cache (where
// the daemon imports it as a sibling — e.g. `slack-daemon.ts` and `channel.ts` side by side);
// `repoDest` (= its path relative to REPO) is where it lives in the git tree / marketplace mirror.
// For tg the two coincide (source "./" is already flat); for slack/discord the manifest under
// plugins/claude-<p>/ flattens into the cache but keeps its repo path in the mirror.
// `srcRel` is repo-relative, NOT an absolute path: the bytes are read from the materialized payload
// root (a commit's tree + the files `--with` claimed), which is not the checkout — see srcOf below and
// payload-provenance.ts for why a deploy must not read the working tree directly.
type Payload = { srcRel: string; cacheDest: string; repoDest: string }
type PluginCfg = {
  id: string
  mktName: string                       // this plugin's `name` in marketplace.json
  cacheName: string                     // cache/cc-bridge/<cacheName>/<ver>
  pluginJson: string                    // repo-relative plugin.json to version-bump
  pluginDir?: string                    // repo-relative plugin dir (slack/discord); tg ships "./"
  rootFiles?: string[]                  // runtime closure materialized into pluginDir (slack/discord)
  daemonEntry: string                   // entrypoint for the `bun build` cache gate
  deps: Record<string, string>          // package.json deps seeded into the cache
  pkgName: string                       // package.json name for the seeded manifest
  restartTelegram: boolean              // restart the live telegram daemon after ship (tg only)
  payload: () => Payload[]              // the exact files that ship, resolved at run time
}

// Neutral core modules shared by the non-telegram daemons (multi-channel.md: "live at repo ROOT").
// Slack/discord closures = these + the platform files + the platform's ctl entry, derived from the
// daemon AND ctl import graphs. Keep in sync if the imports change.
//
// The gate that actually enforces this is `plugin-closure.test.ts`, NOT the `bun build <daemon>`
// cache gate below — this comment used to claim the build gate catches a missing module, and it does
// not: `bun build` ERASES type-only imports. `agent-transcript.ts`'s `import type { AgentKind } from
// './agent.ts'` therefore shipped with agent.ts absent from both plugin dirs, building and running
// clean while `tsc --noEmit` failed. The test walks what the committed dirs really import.
const CORE = [
  'channel.ts', 'common.ts', 'channel-ctl.ts', 'pane-io.ts', 'proc.ts', 'prompt.ts',
  'transcript.ts', 'codex-transcript.ts', 'agent-transcript.ts', 'agent.ts',
]
const SLACK_ROOT_FILES = [...CORE,
  'slack-adapter.ts', 'slack-render.ts', 'slack-daemon.ts', 'slack-paths.ts', 'slk-ctl.ts', 'ensure-slack-daemon.ts']
const DISCORD_ROOT_FILES = [...CORE,
  'discord-adapter.ts', 'discord-render.ts', 'discord-daemon.ts', 'discord-paths.ts', 'dsc-ctl.ts', 'ensure-discord-daemon.ts']

// Hand-authored manifest files that live in a plugin dir (everything else there is deploy-generated).
const MANIFEST_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'INSTALL.md', 'README.md']

// Read a dependency's exact/range spec from the root package.json so cache deps stay pinned to it.
function depFromRoot(name: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    const v = pkg.dependencies?.[name]
    if (v) return v
  } catch {}
  die(`couldn't read "${name}" version from package.json`)
}

// A root file (channel.ts, slack-daemon.ts, …) sits at the same path in cache and repo.
function rootPayload(rel: string): Payload {
  return { srcRel: rel, cacheDest: rel, repoDest: rel }
}

// A self-contained channel plugin's payload: the runtime closure (source of truth at repo root,
// but shipped flat into the plugin dir + cache) plus the hand-authored manifest. `cacheDest` is the
// file's position in the flat cache; `repoDest` is its committed home under the plugin dir.
function channelPayload(pluginDir: string, rootFiles: string[]): Payload[] {
  return [
    ...rootFiles.map(f => ({ srcRel: f, cacheDest: f, repoDest: join(pluginDir, f) })),
    ...MANIFEST_FILES.map(f => ({ srcRel: join(pluginDir, f), cacheDest: f, repoDest: join(pluginDir, f) })),
  ]
}

const SLACK_DIR = join('plugins', 'claude-slack')
const DISCORD_DIR = join('plugins', 'claude-discord')

const PLUGINS: Record<string, PluginCfg> = {
  tg: {
    id: 'tg', mktName: 'telegram', cacheName: 'telegram',
    pluginJson: join('.claude-plugin', 'plugin.json'),
    daemonEntry: 'daemon.ts', pkgName: 'claude-channel-telegram-daemon',
    deps: { grammy: GRAMMY_PIN, '@modelcontextprotocol/sdk': '^1.0.0', zod: '~4.3.6' },
    restartTelegram: true,
    // tg ships the whole git-tracked checkout (source "./"), exactly as before.
    payload: () => {
      const lsf = sh('git', ['ls-files', '-z'], REPO)
      if (lsf.status !== 0) die(`git ls-files failed: ${lsf.stderr}`)
      return lsf.stdout.split('\0').filter(Boolean).map(rootPayload)
    },
  },
  slack: {
    id: 'slack', mktName: 'slack', cacheName: 'slack',
    pluginJson: join(SLACK_DIR, '.claude-plugin', 'plugin.json'),
    pluginDir: SLACK_DIR, rootFiles: SLACK_ROOT_FILES,
    daemonEntry: 'slack-daemon.ts', pkgName: 'claude-channel-slack-daemon',
    deps: { '@slack/bolt': depFromRoot('@slack/bolt') },
    restartTelegram: false,
    payload: () => channelPayload(SLACK_DIR, SLACK_ROOT_FILES),
  },
  discord: {
    id: 'discord', mktName: 'discord', cacheName: 'discord',
    pluginJson: join(DISCORD_DIR, '.claude-plugin', 'plugin.json'),
    pluginDir: DISCORD_DIR, rootFiles: DISCORD_ROOT_FILES,
    daemonEntry: 'discord-daemon.ts', pkgName: 'claude-channel-discord-daemon',
    deps: { 'discord.js': depFromRoot('discord.js') },
    restartTelegram: false,
    payload: () => channelPayload(DISCORD_DIR, DISCORD_ROOT_FILES),
  },
}

// ---- args ----
const argv = process.argv.slice(2)
const noRestart = argv.includes('--no-restart')
const dryRun = argv.includes('--dry-run')
const materializeOnly = argv.includes('--materialize')
const pluginIdx = argv.indexOf('--plugin')
const pluginArg = pluginIdx >= 0 ? argv[pluginIdx + 1] : 'tg'
const cfg = PLUGINS[pluginArg]
if (!cfg) die(`unknown --plugin "${pluginArg}" — use tg | slack | discord`)
const commitIdx = argv.indexOf('--commit')
const commitMsg = commitIdx >= 0 ? argv[commitIdx + 1] : null
if (commitIdx >= 0 && !commitMsg) die('--commit needs a message: --commit "ui: …"')
const shipIdx = argv.indexOf('--ship-branch')
// `--with <path>`, repeatable: the files whose UNCOMMITTED bytes this deploy claims as its own (see
// the provenance gate below). Parsed here with the other flags because its values must be excluded
// from the bump scan — the file already learned that lesson once with --ship-branch.
// `--with <path>` claims a dirty file as YOURS (its tree bytes ship — the staging gate);
// `--without <path>` acknowledges one you are NOT releasing (a sibling's WIP: it ships as committed and
// its edits are left alone). Every dirty payload file must be one or the other. Repeatable, and parsed
// here with the other flags because their values must be excluded from the bump scan.
const flagPaths = (flag: string): { idxs: number[]; paths: string[] } => {
  const idxs = argv.reduce<number[]>((a, v, i) => (v === flag ? [...a, i] : a), [])
  const paths = idxs.map(i => argv[i + 1]).filter((v): v is string => !!v && !v.startsWith('--'))
  if (idxs.length !== paths.length) die(`${flag} needs a repo-relative path: ${flag} daemon.ts`)
  return { idxs, paths }
}
const withArg = flagPaths('--with')
const withoutArg = flagPaths('--without')
const named = withArg.paths
const excluded = withoutArg.paths
const valueIdxs = new Set([...withArg.idxs, ...withoutArg.idxs])
const both = named.filter(n => excluded.includes(n))
if (both.length) die(`a path cannot be both claimed and excluded: ${both.join(', ')}`)
// Every flag that takes a value must exclude that value here, or it is read as the bump: the first
// spelling of this gate had `--ship-branch tg/foo` die with `unknown bump "tg/foo"`.
const bumpArg = argv.find((a, i) =>
  !a.startsWith('--') && a !== commitMsg
  && !(pluginIdx >= 0 && i === pluginIdx + 1)
  && !(shipIdx >= 0 && i === shipIdx + 1)
  && !valueIdxs.has(i - 1)) ?? 'patch'

const CACHE_BASE = join(CACHE_ROOT, cfg.cacheName)
// Every path derives from homedir(), which is what makes a sandboxed run (HOME=/tmp/…) reach only
// sandbox state — verified live on 2026-08-06 by a --dry-run under a sandbox HOME.
//
// EXCEPT THIS ONE, and that exception drew blood. `TELEGRAM_STATE_DIR` is exported into every bridged
// session, so it is INHERITED by a deploy run under a sandbox $HOME — on 2026-08-06 a sandbox deploy
// shipped into /tmp/dh-sbx's cache while stopping, unlinking and health-checking PRODUCTION's state
// dir, and took the fleet's socket with it. An env var that points outside this $HOME is never what
// the caller meant; refuse rather than operate on two different installs at once.
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
if (!STATE_DIR.startsWith(homedir())) {
  die(`TELEGRAM_STATE_DIR (${STATE_DIR}) is outside HOME (${homedir()}).\n` +
      `  A deploy would ship into one install's cache and restart another's daemon.\n` +
      `  Unset it, or point it inside this HOME: env -u TELEGRAM_STATE_DIR bun run deploy`)
}
const DAEMON_PID = join(STATE_DIR, 'daemon.pid')
const DAEMON_LOG = join(STATE_DIR, 'daemon.log')
const SOCKET = join(STATE_DIR, 'daemon.sock')
const PLUGIN_JSON = cfg.pluginJson

// ---- compute the new version (from this plugin's plugin.json) ----
const VERSION_RE = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/
const pluginSrc = readFileSync(join(REPO, PLUGIN_JSON), 'utf8')
const curMatch = pluginSrc.match(VERSION_RE)
if (!curMatch) die(`couldn't find a version in ${PLUGIN_JSON}`)
const cur = curMatch[2]

function nextVersion(from: string, kind: string): string {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const [maj, min, pat] = from.split('.').map(Number)
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`
  die(`unknown bump "${kind}" — use patch | minor | major | x.y.z`)
}
const next = nextVersion(cur, bumpArg)
console.log(`\n🚀 deploy [${cfg.id}] ${cur} → ${next}\n`)

const payload = cfg.payload()

// ---- shipping gate: main only, and say what you're shipping ----
// A deploy ships a COMMIT into the plugin cache and restarts the live daemon (which commit: the
// provenance gate below). Nothing here previously looked at which branch that commit was on, so a
// session working on its own branch — the normal shape once sessions get worktrees — could
// ship unreviewed branch code over the live bridge and only find out afterwards. The failure is
// silent and it lands on the owner's own comms channel, so the default has to be refusal.
//
// The escape hatch deliberately is NOT a bare --force: you must NAME the branch, and it must match
// what you are actually on. A habitual flag is a flag people type without reading; a branch name is
// one you have to look up, which is the whole point.
function gitOut(args: string[]): string {
  const r = sh('git', ['-C', REPO, ...args])
  return r.status === 0 ? r.stdout.trim() : ''
}
// ---- stranded-version gate: a PREVIOUS deploy's bumps were never committed ----
// Runs before this deploy writes its own bump, so it reads the previous one's leftovers rather than
// its own work. See stranded-version.ts for why this refuses instead of committing: the strand
// happens at the `git add` after a deploy, which this script is not present for, so the next deploy is
// the first moment it can be seen — one deploy late, but before the release that would bake it in.
// Held to --dry-run too, for the reason the provenance gate is: a preview that says "fine" for a
// deploy that would refuse is a lie.
if (!materializeOnly) {
  for (const vf of [PLUGIN_JSON, MARKET_JSON]) {
    const headSrc = gitOut(['show', `HEAD:${vf}`])
    // The marketplace holds every plugin's version, so read the one for THIS plugin's entry by name;
    // plugin.json has a single version. A file git cannot show (new, or no repo) yields '' → null → pass.
    const pick = (src: string): string | null => {
      if (!src) return null
      if (vf !== MARKET_JSON) return src.match(VERSION_RE)?.[2] ?? null
      const entry = src.split(/\{/).find(chunk => chunk.includes(`"name": "${cfg.mktName}"`))
      return entry?.match(VERSION_RE)?.[2] ?? null
    }
    const treeV = pick(readFileSync(join(REPO, vf), 'utf8'))
    const gate = strandedVersion(vf, treeV, pick(headSrc), named.includes(vf))
    if (!gate.ok) die(gate.error)
  }
}

if (!materializeOnly && !dryRun) {
  const gate = shipGate(
    gitOut(['rev-parse', '--abbrev-ref', 'HEAD']),
    shipIdx >= 0 ? (argv[shipIdx + 1] ?? '') : null,
  )
  if (!gate.ok) die(gate.error)
  if (gate.warn) console.log(`⚠️  ${gate.warn}\n`)

}

// ---- provenance gate: the bytes come from a COMMIT, and dirt is claimed by name ----
// Deliberately OUTSIDE the branch gate above, so `--dry-run` and `--materialize` are held to it too: a
// preview that says "fine" for a deploy that would refuse is a lie, and --materialize writes into the
// checkout, where provenance matters just as much as it does in a release.
//
// This used to be a printed WARNING, with a comment explaining that refusing on dirt would block every
// legitimate deploy — true of refusing on dirt, and the reason the payload now comes from the commit
// instead: a dirty file you have not claimed simply ships as its committed version, and only the
// AMBIGUITY (dirty, unclaimed, therefore possibly a sibling's) is refused. See payload-provenance.ts.
// The ref whose tree we ship. `--ship-branch <b>` names it explicitly (the branch gate above has
// already checked you are ON b, so this is HEAD today — spelled out so it stays correct if that
// ever loosens), otherwise HEAD.
const payloadRef = shipIdx >= 0 && argv[shipIdx + 1] ? `refs/heads/${argv[shipIdx + 1]}` : 'HEAD'
// Files the deploy ITSELF dirties, implicitly claimed. Its own version bumps are the whole reason:
// deploy-then-commit is the staging gate here, so the second deploy before a commit finds plugin.json
// and marketplace.json dirty by its own hand, and a gate that refused over that could not run twice.
// A channel plugin's dir is deploy-generated for the same reason.
const deployOwned = [PLUGIN_JSON, MARKET_JSON, ...(cfg.pluginDir ? [cfg.pluginDir] : [])]
const payloadRels = payload.map(p => p.srcRel)
const prov = provenanceGate(dirtyPayloadPaths(REPO, payloadRef, payloadRels), named, excluded, deployOwned, payloadRels)
if (!prov.ok) die(prov.error)
if (prov.claimed.length) {
  console.log(`⚠️  shipping YOUR uncommitted changes in ${prov.claimed.length} claimed file(s):`)
  for (const f of prov.claimed) console.log(`      ${f}`)
  console.log('')
}
// Everything else ships as `payloadRef` has it. The root is deleted on exit, including after a die().
const PAYLOAD_ROOT = materializePayload(REPO, payloadRef, prov.carried)
process.on('exit', () => { try { rmSync(PAYLOAD_ROOT, { recursive: true, force: true }) } catch {} })
function srcOf(p: Payload): string { return join(PAYLOAD_ROOT, p.srcRel) }

// Replace only the version string (regex, not JSON round-trip) so file formatting/escaping is kept.
function patchVersion(path: string, to: string) {
  const src = readFileSync(path, 'utf8')
  if (!VERSION_RE.test(src)) die(`version string not found in ${path}`)
  const out = src.replace(VERSION_RE, `$1${to}$3`)
  if (out !== src) Bun.write(path, out) // already at target after a mirror sync → harmless no-op
}

// The marketplace.json is SHARED — bump ONLY this plugin's entry (scoped to its `name`, which we
// author before `version` in every entry) so a tg deploy can't touch slack's version and vice versa.
function patchMarketVersion(path: string, mktName: string, to: string) {
  const src = readFileSync(path, 'utf8')
  const re = new RegExp(`("name"\\s*:\\s*"${mktName}"[\\s\\S]*?"version"\\s*:\\s*")(\\d+\\.\\d+\\.\\d+)(")`)
  if (!re.test(src)) die(`marketplace entry "${mktName}" version not found in ${path}`)
  const out = src.replace(re, `$1${to}$3`)
  if (out !== src) Bun.write(path, out)
}

// ---- dry-run: print the plan and exit without touching the cache / daemon / checkout ----
if (dryRun) {
  console.log(`  plugin        ${cfg.id}  (marketplace name "${cfg.mktName}")`)
  console.log(`  version       ${cur} → ${next}  (bump: ${bumpArg})`)
  console.log(`  cache path    ${join(CACHE_BASE, next)}`)
  console.log(`  daemon entry  ${cfg.daemonEntry}`)
  console.log(`  cache deps    ${Object.entries(cfg.deps).map(([n, v]) => `${n}@${v}`).join(', ')}`)
  console.log(`  restart tg    ${cfg.restartTelegram ? 'yes' : 'no'}`)
  console.log(`  payload       ${payload.length} files →`)
  let missing = 0
  for (const p of payload) {
    const ok = existsSync(srcOf(p))
    if (!ok) missing++
    console.log(`    ${ok ? ' ' : '✗'} ${p.cacheDest}${ok ? '' : '   (MISSING — not on disk yet)'}`)
  }
  console.log(`\n  (dry-run — nothing written; ${missing} missing file${missing === 1 ? '' : 's'})`)
  process.exit(0)
}

// A real deploy needs every payload file present (a missing module would break the daemon in cache).
for (const p of payload) if (!existsSync(srcOf(p))) die(`payload file missing on disk: ${p.cacheDest} (${srcOf(p)})`)

// Copy the resolved payload into `dest`, keyed by `which` position (flat cache vs repo-layout
// mirror/checkout). Overwrites unconditionally (a cloned/prior dir may already hold the file).
// Skips a file whose destination IS its source — the manifest's repoDest self-copy when
// materializing the plugin dir in the checkout (copyFileSync onto itself would truncate it).
function syncPayloadInto(dest: string, which: 'cacheDest' | 'repoDest') {
  for (const p of payload) {
    const out = join(dest, p[which])
    // Never write a file over its own source in the CHECKOUT. Before the payload came from a commit
    // this was a self-copy guard (copyFileSync onto itself truncates); now it is load-bearing for a
    // different reason — `--materialize` writes at repoDest, and a manifest that lives where it ships
    // would have the commit's bytes restored over an uncommitted edit. Same skip, sharper reason.
    if (resolve(out) === resolve(join(REPO, p.srcRel))) continue
    mkdirSync(dirname(out), { recursive: true })
    copyFileSync(srcOf(p), out)
  }
}

// The pinned package.json stub for a channel plugin dir (committed) / cache (seeded) — same bytes as
// ensure-daemon's self-heal manifest, so deps resolve to the exact pinned versions.
function writePkgStub(dir: string) {
  Bun.write(join(dir, 'package.json'),
    JSON.stringify({ name: cfg.pkgName, private: true, type: 'module', dependencies: cfg.deps }, null, 2) + '\n')
}

// ---- --materialize: regenerate the self-contained plugin dir in the checkout, then exit ----
// (Claude Code copies only the `source` subtree on install, so the dir must carry its own runtime.)
if (materializeOnly) {
  if (!cfg.pluginDir) die('--materialize is slack/discord only (tg ships the checkout directly)')
  step(`materializing runtime closure → ${cfg.pluginDir}/ (committed, deploy-generated)`)
  syncPayloadInto(REPO, 'repoDest')
  writePkgStub(join(REPO, cfg.pluginDir))
  console.log(`\n✓ materialized ${cfg.pluginDir}/ — commit the generated copies`)
  process.exit(0)
}

// ---- 1. prepare the new cache dir (clone deps from the newest existing version, if any) ----
const newCache = join(CACHE_BASE, next)
const freshCache = !existsSync(newCache)
if (freshCache) {
  const versions = (() => {
    try { return readdirSync(CACHE_BASE).filter(v => /^\d+\.\d+\.\d+$/.test(v)) } catch { return [] }
  })().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const seed = versions.at(-1)
  if (seed) {
    step(`cloning cache ${seed} → ${next} (carries node_modules/bun.lock)`)
    // Clone to a TEMP path and rename into place, never straight to the version name. What is being
    // copied is the PREVIOUS version's tree, and for as long as it sits under <next>'s name it is
    // indistinguishable from a release — ensure-daemon's "highest version wins" will launch it. A
    // deploy that died in this window on 2026-07-26 left 0.4.76 holding 0.4.75's bytes and the fleet
    // respawned into it. rename(2) is atomic within a filesystem, so the version name never exists
    // in a half-populated state, and an abort now leaves a `.cloning-<pid>` dir that neither this
    // script's seed scan nor findDaemon will look at (both filter on /^\d+\.\d+\.\d+$/).
    // This does NOT make the guard redundant: the renamed dir still carries the SEED's manifest
    // until the sync below stamps it, so there remains a window the manifest check covers.
    const tmp = `${newCache}.cloning-${process.pid}`
    rmSync(tmp, { recursive: true, force: true })
    const r = sh('cp', ['-a', join(CACHE_BASE, seed), tmp])
    if (r.status !== 0) { rmSync(tmp, { recursive: true, force: true }); die(`cloning cache dir failed: ${r.stderr}`) }
    renameSync(tmp, newCache)
  } else {
    step(`no existing cache version to clone — creating ${next} from scratch`)
    mkdirSync(newCache, { recursive: true })
  }
}
// Re-deploying a version that already exists overwrites it in place, so the bytes that were serving
// traffic a moment ago have no other copy anywhere — and the rollback below would have nothing to
// restore. `/update` has always taken this backup; deploy never did. `.pre-<ts>` fails SEMVER, so no
// supervisor can select it while it waits.
const backupDir = freshCache ? null : `${newCache}.pre-${Date.now()}`
if (backupDir) {
  step(`backing up the existing ${next} → ${basename(backupDir)} (rollback target if this ship fails)`)
  const r = sh('cp', ['-a', newCache, backupDir])
  if (r.status !== 0) die(`backing up the existing cache dir failed: ${r.stderr}`)
}

// ---- 2. sync the payload into the cache copy (flat), then stamp its manifests to the new version ----
step(`syncing ${payload.length} files → cache/${cfg.cacheName}/${next}`)
syncPayloadInto(newCache, 'cacheDest')
patchVersion(join(newCache, '.claude-plugin', 'plugin.json'), next)
// The shared marketplace.json ships in the cache ONLY for tg (source "./"); slack/discord caches
// carry just their plugin.json. Stamp this plugin's entry where it exists.
const cacheMarket = join(newCache, MARKET_JSON)
if (existsSync(cacheMarket)) patchMarketVersion(cacheMarket, cfg.mktName, next)

// ---- 3. make sure deps are present in the cache (mirror ensure-daemon's self-heal) ----
const pkgPath = join(newCache, 'package.json')
if (!existsSync(pkgPath)) writePkgStub(newCache)
const probeDep = Object.keys(cfg.deps)[0]   // 'grammy' | '@slack/bolt' | 'discord.js'
if (!existsSync(join(newCache, 'node_modules', ...probeDep.split('/')))) {
  step('installing daemon deps in the cache (' + Object.entries(cfg.deps).map(([n, v]) => `${n}@${v}`).join(', ') + ')')
  const r = sh('bun', ['install', '--no-summary'], newCache)
  if (r.status !== 0) die(`bun install in cache failed:\n${r.stderr}`)
}

// ---- 4. type-check in the cache (deps resolve there). Failure here never touches the checkout ----
step(`type-checking (bun build ${cfg.daemonEntry} --target=bun)`)
const build = sh('bun', ['build', cfg.daemonEntry, '--target=bun'], newCache)
if (build.status !== 0) {
  if (freshCache) rmSync(newCache, { recursive: true, force: true })
  die(`type-check failed — checkout left untouched:\n${build.stderr || build.stdout}`)
}
// bun build only transpiles — it has shipped unimported identifiers before. The real typecheck
// runs in the CHECKOUT (same files just synced; typescript + @types/bun are devDeps there). A
// fresh checkout (e.g. the other user's, or CI) may have no node_modules yet, so self-heal the
// devDeps first (mirrors the cache-deps step above) — otherwise tsc fails to resolve @types/bun
// and the gate trips for the wrong reason.
if (!existsSync(join(REPO, 'node_modules', 'typescript'))) {
  step('installing checkout devDeps (typescript + @types/bun)')
  const r = sh('bun', ['install', '--no-summary'], REPO)
  if (r.status !== 0) die(`bun install in checkout failed:\n${r.stderr || r.stdout || '(no output)'}`)
}
step('type-checking (tsc --noEmit)')
const tsc = sh('bun', ['x', 'tsc', '--noEmit'], REPO)   // `bun x`, not `bunx` (the latter isn't always on PATH)
if (tsc.status !== 0) {
  if (freshCache) rmSync(newCache, { recursive: true, force: true })
  die(`tsc failed — checkout left untouched:\n${(tsc.stdout || tsc.stderr || '(tsc produced no output)').slice(0, 4000)}`)
}
step('type-check OK')
// Unit tests gate the ship too — they're fast (<1s) and cover the extracted domains.
step('running unit tests (bun test)')
const tests = sh('bun', ['test'], REPO)
if (tests.status !== 0) {
  if (freshCache) rmSync(newCache, { recursive: true, force: true })
  die(`tests failed — checkout left untouched:\n${(tests.stderr || tests.stdout || '(no output)').slice(-4000)}`)
}
step('tests OK')
// The gate /update had and deploy did not: EXECUTE the freshly-built module — every import plus the
// top-level init wiring — with `--selftest`, which evaluates everything and exits 0 before any
// socket, watchdog or polling. `bun build` parses and transpiles; `tsc` types. Neither runs the
// thing, so neither catches a top-level eval failure, and a build that cannot boot is exactly the
// class the rollback below exists for. Dummy token + throwaway state dir so it needs no real config.
step('self-test (executing the built module)')
const selftest = sh('bun', [cfg.daemonEntry, '--selftest'], newCache, {
  TELEGRAM_BOT_TOKEN: 'SELFTEST:0', TELEGRAM_STATE_DIR: join(newCache, '.selftest-state'),
})
if (selftest.status !== 0) {
  if (freshCache) rmSync(newCache, { recursive: true, force: true })
  die(`self-test failed — checkout left untouched:\n${(selftest.stderr || selftest.stdout || '(no output)').slice(-4000)}`)
}
step('self-test OK')
// IDENTITY of these bytes, for whoever reads this dir later and for /update, which otherwise falls
// back to "dir name == clone version" when deciding whether a cache is current.
stampGitref(newCache, gitOut(['rev-parse', payloadRef]) || 'unknown')

// ---- 5. build passed: materialize the self-contained plugin dir, stamp the checkout + mirror ----
// slack/discord: regenerate the committed runtime copies + pinned package.json so the plugin dir
// (the marketplace `source` subtree) carries everything Claude Code copies on install. tg ships
// the checkout directly and skips this.
if (cfg.pluginDir) {
  step(`materializing runtime closure → ${cfg.pluginDir}/ (committed, deploy-generated)`)
  syncPayloadInto(REPO, 'repoDest')
  writePkgStub(join(REPO, cfg.pluginDir))
}
patchVersion(join(REPO, PLUGIN_JSON), next)
patchMarketVersion(join(REPO, MARKET_JSON), cfg.mktName, next)
step(`bumped checkout ${PLUGIN_JSON} + ${MARKET_JSON} [${cfg.mktName}] → ${next}`)
if (existsSync(MKT)) {
  // The mirror is a repo-layout clone (Claude Code copies `source` subdirs from it), so sync at
  // repo paths and stamp this plugin's plugin.json + its marketplace entry there.
  syncPayloadInto(MKT, 'repoDest')
  if (cfg.pluginDir) writePkgStub(join(MKT, cfg.pluginDir))
  patchVersion(join(MKT, PLUGIN_JSON), next)
  if (existsSync(join(MKT, MARKET_JSON))) patchMarketVersion(join(MKT, MARKET_JSON), cfg.mktName, next)
  step('synced marketplace mirror')
}

// ---- 6. restart the live daemon (telegram only; slack/discord come up via their SessionStart hook) ----
function cmdlineOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch {}
  const r = sh('ps', ['-p', String(pid), '-o', 'args=']); return r.status === 0 ? r.stdout.trim() : ''
}
// ROLLBACK. Reverts everything this deploy did that outlives the process, in the one order that
// works, and then reports which check failed — a false rollback has to be diagnosable from its own
// artifact, or the next person cannot tell "the build was bad" from "the health check was flaky".
//
// The checkout's version files are reverted too, which is a deploy-only concern (/update never
// touches a checkout): leaving them bumped would claim a version installed nowhere, which is exactly
// what the stranded-version gate trips over on the NEXT deploy.
function rollbackAndDie(why: string, detail: string, failedCheck: string): never {
  console.error(`\n✗ ${why}\n  ${detail}`)
  step('rolling back')
  stopSupervisors({ stateDir: STATE_DIR, cacheBase: CACHE_BASE })
  const plan = rollback({ cacheBase: CACHE_BASE, failedVersion: next, backupDir })
  if (plan.renamedTo) step(`failed build renamed → ${basename(plan.renamedTo)} (bytes kept for diagnosis)`)
  if (plan.restoredBackup) step(`restored the pre-deploy ${next}`)
  // Revert the two version files this deploy stamped. Path-scoped: the checkout is shared.
  sh('git', ['checkout', 'HEAD', '--', PLUGIN_JSON, MARKET_JSON], REPO)
  step(`reverted ${PLUGIN_JSON} + ${MARKET_JSON} in the checkout`)
  if (!plan.target) {
    console.error('\n🛑 nothing selectable left in the cache — manual recovery needed')
    process.exit(1)
  }
  step(`relaunching ${plan.target} (${plan.targetBasis})`)
  const ed = join(CACHE_BASE, plan.target, 'ensure-daemon.ts')
  if (existsSync(ed)) sh('bun', [ed], join(CACHE_BASE, plan.target))
  // The record. Written where the failure happened, in the words the checks themselves produced.
  const record = [
    `deploy of ${next} FAILED and was rolled back`,
    `failed check: ${failedCheck}`,
    `detail: ${detail}`,
    `now running: ${plan.target} (${plan.targetBasis})`,
    plan.renamedTo ? `failed bytes: ${plan.renamedTo}` : '',
  ].filter(Boolean).join('\n')
  try { writeFileSync(join(CACHE_BASE, 'last-rollback.txt'), record + '\n', { mode: 0o644 }) } catch {}
  console.error(`\n${record}\n`)
  process.exit(1)
}

if (!cfg.restartTelegram) {
  step(`[${cfg.id}] cache shipped — its daemon comes up via the plugin's SessionStart hook (telegram daemon untouched)`)
} else if (noRestart) {
  step('--no-restart: leaving the running daemon as-is')
} else {
  const logOffset = (() => { try { return statSync(DAEMON_LOG).size } catch { return 0 } })()
  step('stopping daemon + watchdog (pid-first)')
  // PID-FIRST, and the stray-checkout sweep stays OFF here. The pattern it uses cannot be rooted at a
  // cache path, so it matches any bridge-shaped process on the box — /update opts into it because it
  // runs in production by definition; a deploy (which is also how this mechanism gets TESTED under a
  // sandbox $HOME) must never fire it.
  const stopped = stopSupervisors({ stateDir: STATE_DIR, cacheBase: CACHE_BASE })
  step(`stopped ${stopped.killed.length ? `pid(s) ${stopped.killed.join(', ')}` : 'nothing by pid'}` +
    (stopped.skipped.length ? ` · skipped ${stopped.skipped.map(s => `${s.pid} (${s.why})`).join(', ')}` : ''))
  for (let i = 0; i < 20; i++) { Bun.sleepSync(250); if (!existsSync(DAEMON_PID)) break }
  const ed = join(newCache, 'ensure-daemon.ts')
  if (!existsSync(ed)) die(`no ensure-daemon.ts in cache/${next} — cannot restart`)
  step('respawning via ensure-daemon')
  sh('bun', [ed], newCache)
  step('health-check (functional AND identity)')
  const health = await healthCheck({
    socketPath: SOCKET, logFile: DAEMON_LOG, logOffset, pidFile: DAEMON_PID, expectVersion: next,
  })
  if (!health.ok) rollbackAndDie(`the new build did not come up healthy`, health.detail, health.failed ?? 'unknown')
  step(`daemon up on cache/${next} — ${health.detail}`)
  // Positive evidence of goodness, and the only thing a later rollback can aim at with confidence.
  markHealthy(newCache, { version: next, gitref: gitOut(['rev-parse', payloadRef]) || 'unknown', at: Date.now() })
  const pruned = pruneOldVersions(CACHE_BASE, 3)
  if (pruned.length) step(`pruned ${pruned.length} old version dir(s): ${pruned.join(', ')}`)
  if (backupDir) { try { rmSync(backupDir, { recursive: true, force: true }) } catch {} }
}

// ---- 6b. refresh the installed copies that live outside the cache ----
// `/update` has always done this and deploy never did, so a box that ships by deploy ran a current
// daemon against a stale convention in ~/.claude/CLAUDE.md — invisible, because each half was
// internally consistent (installed-copies.ts has the measurement). Source is PAYLOAD_ROOT, not the
// checkout: what gets installed must be the bytes that just shipped, not whatever is dirty on disk.
// Runs AFTER the restart, so a build that never came up cannot leave a newer convention behind than
// the daemon serving it. Never fails a deploy — a convention refresh is not worth losing a ship.
{
  const note = syncConventionBlock(PAYLOAD_ROOT, homedir())
  if (note) step(`${note} — new sessions pick it up on their next start`)
}

// ---- 7. optional commit + push ----
if (commitMsg) {
  step('committing + pushing')
  // EXPLICIT PATHS, never `git add -A`. This checkout is shared by concurrent agent sessions, so a
  // whole-tree stage sweeps whatever another session has in flight into the release commit — the
  // same class of accident as `git stash` here (see CLAUDE.md). Stage only what a deploy itself
  // changed: the version files, plus the materialized plugin dir for slack/discord.
  const owned = [PLUGIN_JSON, MARKET_JSON, ...(cfg.pluginDir ? [cfg.pluginDir] : [])]
  const add = sh('git', ['add', '--', ...owned], REPO); if (add.status !== 0) die(`git add failed: ${add.stderr}`)
  const others = sh('git', ['status', '--porcelain'], REPO).stdout
    .split('\n').filter(l => l.trim() && !l.startsWith('M  ') && !l.startsWith('A  ')).map(l => l.slice(3))
  if (others.length) {
    console.log(`  note: NOT committed (not this deploy's to stage — commit them yourself):`)
    for (const f of others) console.log(`      ${f}`)
  }
  const body = `${commitMsg}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  const c = sh('git', ['commit', '-q', '-m', body], REPO); if (c.status !== 0) die(`git commit failed: ${c.stderr || c.stdout}`)
  const p = sh('git', ['push'], REPO); if (p.status !== 0) die(`git push failed: ${p.stderr}`)
  step('pushed → origin (releases to installs)')
}

console.log(`\n✓ deployed [${cfg.id}] ${next}${commitMsg ? ' (committed + pushed)' : ''}`)
// Explicit paths, never `git add -A` — this checkout is shared (CLAUDE.md).
if (!commitMsg) console.log(`  next: git add -- .claude-plugin/ && git commit -m "…(${cfg.id} v${next})" && git push`)
