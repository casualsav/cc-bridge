#!/bin/sh
# A scripted `ss -ltnp` for the wizard's port-443 checks. SS_MODE picks who holds the port:
#
#   free        nothing on 443 at all — the ordinary install
#   other       a NON-tailscaled wildcard listener (the field failure: Caddy on *:443, v6only:0)
#   tailscaled  tailscaled bound on the tailnet address — a real, working funnel
#   both        the competing proxy on the wildcard AND tailscaled elsewhere (443 still not ours)
#
# The output shape is copied from real `ss -ltnp` on this box, because both checks in setup.ts read
# it with a regex and a stub that formats its columns differently would test the regex against
# itself. The `users:(("name",pid=…,fd=…))` field is the part both checks actually key on.
echo "$0 $*" >> "$CALLS_LOG"
MODE="${SS_MODE:-free}"

echo 'State      Recv-Q     Send-Q          Local Address:Port           Peer Address:Port     Process'
case "$MODE" in
  other|both)
    echo 'LISTEN     0          4096                        *:443                        *:*         users:(("caddy",pid=1234,fd=7))'
    echo 'LISTEN     0          4096                        *:80                         *:*         users:(("caddy",pid=1234,fd=9))'
    ;;
esac
case "$MODE" in
  tailscaled|both)
    echo 'LISTEN     0          4096            100.101.102.103:443                       *:*         users:(("tailscaled",pid=987,fd=21))'
    echo 'LISTEN     0          4096      [fd7a:115c:a1e0::1]:443                         *:*         users:(("tailscaled",pid=987,fd=22))'
    ;;
esac
exit 0
