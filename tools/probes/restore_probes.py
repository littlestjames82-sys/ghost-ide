#!/usr/bin/env python3
"""Hostile restore probes (item 11): staged restore
against a live fixture server."""
import importlib.util, io, json, os, pathlib, shutil
import subprocess, sys, time, urllib.request, urllib.error
import zipfile

HERE = pathlib.Path(__file__).parent
BASE = HERE / "ws-restore"
SRV = HERE.parents[1] / "server.py"
ok = fail = 0
def check(cond, label, extra=""):
    global ok, fail
    if cond: ok += 1; print("  PASS", label)
    else: fail += 1; print("  FAIL", label, extra)

os.environ["GHOST_IDE_WORKSPACE"] = str(BASE)
spec = importlib.util.spec_from_file_location("ghostsrv", SRV)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def make_backup(ws, entries, name):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for arc, data in entries:
            z.writestr(arc, data)
    env = mod.backup_encrypt("pw-123", buf.getvalue(),
                             len(entries), buf.tell())
    bk = ws / "backups"; bk.mkdir(exist_ok=True)
    f = bk / name
    f.write_text(env)
    return "backups/" + name

def restore(port, path):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/backup/restore",
        data=json.dumps({"passphrase": "pw-123",
                         "path": path}).encode(),
        method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

def fresh_ws(name):
    ws = BASE / name
    shutil.rmtree(ws, ignore_errors=True)
    ws.mkdir(parents=True)
    return ws

def start(ws, port):
    env = dict(os.environ, GHOST_IDE_WORKSPACE=str(ws),
               GHOST_IDE_PORT=str(port))
    p = subprocess.Popen([sys.executable, str(SRV)], env=env,
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    for _ in range(40):
        time.sleep(0.25)
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/git/status")
            urllib.request.urlopen(req, timeout=3)
            return p
        except Exception:
            continue
    raise RuntimeError("no server")

def main():
    shutil.rmtree(BASE, ignore_errors=True)
    BASE.mkdir(parents=True)

    ws = fresh_ws("normal")
    (ws / "a.txt").write_text("orig A")
    bk = make_backup(ws, [("a.txt", "new A"),
                          ("sub/b.txt", "B!")], "n.ghostbak")
    p = start(ws, 5261)
    try:
        d = restore(5261, bk)
        check(d.get("ok") is True and d.get("staged") is True,
              "normal restore ok + staged", str(d))
        check((ws / "a.txt").read_text() == "new A",
              "a.txt overwritten with backup content")
        check((ws / "sub" / "b.txt").read_text() == "B!",
              "nested file restored")
        check(not (ws / ".ghostide-restore").exists(),
              "staging area cleaned up")
    finally: p.terminate()

    ws = fresh_ws("trav")
    bk = make_backup(ws, [("../../evil.txt", "x"),
                          ("good.txt", "g")], "t.ghostbak")
    p = start(ws, 5262)
    try:
        d = restore(5262, bk)
        check(d.get("ok") is True, "traversal backup restores", str(d))
        check(not (BASE / "evil.txt").exists()
              and not (BASE.parent / "evil.txt").exists(),
              "nothing written outside the workspace")
        check((ws / "good.txt").read_text() == "g",
              "good entry restored")
    finally: p.terminate()

    ws = fresh_ws("bomb")
    (ws / "a.txt").write_text("orig A")
    bk = make_backup(ws, [("a.txt", "CHANGED"),
                          ("big.bin", b"\0" * (201 * 1024 * 1024))],
                     "b.ghostbak")
    p = start(ws, 5263)
    try:
        d = restore(5263, bk)
        check("error" in d and "too large" in d["error"],
              "oversized entry refused", str(d)[:120])
        check((ws / "a.txt").read_text() == "orig A",
              "nothing applied when staging fails (atomic)")
        check(not (ws / "big.bin").exists(), "bomb file absent")
    finally: p.terminate()

    ws = fresh_ws("dup")
    (ws / "d.txt").write_text("orig D")
    bk = make_backup(ws, [("d.txt", "1"), ("d.txt", "2")],
                     "d.ghostbak")
    p = start(ws, 5264)
    try:
        d = restore(5264, bk)
        check("error" in d and "duplicate" in d["error"],
              "duplicate entry refused", str(d)[:120])
        check((ws / "d.txt").read_text() == "orig D",
              "original kept after duplicate refusal")
    finally: p.terminate()

    ws = fresh_ws("rollback")
    (ws / "b.txt").write_text("orig B")
    (ws / "c").write_text("i am a file, not a folder")
    bk = make_backup(ws, [("b.txt", "NEW B"),
                          ("c/d.txt", "x")], "r.ghostbak")
    p = start(ws, 5265)
    try:
        d = restore(5265, bk)
        check("error" in d and "rolled back" in d["error"],
              "apply failure reports rollback", str(d)[:140])
        check((ws / "b.txt").read_text() == "orig B",
              "earlier file rolled back to original")
        check((ws / "c").read_text()
              == "i am a file, not a folder",
              "blocking file untouched")
    finally: p.terminate()

    print(f"RESTORE PROBES: {ok} passed, {fail} failed")
    return 1 if fail else 0

if __name__ == "__main__":
    sys.exit(main())
