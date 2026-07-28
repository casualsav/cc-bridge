#!/bin/sh
# A scripted `curl` for the wizard's public-path probe. CURL_MODE:
#
#   pair     200 on / and 401 on /api/* — the conclusive success signature
#   shell    200 on / but 200 on /api/* too: SOMETHING ELSE is answering on this ingress address,
#            which is precisely the case a 200-only check calls a success
#   down     neither answers
#   partial  the FIRST ingress IP serves the pair and the second is dead — the case a probe pinned to
#            `ips[0]` reports as a clean success while half the internet cannot reach the app
#
# The wizard calls this two ways: `-sI …/` (headers) and `-s -o /dev/null -w %{http_code} …/api/...`,
# each pinned with `--resolve <host>:443:<ip>` — which is where `partial` reads the IP from.
echo "$0 $*" >> "$CALLS_LOG"
MODE="${CURL_MODE:-pair}"

IP=""
for a in "$@"; do case "$a" in *:443:*) IP="${a##*:}" ;; esac; done

# `partial` collapses onto the existing modes per-IP, so the two request shapes below stay one code path.
if [ "$MODE" = "partial" ]; then
  if [ "$IP" = "203.0.113.10" ]; then MODE=pair; else MODE=down; fi
fi

case " $* " in
  *"/api/sessions"*)
    case "$MODE" in
      pair)  printf '401' ;;
      shell) printf '200' ;;
      *)     printf '000' ;;
    esac
    exit 0 ;;
esac
case "$MODE" in
  pair|shell) echo "HTTP/2 200"; echo "content-length: 137388" ;;
  *) exit 7 ;;
esac
exit 0
