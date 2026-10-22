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
mod.PAIR_TOKENS[tok] = ("editor", time.time())
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



# --- R12 role matrix on the real gate helpers ---
vtok = "cafe" * 8
mod.PAIR_TOKENS[vtok] = ("viewer", time.time())
hv = fake_handler(LAN, vtok)
check(hv._pair_gate("/api/file") is True,
      "viewer: token still admitted by the gate")
check(hv._pair_role_denied("/api/file") is True,
      "viewer: mutating POST denied")
check(hv._pair_role_denied("/api/pair/heartbeat") is False,
      "viewer: heartbeat allowed")
check(h2._pair_role_denied("/api/file") is False,
      "editor: mutating POST allowed")
hl = fake_handler("127.0.0.1", vtok)
check(hl._pair_role_denied("/api/file") is False,
      "loopback: never role-denied")

# --- rate limit helpers (R1) ---
mod.PAIR_FAILS.clear()
ip = "203.0.113.9"
for i in range(4):
    mod.pair_join_record(ip, False, 1000.0 + i)
check(not mod.pair_join_locked(ip, 1004.0),
      "4 wrong codes: not locked yet")
mod.pair_join_record(ip, False, 1005.0)
check(mod.pair_join_locked(ip, 1006.0),
      "5th wrong code locks the source")
check(mod.pair_join_locked(ip, 1005.0 + 599),
      "lock holds inside the window")
check(not mod.pair_join_locked(ip, 1005.0 + 601),
      "lock expires after the lock period")
mod.pair_join_record(ip, True, 2000.0)
check(not mod.pair_join_locked(ip, 2001.0)
      and ip not in mod.PAIR_FAILS,
      "a successful join clears the record")
for i in range(5):
    mod.pair_join_record("198.51.100.2", False, 0.0)
check(not mod.pair_join_locked("198.51.100.2", 10000.0),
      "stale window does not lock later")

# --- v2.32: token TTL + revoke on the real helpers ---
now0 = time.time()
ttok = "beef" * 8
mod.PAIR_TOKENS[ttok] = ("editor", now0)
check(mod.pair_token_valid(ttok, now0 + 60),
      "TTL: fresh token valid")
check(not mod.pair_token_valid(
        ttok, now0 + mod.PAIR_TOKEN_TTL + 1),
      "TTL: token past 12h refused")
check(ttok not in mod.PAIR_TOKENS,
      "TTL: expired token forgotten")
check(not mod.pair_token_valid("nosuch", now0),
      "TTL: unknown token refused")
otok = "f00d" * 8
mod.PAIR_TOKENS[otok] = ("viewer",
                         now0 - mod.PAIR_TOKEN_TTL - 5)
ho = fake_handler(LAN, otok)
check(ho._pair_gate("/api/file") is False,
      "TTL: expired token fails the gate")
check(ho._pair_role_denied("/api/file") is False,
      "TTL: expired viewer is not role-denied "
      "(the gate refuses it first)")
rtok = "aa" * 16
mod.PAIR_TOKENS[rtok] = ("editor", time.time())
hr = fake_handler(LAN, rtok)
hr._pair_revoke()
check(hr._sent.get("status") == 403
      and rtok in mod.PAIR_TOKENS,
      "revoke: LAN refused, tokens intact")
hh = fake_handler("127.0.0.1")
hh._pair_revoke()
check(hh._sent.get("status") == 200
      and hh._sent["obj"].get("ok") is True
      and len(mod.PAIR_TOKENS) == 0,
      "revoke: host clears every guest token")

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

    # live lockout: 5 wrong joins, then even the
    # right code is refused with 429
    def join(code):
        data = json.dumps({"code": code}).encode()
        r = urllib.request.Request(
            "http://127.0.0.1:5271/api/pair/join", data=data,
            method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, json.loads(
                    resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(
                e.read().decode() or "{}")
    # R12 live: policy roundtrip + join roles
    def policy(method="GET", vo=None):
        data = json.dumps({"viewOnly": vo}).encode() \
            if vo is not None else None
        r = urllib.request.Request(
            "http://127.0.0.1:5271/api/pair/policy",
            data=data, method=method,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, json.loads(
                    resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(
                e.read().decode() or "{}")
    stp, dp = policy()
    check(stp == 200 and dp.get("viewOnly") is False,
          "policy defaults to editors", str(dp))
    stp, dp = policy("POST", True)
    check(dp.get("viewOnly") is True,
          "host flips policy to view-only", str(dp))
    stj, dj = join(str(d.get("code")))
    check(dj.get("role") == "viewer",
          "new token under policy is a viewer", str(dj))
    policy("POST", False)
    stj, dj = join(str(d.get("code")))
    check(dj.get("role") == "editor",
          "policy off: new token is an editor", str(dj))
    def revoke():
        r = urllib.request.Request(
            "http://127.0.0.1:5271/api/pair/revoke",
            data=b"{}", method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, json.loads(
                    resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(
                e.read().decode() or "{}")
    strv, drv = revoke()
    check(strv == 200 and drv.get("ok") is True,
          "live loopback: revoke-all answers ok",
          str(drv))
    wrong = "000000" if str(d.get("code")) != "000000" else "111111"
    codes = [join(wrong)[0] for _ in range(5)]
    check(codes == [401] * 5, "5 wrong joins get 401", str(codes))
    st2, d2 = join(str(d.get("code")))
    check(st2 == 429, "6th join (right code) is locked out",
          f"{st2} {d2}")

finally:
    p.terminate()
print(f"PAIR PROBES: {ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
