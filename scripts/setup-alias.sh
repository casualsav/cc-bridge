#!/usr/bin/env bash
# One-time convenience: add the Telegram-bridge launchers to the user's shell rc. Mode-aware
# (default off-MCP, the recommended mode):
#   off-mcp -> a shell FUNCTION that takes an optional instance slot (default 1):
#                cc-bridge [--pin slack|discord] [slot] [account] -> tmux set -p @tg_bridge <slot> ; [tmux set -p @<pin> 1] ; [CLAUDE_CONFIG_DIR=~/.claude-<account>] claude --allow-dangerously-skip-permissions
#              `cc-bridge` is the primary launcher (`claude-tg` is a kept alias). The
#              `@tg_bridge <slot>` tmux PANE option is the daemon's adopt marker (decoupled from
#              claude's args); `--pin slack|discord` additionally stamps that channel's pin option.
#              `cc-bridge` = slot 1 (the default bridge); `cc-bridge 2` routes to a
#              second bridge (its own state dir/token, see /telegram:configure 2). --allow-… starts
#              in a normal mode (prompts relay to Telegram), bypass switchable on demand from /mode.
#   mcp     -> a single alias that loads the channel as a dev plugin (no pane marker needed — MCP
#              sessions register over the socket).
#
# Idempotent — re-running replaces the block in place. Run from the repo root:
#   bash scripts/setup-alias.sh [off-mcp|mcp]
set -euo pipefail

MODE="${1:-off-mcp}"
COMMENT="# cc-bridge: Telegram-bridged Claude Code launchers (${MODE})"

case "$MODE" in
  off-mcp)
    read -r -d '' DEFS <<'EOF' || true
cc-bridge()   { local pin=""; if [ "$1" = "--pin" ]; then pin="$2"; shift 2; fi; tmux set -p @telegram "${1:-1}" 2>/dev/null; tmux set -p @slack "$([ "$pin" = slack ] && echo pin || echo 1)" 2>/dev/null; tmux set -p @discord "$([ "$pin" = discord ] && echo pin || echo 1)" 2>/dev/null; if [ -n "$2" ]; then CLAUDE_CONFIG_DIR="$HOME/.claude-$2" claude --allow-dangerously-skip-permissions; else claude --allow-dangerously-skip-permissions; fi; }
claude-tg()   { cc-bridge "$@"; }
EOF
    ;;
  mcp)
    read -r -d '' DEFS <<'EOF' || true
alias cc-bridge='claude --dangerously-load-development-channels plugin:telegram@cc-bridge --dangerously-skip-permissions'
alias claude-tg='claude --dangerously-load-development-channels plugin:telegram@cc-bridge --dangerously-skip-permissions'
EOF
    ;;
  *) echo "usage: setup-alias.sh [off-mcp|mcp]  (default: off-mcp)" >&2; exit 2 ;;
esac

# Pick the rc file for the current login shell, falling back to bash.
case "${SHELL:-}" in
  *zsh) RC="${HOME}/.zshrc" ;;
  *)    RC="${HOME}/.bashrc" ;;
esac

# Drop any prior block we wrote (our comment + launcher defs, alias or function form, including
# the retired `ccb` name) so re-runs / mode switches replace cleanly, then append the fresh block.
if [ -f "$RC" ]; then
  tmp=$(mktemp)
  grep -vE '^# [a-z][a-z0-9-]*: (launch|Telegram-bridged)|^ccb\(\)|^cc-bridge\(\)|^claude-tg\(\)|^claude-yolo\(\)|^alias ccb=|^alias cc-bridge=|^alias claude-tg=|^alias claude-yolo=' "$RC" > "$tmp" || true
  cat "$tmp" > "$RC"
  rm -f "$tmp"
fi

{ echo ""; echo "$COMMENT"; printf '%s\n' "$DEFS"; } >> "$RC"

echo "✓ Wrote the ${MODE} launchers to ${RC}"
echo "  Reload your shell or run:  source ${RC}"
if [ "$MODE" = off-mcp ]; then
  echo "  Launch:  cc-bridge        (default bridge, slot 1; claude-tg still works)"
  echo "           cc-bridge 2      (second bridge — configure it first: /telegram:configure 2 <token>)"
else
  echo "  Launch:  cc-bridge       (claude-tg still works)"
fi
