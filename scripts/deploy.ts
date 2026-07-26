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
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, copyFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { shipGate } from '../ship-gate.ts'

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
function sh(cmd: string, args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? (r.error ? `${cmd}: ${r.error.message}` : '')
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
type Payload = { src: string; cacheDest: string; repoDest: string }
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
  return { src: join(REPO, rel), cacheDest: rel, repoDest: rel }
}

// A self-contained channel plugin's payload: the runtime closure (source of truth at repo root,
// but shipped flat into the plugin dir + cache) plus the hand-authored manifest. `cacheDest` is the
// file's position in the flat cache; `repoDest` is its committed home under the plugin dir.
function channelPayload(pluginDir: string, rootFiles: string[]): Payload[] {
  return [
    ...rootFiles.map(f => ({ src: join(REPO, f), cacheDest: f, repoDest: join(pluginDir, f) })),
    ...MANIFEST_FILES.map(f => ({ src: join(REPO, pluginDir, f), cacheDest: f, repoDest: join(pluginDir, f) })),
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
// Every flag that takes a value must exclude that value here, or it is read as the bump: the first
// spelling of this gate had `--ship-branch tg/foo` die with `unknown bump "tg/foo"`.
const bumpArg = argv.find((a, i) =>
  !a.startsWith('--') && a !== commitMsg
  && !(pluginIdx >= 0 && i === pluginIdx + 1)
  && !(shipIdx >= 0 && i === shipIdx + 1)) ?? 'patch'

const CACHE_BASE = join(CACHE_ROOT, cfg.cacheName)
const DAEMON_PID = join(homedir(), '.claude', 'channels', 'telegram', 'daemon.pid')
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
// A deploy syncs the WORKING TREE (syncPayloadInto copies from REPO, not from git) into the plugin
// cache and restarts the live daemon. Nothing here previously looked at which branch that tree was
// on, so a session working on its own branch — the normal shape once sessions get worktrees — could
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
if (!materializeOnly && !dryRun) {
  const gate = shipGate(
    gitOut(['rev-parse', '--abbrev-ref', 'HEAD']),
    shipIdx >= 0 ? (argv[shipIdx + 1] ?? '') : null,
  )
  if (!gate.ok) die(gate.error)
  if (gate.warn) console.log(`⚠️  ${gate.warn}\n`)

}

// Deliberately OUTSIDE the gate above, so `--dry-run` shows it too. This is pure information, and
// information you can only obtain by doing the irreversible thing is not a preview. A dirty-payload
// listing is exactly what someone wants before committing to a deploy, not in the scrollback after.
//
// Not a refusal — in a checkout shared by several sessions the tree is dirty most of the time, so
// refusing on dirt would block every legitimate deploy. But the payload is copied from the working
// tree, so uncommitted edits to a shipped file DO go out: name them, so that is a choice.
{
  // NOT gitOut: it .trim()s the whole output, which eats the leading status space of the FIRST
  // porcelain line (" M path" becomes "M path"), so slice(3) then shaved a character off the first
  // filename it printed. A subtly wrong path is worse than none — it reads as correct.
  const st = sh('git', ['-C', REPO, 'status', '--porcelain', '--', ...payload.map(p => p.src)])
  const dirty = (st.status === 0 ? st.stdout : '')
    .split('\n').map(l => l.slice(3).trimEnd()).filter(Boolean)   // porcelain: 2 status chars + a space, then the path
  if (dirty.length) {
    console.log(`⚠️  shipping UNCOMMITTED changes in ${dirty.length} payload file(s):`)
    for (const f of dirty) console.log(`      ${f}`)
    console.log('')
  }
}

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
    const ok = existsSync(p.src)
    if (!ok) missing++
    console.log(`    ${ok ? ' ' : '✗'} ${p.cacheDest}${ok ? '' : '   (MISSING — not on disk yet)'}`)
  }
  console.log(`\n  (dry-run — nothing written; ${missing} missing file${missing === 1 ? '' : 's'})`)
  process.exit(0)
}

// A real deploy needs every payload file present (a missing module would break the daemon in cache).
for (const p of payload) if (!existsSync(p.src)) die(`payload file missing on disk: ${p.cacheDest} (${p.src})`)

// Copy the resolved payload into `dest`, keyed by `which` position (flat cache vs repo-layout
// mirror/checkout). Overwrites unconditionally (a cloned/prior dir may already hold the file).
// Skips a file whose destination IS its source — the manifest's repoDest self-copy when
// materializing the plugin dir in the checkout (copyFileSync onto itself would truncate it).
function syncPayloadInto(dest: string, which: 'cacheDest' | 'repoDest') {
  for (const p of payload) {
    const out = join(dest, p[which])
    if (resolve(out) === resolve(p.src)) continue
    mkdirSync(dirname(out), { recursive: true })
    copyFileSync(p.src, out)
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
if (!cfg.restartTelegram) {
  step(`[${cfg.id}] cache shipped — its daemon comes up via the plugin's SessionStart hook (telegram daemon untouched)`)
} else if (noRestart) {
  step('--no-restart: leaving the running daemon as-is')
} else if (!existsSync(DAEMON_PID)) {
  step('no daemon.pid found — nothing running to restart (a session start will launch the new code)')
} else {
  const oldPid = parseInt(readFileSync(DAEMON_PID, 'utf8').trim(), 10)
  step(`restarting daemon (old pid ${oldPid})`)
  try { process.kill(oldPid, 'SIGTERM') } catch {}
  // Wait for the old process to actually exit (and release the socket) so ensure-daemon sees it
  // down. Then proactively respawn from the new cache rather than waiting on the watchdog's lazy
  // 20s poll — ensure-daemon is idempotent and gates on socket liveness, so it won't race the
  // watchdog into a double-spawn.
  for (let i = 0; i < 20; i++) { Bun.sleepSync(250); try { process.kill(oldPid, 0) } catch { break } }
  const ed = join(newCache, 'ensure-daemon.ts')
  if (existsSync(ed)) { step('respawning via ensure-daemon'); sh('bun', [ed], newCache) }
  let newPid = 0
  for (let i = 0; i < 60; i++) { // up to ~30s: covers bun startup + the watchdog fallback path
    Bun.sleepSync(500)
    let p = 0
    try { p = parseInt(readFileSync(DAEMON_PID, 'utf8').trim(), 10) } catch {}
    if (p && p !== oldPid) { try { process.kill(p, 0); newPid = p; break } catch {} }
  }
  if (!newPid) die(`daemon did not come back within 30s — check ~/.claude/channels/telegram for logs`)
  const line = cmdlineOf(newPid)
  if (!line.includes(`/${next}/`)) {
    console.error(`⚠ daemon respawned (pid ${newPid}) but not from cache/${next}:\n  ${line}`)
    console.error(`  (a stale .pid or a higher cache version may be winning — check ${CACHE_BASE})`)
  } else {
    step(`daemon up: pid ${newPid} on cache/${next}`)
  }
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
  const body = `${commitMsg}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  const c = sh('git', ['commit', '-q', '-m', body], REPO); if (c.status !== 0) die(`git commit failed: ${c.stderr || c.stdout}`)
  const p = sh('git', ['push'], REPO); if (p.status !== 0) die(`git push failed: ${p.stderr}`)
  step('pushed → origin (releases to installs)')
}

console.log(`\n✓ deployed [${cfg.id}] ${next}${commitMsg ? ' (committed + pushed)' : ''}`)
// Explicit paths, never `git add -A` — this checkout is shared (CLAUDE.md).
if (!commitMsg) console.log(`  next: git add -- .claude-plugin/ && git commit -m "…(${cfg.id} v${next})" && git push`)
