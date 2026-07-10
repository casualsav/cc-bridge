#!/usr/bin/env bash
# Optional systemd user unit that re-runs ensure-daemon every 60s.
#
# The bridge already self-heals while anything is alive: the SessionStart hook
# runs ensure-daemon, and daemon.ts / watchdog.ts cross-guard each other. This
# unit covers the two cases they can't:
#   - a reboot on a headless box, where no Claude session ever fires the hook
#   - daemon AND watchdog dying together (OOM sweep, manual pkill)
# ensure-daemon is idempotent and enumerates every configured instance, so the
# loop is safe to run alongside sessions and multi-bridge setups.
set -euo pipefail

UNIT_NAME=claude-tg-keepalive.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BUN="$(command -v bun)" || { echo "bun not found on PATH" >&2; exit 1; }

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$UNIT_NAME" <<EOF
[Unit]
Description=Telegram bridge keepalive (re-runs ensure-daemon periodically)
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash -c 'while true; do "$BUN" "\$(ls -d %h/.claude/plugins/cache/cc-bridge/telegram/*/ 2>/dev/null | sort -V | tail -1)ensure-daemon.ts" >/dev/null 2>&1; sleep 60; done'
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

# Without linger, user units stop at logout and don't start at boot until login.
if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '=yes'; then
  echo "note: run 'sudo loginctl enable-linger $USER' so the unit starts at boot without a login"
fi
systemctl --user is-active "$UNIT_NAME" && echo "installed: $UNIT_NAME"
