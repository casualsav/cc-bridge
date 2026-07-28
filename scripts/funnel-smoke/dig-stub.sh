#!/bin/sh
# A scripted `dig` for the wizard's verify step. DIG_MODE:
#
#   none    no resolver has the record, and ts.net's NS lookup fails too — the ordinary t=0 state on
#           a box that simply has not propagated yet, and the one where the wizard must still say
#           "propagating" rather than invent a verdict
#   split   8.8.8.8 answers, 1.1.1.1 does not, and THE AUTHORITY IS HEALTHY. The must-not-fire
#           control for the wedge branch: divergence alone is not a wedge, and at t=0 it is exactly
#           what a half-propagated name looks like
#   both    both public resolvers answer (two ingress IPs)
#   wedge   the reporting box's shape: 1.1.1.1 empty, 8.8.8.8 serving, and at the ts.net authority
#           NXDOMAIN for A beside an ANSWERED AAAA — protocol-incorrect, and the one signature that
#           is a verdict at t=0 rather than a guess
#
# The wizard reaches this four ways: `+short @<res> <name>` (A), `+short NS ts.net` then `+short
# <ns>` (discovering the authority — never hardcoded, so the stub must serve the discovery too),
# `+noall +comments <type> <name> @<res>` (the header status, which is where NXDOMAIN lives — a
# `+short` NXDOMAIN and a `+short` NODATA are both just an empty line), and `+short AAAA <name> @<res>`.
echo "$0 $*" >> "$CALLS_LOG"
MODE="${DIG_MODE:-none}"
AUTH_IP="199.247.155.53"
AUTH_NS="ns-1.ts.net."

RESOLVER=""; TYPE=""; NAME=""
for a in "$@"; do
  case "$a" in
    @*)         RESOLVER="${a#@}" ;;
    +*)         ;;
    A|AAAA|NS)  TYPE="$a" ;;
    *)          NAME="$a" ;;
  esac
done
[ -n "$TYPE" ] || TYPE=A

# 1 · authority discovery, step one: which nameservers serve ts.net.
if [ "$TYPE" = "NS" ]; then
  case "$MODE" in split|wedge) echo "$AUTH_NS" ;; esac
  exit 0
fi
# 2 · …step two: that nameserver's address. Plain lookup, no @resolver.
case "$NAME" in
  "$AUTH_NS"|"${AUTH_NS%.}") echo "$AUTH_IP"; exit 0 ;;
esac

# 3 · the header status — the only place NXDOMAIN is visible.
case " $* " in
  *" +comments "*)
    if [ "$MODE" = "wedge" ] && [ "$RESOLVER" = "$AUTH_IP" ] && [ "$TYPE" = "A" ]; then
      echo ";; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 42"
    else
      echo ";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 42"
    fi
    exit 0 ;;
esac

# 4 · AAAA. Only the wedged authority serves one — that beside NXDOMAIN-for-A is the signature.
if [ "$TYPE" = "AAAA" ]; then
  if [ "$MODE" = "wedge" ] && [ "$RESOLVER" = "$AUTH_IP" ]; then echo "2600:1900:4000:1::1"; fi
  exit 0
fi

# 5 · the A records the probe actually uses.
case "$MODE" in
  both)        echo "203.0.113.10"; echo "203.0.113.11" ;;
  split|wedge) [ "$RESOLVER" = "8.8.8.8" ] && { echo "203.0.113.10"; echo "203.0.113.11"; } ;;
esac
exit 0
