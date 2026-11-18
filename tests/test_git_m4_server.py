#!/usr/bin/env python3
"""Tests for Mobile Cycle 2 M4 (git phone pack) against
a REAL git remote that requires the token.

The fixture is a local HTTP git remote (git
http-backend behind a Basic-auth check): the only
acceptable credential is the password TOKEN, with the
username x-access-token - exactly the shape the app's
askpass answers with. Against a real server.py
subprocess this proves, end to end:

- clone with no token and with a wrong token fails
  honestly; clone with the stored-token equivalent
  (the request token, desktop-style) succeeds;
- the default clone is shallow (exactly 1 commit of
  history) and full=True clones the whole history;
- commit + push from the shallow clone works with
  the token and fails without it; pull brings a new
  remote commit down;
- the token string appears NOWHERE it must not: not
  in the cloned .git/config, not anywhere in the
  workspace tree, and not in the server's own output.

The Android half of M4 (Keystore storage, host-keyed
in-process resolution) is proven by the JVM GtTest
suite; the wire protocol and the git arguments are
the same ones GitSupport builds on the phone.
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

REPO = Path(__file__).resolve().parent.parent
TOKEN = "ghp_M4FIXTURE_0123456789abcdef"
COMMITS = 5


def git(cwd, *args, ok=True, env=None):
    e = dict(os.environ)
    e.update({"GIT_CONFIG_NOSYSTEM": "1",
              "GIT_AUTHOR_NAME": "T",
              "GIT_AUTHOR_EMAIL": "t@t.t",
              "GIT_COMMITTER_NAME": "T",
              "GIT_COMMITTER_EMAIL": "t@t.t"})
    if env:
        e.update(env)
    r = subprocess.run(["git"] + list(args), cwd=str(cwd),
                       capture_output=True, text=True, env=e)
    if ok and r.returncode != 0:
        raise AssertionError("git %s failed: %s"
                             % (args, r.stderr))
    return r


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def call(port, method, path, body=None, timeout=120):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path),
        data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


class GitAuthHandler(BaseHTTPRequestHandler):
    """Serves git http-backend only to requests whose
    Basic credentials are x-access-token : TOKEN."""
    project_root = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _auth_ok(self):
        want = "Basic " + base64.b64encode(
            ("x-access-token:" + TOKEN).encode()).decode()
        return self.headers.get("Authorization") == want

    def _handle(self):
        if not self._auth_ok():
            self.send_response(401)
            self.send_header("WWW-Authenticate",
                             'Basic realm="git"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length")
                     or 0)
        body = self.rfile.read(length) if length else b""
        env = {
            "PATH": os.environ.get("PATH", ""),
            "GIT_PROJECT_ROOT": self.project_root,
            "GIT_HTTP_EXPORT_ALL": "1",
            "PATH_INFO": parsed.path,
            "QUERY_STRING": parsed.query,
            "REQUEST_METHOD": self.command,
            "CONTENT_TYPE":
                self.headers.get("Content-Type", ""),
            "REMOTE_USER": "x-access-token",
            "REMOTE_ADDR": "127.0.0.1",
        }
        p = subprocess.run(["git", "http-backend"],
                           input=body, capture_output=True,
                           env=env)
        out = p.stdout
        sep = out.find(b"\r\n\r\n")
        hlen = 4
        if sep < 0:
            sep = out.find(b"\n\n")
            hlen = 2
        head = out[:sep].decode("utf-8", "replace")
        payload = out[sep + hlen:]
        status = 200
        headers = {}
        for ln in head.replace("\r\n", "\n").split("\n"):
            if ":" not in ln:
                continue
            k, v = ln.split(":", 1)
            if k.strip().lower() == "status":
                status = int(v.strip().split()[0])
            else:
                headers[k.strip()] = v.strip()
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    do_GET = _handle
    do_POST = _handle


class GitPhonePackServerCase(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp(
            prefix="ghostide-m4-"))
        # The remote: a working repo with COMMITS commits,
        # published as a bare repo under the fixture root.
        seed = self.td / "seed"
        seed.mkdir()
        git(seed, "init", "-q", "-b", "main", ".")
        for i in range(1, COMMITS + 1):
            (seed / "file.txt").write_text(
                "line %d\n" % i)
            git(seed, "add", "-A")
            git(seed, "commit", "-qm", "commit %d" % i)
        self.root = self.td / "www"
        self.root.mkdir()
        git(self.td, "clone", "-q", "--bare",
            str(seed), str(self.root / "repo.git"))
        git(self.root / "repo.git", "config",
            "http.receivepack", "true")
        GitAuthHandler.project_root = str(self.root)
        self.httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0), GitAuthHandler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever,
                         daemon=True).start()
        self.url = "http://127.0.0.1:%d/repo.git" % (
            self.httpd.server_address[1],)
        # The IDE workspace the server subprocess serves.
        self.ws = self.td / "ws"
        self.ws.mkdir()
        self.port = None
        self.proc = None

    def tearDown(self):
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except Exception:
                self.proc.kill()
        self.httpd.shutdown()
        shutil.rmtree(self.td, ignore_errors=True)

    def start_server(self):
        port = free_port()
        env = dict(os.environ)
        env.update({
            "HOME": str(self.td / "home"),
            "GHOST_IDE_PORT": str(port),
            "GHOST_IDE_WORKSPACE": str(self.ws),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        (self.td / "home").mkdir(exist_ok=True)
        self.log = open(self.td / "server.log", "wb")
        self.proc = subprocess.Popen(
            [sys.executable, str(REPO / "server.py")],
            cwd=str(REPO), env=env,
            stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                st, _ = call(port, "GET", "/api/health",
                             timeout=2)
                if st == 200:
                    self.port = port
                    return
            except Exception:
                pass
            if self.proc.poll() is not None:
                raise AssertionError("server exited early")
            time.sleep(0.2)
        raise AssertionError("server did not come up")

    def test_clone_auth_and_depth(self):
        self.start_server()
        st, r = call(self.port, "POST", "/api/git/clone",
                     {"url": self.url, "dir": "noauth"})
        self.assertIn("error", r,
                      "clone without a token must fail")
        st, r = call(self.port, "POST", "/api/git/clone",
                     {"url": self.url, "dir": "wrongtok",
                      "token": "ghp_WRONG"})
        self.assertIn("error", r,
                      "clone with a wrong token must fail")
        st, r = call(self.port, "POST", "/api/git/clone",
                     {"url": self.url, "dir": "shallow",
                      "token": TOKEN})
        self.assertNotIn("error", r, r)
        cloned = self.ws / "shallow"
        n = git(cloned, "rev-list", "--count",
                "HEAD").stdout.strip()
        self.assertEqual(n, "1",
                         "default clone keeps 1 commit")
        self.assertTrue((cloned / ".git" / "shallow")
                        .is_file())
        cfg = (cloned / ".git" / "config").read_text()
        self.assertIn(self.url, cfg)
        self.assertNotIn(TOKEN, cfg)
        st, r = call(self.port, "POST", "/api/git/clone",
                     {"url": self.url, "dir": "full",
                      "token": TOKEN, "full": True})
        self.assertNotIn("error", r, r)
        n = git(self.ws / "full", "rev-list", "--count",
                "HEAD").stdout.strip()
        self.assertEqual(n, str(COMMITS),
                         "full clone keeps all history")

    def test_push_pull_cycle_and_token_absence(self):
        # The workspace itself is a shallow clone of the
        # fixture, made the way the app makes it: token
        # via askpass env, never in the URL or config.
        askpass = self.td / "askpass.sh"
        askpass.write_text(
            "#!/bin/sh\ncase \"$1\" in\n"
            "*Username*) echo \"x-access-token\" ;;\n"
            "*) echo \"$GHOSTIDE_GH_TOKEN\" ;;\nesac\n")
        askpass.chmod(0o700)
        git(self.td, "clone", "-q", "--depth", "1",
            "--single-branch", self.url, str(self.ws),
            env={"GIT_ASKPASS": str(askpass),
                 "GHOSTIDE_GH_TOKEN": TOKEN,
                 "GIT_TERMINAL_PROMPT": "0"})
        git(self.ws, "config", "user.email", "t@t.t")
        git(self.ws, "config", "user.name", "T")
        self.start_server()
        (self.ws / "file.txt").write_text("line pushed\n")
        st, r = call(self.port, "POST", "/api/git/stage",
                     {"path": "file.txt"})
        self.assertNotIn("error", r, r)
        st, r = call(self.port, "POST", "/api/git/commit",
                     {"message": "phone commit"})
        self.assertNotIn("error", r, r)
        st, r = call(self.port, "POST", "/api/git/push", {})
        self.assertIn("error", r,
                      "push without a token must fail")
        st, r = call(self.port, "POST", "/api/git/push",
                     {"token": "ghp_WRONG"})
        self.assertIn("error", r,
                      "push with a wrong token must fail")
        st, r = call(self.port, "POST", "/api/git/push",
                     {"token": TOKEN})
        self.assertNotIn("error", r, r)
        remote_head = git(self.root / "repo.git",
                          "log", "-1", "--format=%s",
                          "main").stdout.strip()
        self.assertEqual(remote_head, "phone commit")
        # Advance the remote elsewhere; pull must bring
        # it down with the token.
        other = self.td / "other"
        git(self.td, "clone", "-q", self.url, str(other),
            env={"GIT_ASKPASS": str(askpass),
                 "GHOSTIDE_GH_TOKEN": TOKEN,
                 "GIT_TERMINAL_PROMPT": "0"})
        (other / "file.txt").write_text("line pulled\n")
        git(other, "commit", "-qam", "remote advance")
        git(other, "push", "-q",
            env={"GIT_ASKPASS": str(askpass),
                 "GHOSTIDE_GH_TOKEN": TOKEN,
                 "GIT_TERMINAL_PROMPT": "0"})
        st, r = call(self.port, "POST", "/api/git/pull",
                     {"token": TOKEN})
        self.assertNotIn("error", r, r)
        self.assertEqual(
            (self.ws / "file.txt").read_text(),
            "line pulled\n")
        # The token appears nowhere it must not.
        self.proc.terminate()
        self.proc.wait(timeout=10)
        self.proc = None
        self.log.close()
        log_text = (self.td / "server.log").read_text(
            errors="replace")
        self.assertNotIn(TOKEN, log_text,
                         "token leaked into the server log")
        for f in self.ws.rglob("*"):
            if f.is_file():
                data = f.read_bytes()
                self.assertNotIn(
                    TOKEN.encode(), data,
                    "token leaked into " + str(f))


if __name__ == "__main__":
    unittest.main()
