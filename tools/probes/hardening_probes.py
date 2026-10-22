#!/usr/bin/env python3
"""Hardening probes (v2.09): server.py backup bounds
unit-level + live traversal / body-cap checks."""
import importlib.util, json, os, pathlib, subprocess, sys
import time, urllib.request, urllib.error

HERE = pathlib.Path(__file__).parent
FIX = HERE / "eco-fixture"
SRV = HERE.parents[1] / "server.py"
ok = fail = 0
def check(cond, label, extra=""):
    global ok, fail
    if cond: ok += 1; print("  PASS", label)
    else: fail += 1; print("  FAIL", label, extra)

# --- unit: backup functions ---
os.environ["GHOST_IDE_WORKSPACE"] = str(FIX)
spec = importlib.util.spec_from_file_location("ghostsrv", SRV)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

zip_bytes = b"PK\x03\x04" + bytes(range(256)) * 8
env_text = mod.backup_encrypt("pw-123", zip_bytes, 2, len(zip_bytes))
env = json.loads(env_text)
check(env["v"] in (1, 2), "encrypt writes v1 or v2", str(env["v"]))
check(mod.backup_decrypt("pw-123", env_text) == zip_bytes,
      "backup roundtrip")
try:
    mod.backup_decrypt("wrong", env_text)
    check(False, "wrong passphrase rejected")
except ValueError as e:
    check("integrity" in str(e), "wrong passphrase rejected", str(e))
hostile = json.loads(env_text)
hostile["kdf"]["iter"] = 999999999
t0 = time.time()
try:
    mod.backup_decrypt("pw-123", json.dumps(hostile))
    check(False, "hostile iter rejected")
except ValueError as e:
    check("out of bounds" in str(e) and time.time() - t0 < 2,
          "hostile iter rejected fast on bounds", str(e))
low = json.loads(env_text)
low["kdf"]["iter"] = 100
try:
    mod.backup_decrypt("pw-123", json.dumps(low))
    check(False, "too-low iter rejected")
except ValueError as e:
    check("out of bounds" in str(e), "too-low iter rejected", str(e))
# a v2-shaped envelope in an env without the crypto lib
# must fail with the clear guidance error (or decrypt
# fine where the lib exists)
v2shape = {"app": "ghostide-backup", "v": 2,
           "cipher": "AES-256-GCM",
           "kdf": {"algo": "PBKDF2-HMAC-SHA256", "iter": 200000,
                   "salt": "AAAAAAAAAAAAAAAAAAAAAA=="},
           "iv": "AAAAAAAAAAAAAAAA",
           "data": "AAAAAAAAAAAAAAAAAAAAAA=="}
try:
    mod.backup_decrypt("pw-123", json.dumps(v2shape))
    check(mod._aesgcm() is not None,
          "v2 envelope handled (lib present)")
except ValueError as e:
    check("cryptography" in str(e) or "integrity" in str(e),
          "v2 envelope: clear error without lib", str(e))

# --- live: traversal + body cap ---
env2 = dict(os.environ, GHOST_IDE_WORKSPACE=str(FIX),
            GHOST_IDE_PORT="5251")
p = subprocess.Popen([sys.executable, str(SRV)], env=env2,
                     stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL)
def get(path):
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:5251" + path, timeout=10) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:
        return 0, str(e)
try:
    for _ in range(40):
        time.sleep(0.25)
        st, _b = get("/api/git/status")
        if st: break
    for probe in ("/api/file?path=../../etc/passwd",
                  "/api/file?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd",
                  "/api/file?path=/etc/passwd"):
        st, body = get(probe)
        check("root:" not in body and st != 200 or "root:" not in body,
              "traversal refused: " + probe[:44], f"st={st}")
    # oversized: declare a 65 MiB body (the cap inspects
    # the declared length and refuses before reading)
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", 5251,
                                      timeout=15)
    conn.putrequest("POST", "/api/search")
    conn.putheader("Content-Type", "application/json")
    conn.putheader("Content-Length", str(64 * 1024 * 1024 + 1))
    conn.endheaders(b"{}")
    resp = conn.getresponse()
    body = resp.read().decode(errors="replace")
    st = resp.status
    conn.close()
    check("too large" in body, "65MiB body refused with cap error",
          f"st={st} body={body[:80]}")
    # a normal small request still works
    req = urllib.request.Request(
        "http://127.0.0.1:5251/api/search",
        data=json.dumps({"query": "import"}).encode(),
        method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        d = json.loads(r.read().decode())
    check("matches" in d, "normal POST still works")
finally:
    p.terminate()
print(f"HARDENING PROBES: {ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
