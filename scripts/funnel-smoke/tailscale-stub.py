#!/usr/bin/env python3
# A scripted `tailscale` for the wizard's Funnel walk-through. Every state the flow can hit, driven
# by env vars, with no real tailscaled anywhere near it. Ported into the repo from the throwaway
# harness the installer-funnel build used, and extended with the two field-failure states.
#
#   TS_BACKEND_INITIAL  Running | NeedsLogin      (NeedsLogin flips to Running 5s after `up` starts)
#   TS_CERT_MODE        ok | fail-then-ok | fail-always
#   TS_FUNNEL_INITIAL   none | foreign            (foreign = a funnel already fronting another port)
#   TS_FUNNEL_BG_MODE   ok | refuse-then-ok
#   TS_PORT             the port `funnel status` claims to serve
#
# The field failure this harness exists for: `funnel --bg` exits 0 and `funnel status` shows the
# entry while NO socket is bound (another proxy holds :443, tailscaled in kernel-TUN mode) — so the
# socket half is deliberately NOT modelled here. It lives in the `ss` stub, because that is exactly
# the split the real system has: this command reports the CONFIG layer and nothing else.
import sys, os, time

CALLS_LOG = os.environ["CALLS_LOG"]
STATEDIR = os.environ["TS_STATEDIR"]
DNSNAME = os.environ.get("TS_DNSNAME", "testbox.tail1234.ts.net")
BACKEND_INITIAL = os.environ.get("TS_BACKEND_INITIAL", "Running")
CERT_MODE = os.environ.get("TS_CERT_MODE", "ok")
FUNNEL_INITIAL = os.environ.get("TS_FUNNEL_INITIAL", "none")
FUNNEL_BG_MODE = os.environ.get("TS_FUNNEL_BG_MODE", "ok")
PORT = os.environ.get("TS_PORT", "8787")

os.makedirs(STATEDIR, exist_ok=True)
backend_flag = os.path.join(STATEDIR, "backend_running")
up_marker = os.path.join(STATEDIR, "up_marker")
serving_flag = os.path.join(STATEDIR, "serving")
cert_count_f = os.path.join(STATEDIR, "cert_count")
funnel_count_f = os.path.join(STATEDIR, "funnel_count")

if BACKEND_INITIAL == "Running" and not os.path.exists(backend_flag):
    open(backend_flag, "w").close()

with open(CALLS_LOG, "a") as f:
    f.write(f"{sys.argv[0]} {' '.join(sys.argv[1:])}\n")

def incr(path):
    n = 0
    if os.path.exists(path):
        n = int(open(path).read().strip() or "0")
    n += 1
    with open(path, "w") as f:
        f.write(str(n))
    return n

args = sys.argv[1:]

if args[:2] == ["status", "--json"]:
    if os.path.exists(up_marker) and not os.path.exists(backend_flag):
        if time.time() - os.path.getmtime(up_marker) >= 5:
            open(backend_flag, "w").close()
    if os.path.exists(backend_flag):
        print('{"BackendState":"Running","Self":{"DNSName":"%s."}}' % DNSNAME)
    else:
        print('{"BackendState":"NeedsLogin"}')
    sys.exit(0)

elif args[0] == "cert":
    n = incr(cert_count_f)
    if CERT_MODE == "ok":
        sys.exit(0)
    elif CERT_MODE == "fail-then-ok":
        if n < 2:
            sys.stderr.write("500 Internal Server Error: Tailnet xxx.ts.net does not support getting TLS certs\n")
            sys.exit(1)
        sys.exit(0)
    elif CERT_MODE == "fail-always":
        sys.stderr.write("500 Internal Server Error: Tailnet xxx.ts.net does not support getting TLS certs\n")
        sys.exit(1)

elif args[0] == "funnel" and args[1] == "status":
    if os.path.exists(serving_flag) or FUNNEL_INITIAL == "configured":
        print(f"https://{DNSNAME} (Funnel on)")
        print(f"|-- / proxy http://127.0.0.1:{PORT}")
    elif FUNNEL_INITIAL == "foreign":
        print(f"https://{DNSNAME} (Funnel on)")
        print("|-- / proxy http://127.0.0.1:9999")
    sys.exit(0)

elif args[0] == "funnel" and args[1] == "--bg":
    port = args[2]
    n = incr(funnel_count_f)
    if FUNNEL_BG_MODE == "ok":
        open(serving_flag, "w").close()
        print("Available on the internet:")
        print(f"https://{DNSNAME} (Funnel on)")
        print(f"|-- / proxy http://127.0.0.1:{port}")
        sys.exit(0)
    elif FUNNEL_BG_MODE == "refuse-then-ok":
        if n < 2:
            print("Funnel not enabled on your tailnet.")
            print("To enable, visit:")
            print("")
            print("https://login.tailscale.com/f/funnel?node=nTEST1")
            sys.exit(1)
        else:
            open(serving_flag, "w").close()
            print("Available on the internet:")
            print(f"https://{DNSNAME} (Funnel on)")
            print(f"|-- / proxy http://127.0.0.1:{port}")
            sys.exit(0)

elif args[0] == "up":
    print("To authenticate, visit:")
    print("")
    print("\thttps://login.tailscale.com/a/abcdef123456")
    sys.stdout.flush()
    open(up_marker, "w").close()
    try:
        time.sleep(600)
    except KeyboardInterrupt:
        pass
    sys.exit(0)

else:
    sys.exit(0)
