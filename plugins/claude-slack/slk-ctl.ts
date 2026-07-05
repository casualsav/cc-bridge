#!/usr/bin/env bun
// `slk` bin entry — the Slack analogue of `tg` (tgctl.ts). Thin wrapper: point channel-ctl's shared
// core at the Slack daemon socket. SLACK_STATE_DIR (env) redirects it at a throwaway daemon in tests.
import { runCtl } from './channel-ctl.ts'
import { SLACK_SOCKET_PATH } from './slack-paths.ts'

runCtl({ name: 'slk', socketPath: SLACK_SOCKET_PATH }, process.argv.slice(2))
