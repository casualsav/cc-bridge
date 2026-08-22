// The neutral core modules shared by the non-telegram daemons (multi-channel.md: "live at repo
// ROOT"). Split out of deploy.ts so `plugin-materialize.test.ts` can import the list without
// importing deploy.ts itself — that script has no `import.meta.main` guard and runs the real
// deploy pipeline (git shelling, provenance gate, possibly a live ship) as an import side effect.
export const CORE = [
  'channel.ts', 'common.ts', 'channel-ctl.ts', 'pane-io.ts', 'proc.ts', 'prompt.ts',
  'transcript.ts', 'codex-transcript.ts', 'agent-transcript.ts', 'agent.ts',
  'delivery-log.ts', 'ansi.ts',
]
export const SLACK_ROOT_FILES = [...CORE,
  'slack-adapter.ts', 'slack-render.ts', 'slack-daemon.ts', 'slack-paths.ts', 'slk-ctl.ts', 'ensure-slack-daemon.ts']
export const DISCORD_ROOT_FILES = [...CORE,
  'discord-adapter.ts', 'discord-render.ts', 'discord-daemon.ts', 'discord-paths.ts', 'dsc-ctl.ts', 'ensure-discord-daemon.ts']
