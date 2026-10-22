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


def inspect(port, path, pw="pw-123"):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/backup/inspect",
        data=json.dumps({"passphrase": pw,
                         "path": path}).encode(),
        method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
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


    # R6: inspect reports without touching anything
    ws = fresh_ws("inspect")
    (ws / "a.txt").write_text("orig A")
    bk = make_backup(ws, [("a.txt", "new A"),
                          ("sub/b.txt", "B!")], "i.ghostbak")
    p = start(ws, 5266)
    try:
        d = inspect(5266, bk)
        check(d.get("ok") is True and d.get("files") == 2,
              "inspect: ok + file count", str(d))
        check(d.get("bytes") == 7,
              "inspect: byte total", str(d))
        check(isinstance(d.get("created"), str)
              and d.get("version") in (1, 2),
              "inspect: created + version fields", str(d))
        check((ws / "a.txt").read_text() == "orig A",
              "inspect: workspace untouched")
        check(not (ws / ".ghostide-restore").exists(),
              "inspect: no staging left behind")
        d = inspect(5266, bk, pw="wrong-pw")
        check("error" in d, "inspect: wrong passphrase fails",
              str(d)[:100])
    finally: p.terminate()

    # audit addendum: symlink entries + truncated zip
    ws = fresh_ws("links")
    def make_link_backup(ws):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            info = zipfile.ZipInfo("link.txt")
            info.external_attr = (0o120777 << 16)
            z.writestr(info, "/etc/passwd")
            z.writestr("real.txt", "real")
        env = mod.backup_encrypt("pw-123", buf.getvalue(),
                                 2, buf.tell())
        bk = ws / "backups"; bk.mkdir(exist_ok=True)
        f = bk / "l.ghostbak"
        f.write_text(env)
        return "backups/l.ghostbak"
    bk = make_link_backup(ws)
    p = start(ws, 5267)
    try:
        d = restore(5267, bk)
        check(d.get("ok") is True, "symlink-entry backup restores",
              str(d))
        lf = ws / "link.txt"
        check(lf.is_file() and not lf.is_symlink()
              and lf.read_text() == "/etc/passwd",
              "symlink entry lands as a plain file, not a link")
        # truncated archive: cut the envelope short
        raw_env = (ws / bk).read_text()
        (ws / bk).write_text(raw_env[:len(raw_env) // 2])
        d = restore(5267, bk)
        check("error" in d, "truncated backup refused", str(d)[:100])
        check((ws / "real.txt").read_text() == "real",
              "earlier good restore survives the bad one")
    finally: p.terminate()

    print(f"RESTORE PROBES: {ok} passed, {fail} failed")
    return 1 if fail else 0

if __name__ == "__main__":
    sys.exit(main())
