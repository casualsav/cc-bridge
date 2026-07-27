#!/bin/sh
# A scripted `dig +short @<resolver> <name>` for the wizard's verify step. DIG_MODE:
#
#   none    neither resolver has the record — the ordinary t=0 state (and the wedged one; the wizard
#           cannot tell them apart in one shot, which is the whole reason it only points at the docs)
#   split   8.8.8.8 answers, 1.1.1.1 does not — the reporting box's exact shape, and the earliest
#           honest smell of a record wedged at the authority
#   both    both answer
echo "$0 $*" >> "$CALLS_LOG"
MODE="${DIG_MODE:-none}"
RESOLVER=""
for a in "$@"; do case "$a" in @*) RESOLVER="${a#@}" ;; esac; done

case "$MODE" in
  both) echo "203.0.113.10"; echo "203.0.113.11" ;;
  split) [ "$RESOLVER" = "8.8.8.8" ] && { echo "203.0.113.10"; echo "203.0.113.11"; } ;;
esac
exit 0
