#!/usr/bin/env python3
"""Pair gate probes (item 12). Live loopback checks
against a real server + the LAN decision matrix run
against the real Handler gate code with a fake
transport (the sandbox denies non-loopback TCP from
agent processes, so socket-level LAN proof is a
device/desktop item - see DEVICE_PASS_V209)."""
import importlib.util, json, os, pathlib, subprocess, sys
import time, urllib.request, urllib.error

HERE = pathlib.Path(__file__).parent
SRV = HERE.parents[1] / "server.py"
FIX = HERE / "ws-pair"
FIX.mkdir(exist_ok=True)
ok = fail = 0
def check(cond, label, extra=""):
    global ok, fail
    if cond: ok += 1; print("  PASS", label)
    else: fail += 1; print("  FAIL", label, extra)

os.environ["GHOST_IDE_WORKSPACE"] = str(FIX)
spec = importlib.util.spec_from_file_location("ghostsrv", SRV)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class FakeHeaders:
    def __init__(self, tok=None):
        self.tok = tok
    def get(self, name, default=None):
        if name == "X-Pair-Token":
            return self.tok
        return default

def fake_handler(ip, token=None):
    h = mod.Handler.__new__(mod.Handler)
    h.client_address = (ip, 50000)
    h.headers = FakeHeaders(token)
    sent = {}
    def send_json(obj, status=200):
        sent["obj"] = obj; sent["status"] = status
        return None
    h.send_json = send_json
    h._sent = sent
    return h

# --- decision matrix on the real gate code ---
LAN = "192.168.1.50"
h = fake_handler(LAN)
check(h._pair_gate("/api/git/status") is False,
      "LAN: API refused without token")
check(h._pair_gate("/api/pair/join") is True,
      "LAN: join endpoint open")
check(h._pair_gate("/") is True
      and h._pair_gate("/app.js") is True,
      "LAN: IDE shell assets open")
tok = "deadbeef" * 4
mod.PAIR_TOKENS.add(tok)
h2 = fake_handler(LAN, token=tok)
check(h2._pair_gate("/api/git/status") is True,
      "LAN: valid token admitted")
h3 = fake_handler(LAN, token="bogus")
check(h3._pair_gate("/api/git/status") is False,
      "LAN: bogus token refused")
h4 = fake_handler("127.0.0.1")
check(h4._pair_gate("/api/git/status") is True,
      "loopback: no token needed")
h5 = fake_handler(LAN, token=tok)
h5._pair_code()
check(h5._sent.get("status") == 403,
      "code endpoint: 403 for LAN even with token",
      str(h5._sent))
h6 = fake_handler("127.0.0.1")
h6._pair_code()
check(h6._sent.get("status") == 200
      and h6._sent["obj"].get("code") == mod.PAIR_CODE,
      "code endpoint: loopback gets the code")

# --- live loopback against a real server ---
env = dict(os.environ, GHOST_IDE_WORKSPACE=str(FIX),
           GHOST_IDE_PORT="5271")
p = subprocess.Popen([sys.executable, str(SRV)], env=env,
                     stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL)
def req(path):
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:5271" + path,
                timeout=10) as r:
            return r.status, json.loads(r.read().decode()
                                        or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")
try:
    for _ in range(40):
        time.sleep(0.25)
        st, _ = req("/api/git/status")
        if st: break
    st, d = req("/api/git/status")
    check(st == 200, "live loopback: API works", str(st))
    st, d = req("/api/pair/code")
    check(st == 200 and len(str(d.get("code", ""))) == 6,
          "live loopback: 6-digit code served", str(d))
finally:
    p.terminate()
print(f"PAIR PROBES: {ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
