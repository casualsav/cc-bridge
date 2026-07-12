// Terminal-agent identity and launch semantics shared by the bridge lifecycle.
// Keep this module pure: daemon.ts owns tmux/process orchestration; transcript readers own output.
export type AgentKind = 'claude' | 'codex'

export type AgentLaunch = {
  kind: AgentKind
  resumeId?: string
  resumeLast?: boolean
  model?: string | null
  effort?: string | null
  approval?: 'untrusted' | 'on-request' | 'never'
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export const AGENT_PANE_OPT = '@tg_agent'

export function normalizeAgent(value: unknown): AgentKind {
  return typeof value === 'string' && value.toLowerCase() === 'codex' ? 'codex' : 'claude'
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function safeToken(value: string): boolean {
  return /^[A-Za-z0-9._:/+-]+$/.test(value)
}

function token(value: string): string {
  return safeToken(value) ? value : shellQuote(value)
}

/** Build the interactive Codex command used inside a marked tmux pane. */
export function codexLaunchCommand(opts: AgentLaunch, bin = process.env.CODEX_BIN || 'codex'): string {
  const approval = opts.approval ?? 'never'
  const sandbox = opts.sandbox ?? 'workspace-write'
  const flags = [
    '--no-alt-screen',
    '--ask-for-approval', approval,
    '--sandbox', sandbox,
    '-c', shellQuote('tui.status_line=["model-with-reasoning","five-hour-limit","weekly-limit","context-used","current-dir"]'),
  ]
  if (opts.model) flags.push('--model', token(opts.model))
  if (opts.effort && ['low', 'medium', 'high', 'xhigh'].includes(opts.effort))
    flags.push('-c', shellQuote(`model_reasoning_effort=${JSON.stringify(opts.effort)}`))
  const prefix = opts.resumeId ? ['resume', token(opts.resumeId)] : opts.resumeLast ? ['resume', '--last'] : []
  return [token(bin), ...prefix, ...flags].join(' ')
}

export function agentLabel(kind: AgentKind): string {
  return kind === 'codex' ? 'Codex' : 'Claude Code'
}

export function agentInterruptKeys(_kind: AgentKind): string[] {
  return ['Escape']
}

export function agentSubmitKeys(kind: AgentKind): string[] {
  return kind === 'codex' ? ['C-m'] : ['Enter']
}

export function agentExitKeys(kind: AgentKind): string[] {
  return kind === 'codex' ? ['C-d'] : ['/exit', 'Enter']
}

export function agentResetCommand(kind: AgentKind, requested: '/clear' | '/new'): '/clear' | '/new' {
  return kind === 'codex' ? '/new' : requested
}
