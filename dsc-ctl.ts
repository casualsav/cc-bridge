#!/usr/bin/env bun
// `dsc` bin entry — the Discord analogue of `tg` (tgctl.ts). Thin wrapper: point channel-ctl's
// shared core at the Discord daemon socket. DISCORD_STATE_DIR (env) redirects it in tests.
import { runCtl } from './channel-ctl.ts'
import { DISCORD_SOCKET_PATH } from './discord-paths.ts'

runCtl({ name: 'dsc', socketPath: DISCORD_SOCKET_PATH }, process.argv.slice(2))
