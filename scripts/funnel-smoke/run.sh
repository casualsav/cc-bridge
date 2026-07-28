#!/bin/bash
# Drive `bun setup.ts` end to end through every state of its Funnel walk-through, against scripted
# `tailscale` / `ss` / `sudo` / `dig` shims — no real tailscaled, no real daemon, no production
# config. Ported into the repo from the throwaway harness the installer-funnel build used, because
# the field failures from the second server (a proxy holding :443; a funnel that reports success and
# binds nothing) need permanent coverage.
#
#   scripts/funnel-smoke/run.sh [scratchdir] [scenario…]
#
# Isolation, and each part earns its place:
#   · HOME and TELEGRAM_STATE_DIR are scratch dirs, so nothing touches ~/.claude or the live channel
#   · PATH is a symlink farm of /usr/bin + /bin with `claude` REMOVED — the wizard's plugin step
#     shells out to it, and a smoke run must never install or verify a plugin for real
#   · HTTP(S)_PROXY point at a closed port, so the token-validation call cannot reach Telegram
#   · a containment check after every scenario: no daemon.log written, no daemon.ts process alive
#
# stdin is fed as a here-string plus a `sleep 30`, deliberately: a plain finite pipe hits EOF the
# moment printf exits, which flips the wizard's `_closed` flag before the later prompts are reached
# and silently routes every run down the non-interactive path. Scenario 8 is the one that WANTS that.
set -uo pipefail
# SMOKE_REPO runs the scenarios against a DIFFERENT checkout — a detached worktree at an older
# commit, say — which is how the happy path gets byte-diffed against its own pre-change output.
REPO="${SMOKE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCRATCH="${1:-$(mktemp -d /tmp/funnel-smoke-XXXXXX)}"; shift || true
ONLY="$*"
mkdir -p "$SCRATCH"
echo "repo=$REPO"
echo "scratch=$SCRATCH"

# The PATH farm: everything in /usr/bin and /bin except claude, built once per scratch dir.
SYSFARM="$SCRATCH/sysfarm"
if [ ! -d "$SYSFARM" ]; then
  mkdir -p "$SYSFARM"
  for d in /usr/bin /bin; do
    for f in "$d"/*; do
      b="$(basename "$f")"
      # `ss` is excluded for the same reason as `claude`: the real one reports THIS box's listeners,
      # so a scenario that meant to test "no ss installed" silently measured the host instead — and
      # every other scenario's 443 state would depend on what happens to be running here. It comes
      # from the stubfarm or not at all.
      case "$b" in claude|claude-*|ss) continue ;; esac
      [ -e "$SYSFARM/$b" ] || ln -s "$f" "$SYSFARM/$b" 2>/dev/null
    done
  done
  # …plus the one interpreter the wizard is RUN with. /usr/local/bin is not farmed wholesale (that
  # is where `tg` and other bridge entry points live, and a smoke run has no business reaching them).
  ln -sf "$(command -v bun)" "$SYSFARM/bun"
fi

setup_common() {
  local sc="$1"
  export HOME="$SCRATCH/home-$sc"
  export TELEGRAM_STATE_DIR="$SCRATCH/state-$sc"
  rm -rf "$HOME" "$TELEGRAM_STATE_DIR"
  mkdir -p "$HOME/.claude" "$TELEGRAM_STATE_DIR"
  export STUBFARM="$SCRATCH/stubfarm-$sc"
  rm -rf "$STUBFARM"; mkdir -p "$STUBFARM"
  export CALLS_LOG="$SCRATCH/calls-$sc.log"
  : > "$CALLS_LOG"
  cat > "$STUBFARM/sudo" <<'EOF'
#!/bin/sh
echo "$0 $*" >> "$CALLS_LOG"
exec "$@"
EOF
  cat > "$STUBFARM/dig" <<'EOF'
#!/bin/sh
echo "$0 $*" >> "$CALLS_LOG"
exit 0
EOF
  chmod +x "$STUBFARM/sudo" "$STUBFARM/dig"
  unset SS_MODE
}

add_tailscale() {
  local sc="$1"
  export TS_STATEDIR="$SCRATCH/ts-state-$sc"
  rm -rf "$TS_STATEDIR"; mkdir -p "$TS_STATEDIR"
  cp "$REPO/scripts/funnel-smoke/tailscale-stub.py" "$STUBFARM/tailscale"
  chmod +x "$STUBFARM/tailscale"
}

# `ss` is only on PATH when a scenario asks for it — its absence is itself a case the wizard must
# survive (the checks are additive and skip silently on a box without it).
add_ss() {
  cp "$REPO/scripts/funnel-smoke/ss-stub.sh" "$STUBFARM/ss"
  chmod +x "$STUBFARM/ss"
  export SS_MODE="$1"
}

# The verify step's two tools. Default `dig` (from setup_common) answers nothing, which is the
# ordinary post-install state; these replace it when a scenario wants to reach the probe itself.
add_verify() {
  cp "$REPO/scripts/funnel-smoke/dig-stub.sh" "$STUBFARM/dig"
  cp "$REPO/scripts/funnel-smoke/curl-stub.sh" "$STUBFARM/curl"
  chmod +x "$STUBFARM/dig" "$STUBFARM/curl"
  export DIG_MODE="$1" CURL_MODE="$2"
}

drive() {
  local sc="$1"; shift
  local feed="$1"; shift
  local keepopen="${1:-1}"
  cd "$REPO"
  local runner=(timeout 180 env
    HOME="$HOME" TELEGRAM_STATE_DIR="$TELEGRAM_STATE_DIR"
    HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9
    PATH="$STUBFARM:$SYSFARM"
    CALLS_LOG="$CALLS_LOG"
    TS_STATEDIR="${TS_STATEDIR:-}" TS_DNSNAME="${TS_DNSNAME:-testbox.tail1234.ts.net}"
    TS_BACKEND_INITIAL="${TS_BACKEND_INITIAL:-Running}" TS_CERT_MODE="${TS_CERT_MODE:-ok}"
    TS_FUNNEL_INITIAL="${TS_FUNNEL_INITIAL:-none}" TS_FUNNEL_BG_MODE="${TS_FUNNEL_BG_MODE:-ok}"
    TS_PORT="${TS_PORT:-8787}" SS_MODE="${SS_MODE:-free}"
    bun setup.ts)
  if [ "$keepopen" = "1" ]; then
    { printf '%s' "$feed"; sleep 30; } | "${runner[@]}" > "$SCRATCH/out-$sc.log" 2>&1
  else
    printf '%s' "$feed" | "${runner[@]}" > "$SCRATCH/out-$sc.log" 2>&1
  fi
  echo "exit=$? sc=$sc" >> "$SCRATCH/exitcodes.log"
}

contain_check() {
  local sc="$1" breach=0
  if [ -f "$TELEGRAM_STATE_DIR/daemon.log" ]; then
    echo "CONTAINMENT BREACH [$sc]: daemon.log at $TELEGRAM_STATE_DIR" | tee -a "$SCRATCH/BREACHES.log"; breach=1
  fi
  local pids
  pids=$(ps aux | grep "bun .*$REPO/daemon.ts" | grep -v grep | awk '{print $2}')
  if [ -n "$pids" ]; then
    echo "CONTAINMENT BREACH [$sc]: daemon.ts running: $pids" | tee -a "$SCRATCH/BREACHES.log"
    kill $pids 2>/dev/null || true; breach=1
  fi
  [ "$breach" = "0" ] && echo "[$sc] containment OK"
}

want() { [ -z "$ONLY" ] || [[ " $ONLY " == *" $1 "* ]]; }

TOKEN='123456789:AAdummyTOKENdummyTOKENdummyTOKENdum'
: > "$SCRATCH/exitcodes.log"; : > "$SCRATCH/BREACHES.log"
# token · telegram id · voice · codex · file-browser level · hosting choice · [extras] · trailing n's
FEED_FUNNEL="${TOKEN}
837047563
1
n
1
1
n
n
n
"

if want 1; then   # happy path + DNS lag
  sc=1; setup_common $sc; add_tailscale $sc
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  add_ss tailscaled
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

if want 6; then   # tailscale absent, install declined -> cloudflared
  sc=6; setup_common $sc; unset TS_STATEDIR
  drive $sc "${TOKEN}
837047563
1
n
1
1
n
n
n
n
"; contain_check $sc
fi

if want 7; then   # existing FOREIGN funnel, repoint declined -> cloudflared
  sc=7; setup_common $sc; add_tailscale $sc
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=foreign TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  add_ss free
  drive $sc "${TOKEN}
837047563
1
n
1
1
n
n
n
n
"; contain_check $sc
fi

if want 11; then  # cloudflared chosen outright — no tailscale call at all
  sc=11; setup_common $sc; unset TS_STATEDIR
  drive $sc "${TOKEN}
837047563
1
n
1
2
n
n
n
"; contain_check $sc
fi

# ---- the two field-failure states (this is why the harness is in the repo) ----

if want 12; then  # another process holds *:443 — the pre-check must warn, and declining falls back
  sc=12; setup_common $sc; add_tailscale $sc
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  add_ss other
  # …the extra `n` answers "carry on anyway?" with NO.
  drive $sc "${TOKEN}
837047563
1
n
1
1
n
n
n
n
"; contain_check $sc
fi

if want 13; then  # THE FIELD FAILURE, end to end: 443 held, user proceeds anyway, funnel reports
                  # success (exit 0 + a status entry) and binds nothing. Only the POST-check can
                  # catch this one — the extra `y` deliberately overrides the pre-check's warning.
  sc=13; setup_common $sc; add_tailscale $sc
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  add_ss other
  drive $sc "${TOKEN}
837047563
1
n
1
1
y
n
n
n
"; contain_check $sc
fi

if want 14; then  # the SAME trap by the other entrance: a serve config already naming our port, so
                  # `funnel --bg` never runs and the pre-check is skipped — the post-check is the
                  # only thing standing between a stale config entry and a "working" install.
  sc=14; setup_common $sc; add_tailscale $sc
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=configured TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  add_ss other
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

if want 16; then  # CONTROL: nothing on 443 at all. A netstack tailscaled needs no kernel socket
                  # there, so this must NOT be demoted — an absent socket is not evidence of a dead
                  # funnel, only a non-tailscaled OWNER of the port is. Expect the happy path.
  sc=16; setup_common $sc; add_tailscale $sc
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  add_ss free
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

if want 15; then  # no `ss` on PATH at all — both checks must skip silently, happy path intact
  sc=15; setup_common $sc; add_tailscale $sc
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

if want 17; then  # the verify step: resolvers DISAGREE (8.8.8.8 has it, 1.1.1.1 doesn't) — the
                  # reporting box's shape. Expect the disagreement said out loud with a pointer,
                  # NOT a wedge verdict, and the probe carrying on against the resolver that answered.
  sc=17; setup_common $sc; add_tailscale $sc; add_ss tailscaled; add_verify split pair
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

if want 18; then  # the success PAIR: 200 on / and 401 on /api/*
  sc=18; setup_common $sc; add_tailscale $sc; add_ss tailscaled; add_verify both pair
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

if want 19; then  # 200 on / but NOT 401 on /api — something else answering on the ingress address.
                  # A 200-only check calls this a success; the pair is what makes it visible.
  sc=19; setup_common $sc; add_tailscale $sc; add_ss tailscaled; add_verify both shell
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

if want 20; then  # THE WEDGE, staged at the authority: 1.1.1.1 empty, 8.8.8.8 serving, and ts.net's
                  # own nameserver answering NXDOMAIN for A while it serves AAAA. Expect the wizard to
                  # NAME it as wedged and print the rename remedy with its URL-change warning —
                  # instead of the "give it a few minutes" it used to print at a permanent condition.
                  # Scenario 17 is this one's control: same divergence, healthy authority, no verdict.
  sc=20; setup_common $sc; add_tailscale $sc; add_ss tailscaled; add_verify wedge pair
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

if want 21; then  # two published ingress IPs, only the FIRST one healthy. A probe pinned to ips[0]
                  # calls this a clean success; expect the second IP named as failing.
  sc=21; setup_common $sc; add_tailscale $sc; add_ss tailscaled; add_verify both partial
  export TS_BACKEND_INITIAL=Running TS_CERT_MODE=ok TS_FUNNEL_INITIAL=none TS_FUNNEL_BG_MODE=ok TS_PORT=8787
  drive $sc "$FEED_FUNNEL"; contain_check $sc
fi

echo "=== done ==="
cat "$SCRATCH/exitcodes.log"
echo "--- breaches (empty is good) ---"; cat "$SCRATCH/BREACHES.log"
