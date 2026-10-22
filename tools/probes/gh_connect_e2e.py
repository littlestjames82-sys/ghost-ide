#!/usr/bin/env python3
"""End-to-end: GitHub-connect endpoints vs a local bare
remote. Clone, remote read, commit, push (with dummy
token through askpass), upstream commit, pull, fetch."""
import json, os, pathlib, shutil, subprocess, sys, time
import urllib.request

BASE = pathlib.Path("/tmp/ghtest")
SRV = pathlib.Path(__file__).parents[2] / "server.py"
ok = fail = 0
def check(cond, label, extra=""):
    global ok, fail
    if cond: ok += 1; print("  PASS", label)
    else: fail += 1; print("  FAIL", label, extra)

def sh(args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True,
                          text=True)

def call(port, path, payload=None, method=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        method = "POST"
    req = urllib.request.Request(url, data=data, method=method or "GET",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=320) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

def start_server(ws, port):
    env = dict(os.environ, GHOST_IDE_WORKSPACE=str(ws),
               GHOST_IDE_PORT=str(port))
    log = open(BASE / f"server-{port}.log", "wb")
    p = subprocess.Popen([sys.executable, str(SRV)], env=env,
                         stdout=log, stderr=log)
    last = None
    for _ in range(150):
        time.sleep(0.2)
        if p.poll() is not None:
            break
        try:
            call(port, "/api/git/status"); return p
        except Exception as e:
            last = e
            continue
    log.flush()
    tail = (BASE / f"server-{port}.log").read_text(
        errors="replace")[-1500:]
    raise RuntimeError(
        "server did not start on " + str(port)
        + f" (exit={p.poll()}, last poll error={last!r})\n"
        + tail)

def main():
    shutil.rmtree(BASE, ignore_errors=True)
    BASE.mkdir(parents=True)
    bare = BASE / "remote.git"
    sh(["git", "init", "--bare", "-b", "main", str(bare)])
    seed = BASE / "seed"; seed.mkdir()
    sh(["git", "init", "-b", "main", str(seed)])
    sh(["git", "-C", str(seed), "config", "user.email", "t@t.t"])
    sh(["git", "-C", str(seed), "config", "user.name", "T"])
    (seed / "hello.txt").write_text("hello v1\n")
    sh(["git", "-C", str(seed), "add", "."])
    sh(["git", "-C", str(seed), "commit", "-m", "seed one"])
    sh(["git", "-C", str(seed), "remote", "add", "origin", str(bare)])
    r = sh(["git", "-C", str(seed), "push", "origin", "main"])
    check(r.returncode == 0, "seed pushed to bare", r.stderr)

    # Workspace A: clone through the endpoint.
    wsA = BASE / "wsA"; wsA.mkdir()
    srvA = start_server(wsA, 5210)
    try:
        d = call(5210, "/api/git/clone", {"url": str(bare)})
        check(d.get("ok") is True and d.get("dir") == "remote",
              "clone endpoint returns dir", str(d))
        check((wsA / "remote" / "hello.txt").read_text() == "hello v1\n",
              "cloned file content matches")
        d = call(5210, "/api/git/clone",
                 {"url": str(bare), "dir": "remote"})
        check("error" in d, "clone into non-empty dir refused", str(d))
    finally:
        srvA.terminate()

    # Workspace B: a working clone; push and pull.
    wsB = BASE / "wsB"
    r = sh(["git", "clone", str(bare), str(wsB)])
    check(r.returncode == 0, "manual clone for wsB", r.stderr)
    sh(["git", "-C", str(wsB), "config", "user.email", "t@t.t"])
    sh(["git", "-C", str(wsB), "config", "user.name", "T"])
    srvB = start_server(wsB, 5211)
    try:
        d = call(5211, "/api/git/remote")
        check(d.get("repo") is True and d["remotes"]
              and d["remotes"][0]["name"] == "origin"
              and d["remotes"][0]["url"] == str(bare),
              "remote GET lists origin", str(d))
        (wsB / "hello.txt").write_text("hello v2\n")
        d = call(5211, "/api/git/stage", {"path": "hello.txt"})
        check(d.get("ok") is True, "stage ok", str(d))
        d = call(5211, "/api/git/commit", {"message": "v2 from IDE"})
        check(d.get("ok") is True, "commit ok", str(d))
        d = call(5211, "/api/git/push", {"token": "dummy-token-123"})
        check(d.get("ok") is True, "push with token ok", str(d))
        r = sh(["git", "-C", str(bare), "log", "--oneline", "main"])
        check("v2 from IDE" in r.stdout, "bare remote got the commit",
              r.stdout)
        cfg = (wsB / ".git" / "config").read_text()
        check("dummy-token-123" not in cfg,
              "token NOT written to .git/config")
        ap = pathlib.Path("/tmp/ghostide-askpass.sh")
        check(ap.exists() and "GHOSTIDE_GH_TOKEN" in ap.read_text(),
              "askpass script created outside workspace")
        # Upstream moves; fetch + pull through the endpoints.
        # The seed syncs to the pushed v2 first so its v3
        # is a clean fast-forward.
        sh(["git", "-C", str(seed), "fetch", "origin"])
        r = sh(["git", "-C", str(seed), "reset", "--hard",
                "origin/main"])
        check(r.returncode == 0, "seed synced to v2", r.stderr)
        (seed / "hello.txt").write_text("hello v3\n")
        sh(["git", "-C", str(seed), "commit", "-am", "v3 upstream"])
        r = sh(["git", "-C", str(seed), "push", "origin", "main"])
        check(r.returncode == 0, "seed v3 pushed", r.stderr)
        d = call(5211, "/api/git/fetch", {"token": "dummy-token-123"})
        check(d.get("ok") is True, "fetch ok", str(d))
        d = call(5211, "/api/git/pull", {"token": "dummy-token-123"})
        check(d.get("ok") is True, "pull ok", str(d))
        check((wsB / "hello.txt").read_text() == "hello v3\n",
              "pull brought v3")
        d = call(5211, "/api/git/remote-set",
                 {"name": "origin", "url": str(bare)})
        check(d.get("ok") is True, "remote-set ok", str(d))
        d = call(5211, "/api/git/remote-set",
                 {"name": "-evil", "url": str(bare)})
        check("error" in d, "option-injection name refused", str(d))
    finally:
        srvB.terminate()
    print(f"GH-CONNECT E2E: {ok} passed, {fail} failed")
    return 1 if fail else 0

if __name__ == "__main__":
    sys.exit(main())
