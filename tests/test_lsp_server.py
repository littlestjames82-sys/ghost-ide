#!/usr/bin/env python3
"""HTTP integration tests for LSP (Desktop Cycle 2, D4)
against a real server subprocess, with the fake language
server fixture injected through GHOSTIDE_LSP_PYTHON_CMD:

- /api/lsp/status answers without spawning anything
- /api/lsp/open runs the full round trip: spawn,
  initialize, didOpen, published diagnostics readable
  over /api/lsp/diagnostics
- hover / definition / completion answer over HTTP,
  with definition normalised to workspace-relative jumps
- an untrusted workspace gets 403 workspace-untrusted
  from the LSP routes and nothing spawns

The copied-tree setup mirrors tests/test_server_cycle1.py
so the repo and the real home dir are never touched.
"""
import http.server
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
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURE = REPO / "tests" / "fixtures" / "fake_lsp_server.py"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def call(port, method, path, body=None, timeout=15):
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path), method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data,
                                    timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


class StubLlama(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        out = json.dumps({"status": "ok"}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        out = json.dumps({"choices": [{"message": {
            "role": "assistant", "content": "ok"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


class LspServerCase(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp(prefix="ghostide-lsp-http-"))
        self.app = self.td / "app"
        self.app.mkdir()
        for f in ("server.py", "ghost_paths.py", "updater.py",
                  "workspace_trust.py", "lsp_manager.py", "embed_index.py",
                  "debug_bridge.py", "VERSION.json"):
            shutil.copy(REPO / f, self.app / f)
        (self.app / "web").mkdir()
        (self.app / "web" / "index.html").write_text("<html></html>")
        (self.app / "playground").mkdir()
        self.ws = self.td / "ws"
        self.ws.mkdir()
        (self.ws / "a.py").write_text("abc = 1\nprint(abc)\n")
        self.count_file = self.td / "starts.txt"
        self.llama_port = free_port()
        self.llama = http.server.ThreadingHTTPServer(
            ("127.0.0.1", self.llama_port), StubLlama)
        threading.Thread(target=self.llama.serve_forever,
                         daemon=True).start()
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            p.terminate()
            try:
                p.wait(timeout=5)
            except Exception:
                p.kill()
        self.llama.shutdown()
        shutil.rmtree(self.td, ignore_errors=True)

    def start_server(self, extra_env):
        port = free_port()
        env = dict(os.environ)
        env.update({
            "HOME": str(self.td / "home"),
            "GHOST_IDE_PORT": str(port),
            "GHOST_IDE_WORKSPACE": str(self.ws),
            "LLAMA_BASE": "http://127.0.0.1:%d" % self.llama_port,
            "GHOSTIDE_LSP_PYTHON_CMD":
                "%s %s" % (sys.executable, FIXTURE),
            "FAKE_LSP_COUNT_FILE": str(self.count_file),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        env.update(extra_env)
        proc = subprocess.Popen(
            [sys.executable, str(self.app / "server.py")],
            cwd=str(self.app), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True)
        self.procs.append(proc)
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                st, _ = call(port, "GET", "/api/health", timeout=2)
                if st == 200:
                    return port
            except Exception:
                pass
            if proc.poll() is not None:
                raise AssertionError(
                    "server exited early:\n" + proc.stdout.read())
            time.sleep(0.2)
        raise AssertionError("server did not come up")

    def starts(self):
        try:
            return len(self.count_file.read_text().splitlines())
        except OSError:
            return 0

    def test_lsp_round_trip_over_http(self):
        port = self.start_server({})
        st, health = call(port, "GET", "/api/health")
        self.assertEqual(health["version"], "3.25.0")
        self.assertIn("lsp", health)

        # Status is read-only: nothing has spawned yet.
        st, status = call(port, "GET", "/api/lsp/status")
        self.assertEqual(st, 200)
        self.assertEqual(status["servers"]["python"]["state"],
                         "stopped")
        self.assertEqual(self.starts(), 0)

        # Open: spawn + initialize + didOpen.
        st, opened = call(port, "POST", "/api/lsp/open", {
            "path": "a.py", "content": "abc = 1\nprint(abc)\n"})
        self.assertEqual(st, 200, opened)
        self.assertEqual(opened["servers"]["python"]["state"],
                         "ready")
        self.assertEqual(self.starts(), 1)

        # The published diagnostic comes back over HTTP.
        deadline = time.time() + 10
        diags = {}
        while time.time() < deadline:
            st, d = call(port, "GET",
                         "/api/lsp/diagnostics?path=a.py")
            diags = d["files"].get("a.py") or []
            if diags:
                break
            time.sleep(0.2)
        self.assertEqual(diags[0]["message"], "fake diagnostic")

        # Hover / definition / completion.
        st, hov = call(port, "POST", "/api/lsp/hover", {
            "path": "a.py", "line": 0, "character": 1})
        self.assertEqual(hov["result"]["contents"]["value"],
                         "fake hover text")
        st, dfn = call(port, "POST", "/api/lsp/definition", {
            "path": "a.py", "line": 1, "character": 7})
        self.assertEqual(dfn["locations"][0]["path"], "a.py")
        self.assertEqual(dfn["locations"][0]["line"], 0)
        st, comp = call(port, "POST", "/api/lsp/completion", {
            "path": "a.py", "line": 0, "character": 3})
        labels = [i["label"] for i in comp["result"]["items"]]
        self.assertEqual(labels, ["fake_alpha", "fake_beta"])
        st, syms = call(port, "POST", "/api/lsp/symbols", {
            "path": "a.py"})
        self.assertEqual(syms["result"][0]["name"],
                         "fake_symbol")

    def test_lsp_trust_gate_over_http(self):
        port = self.start_server({})
        # Switch to a fresh folder: it starts untrusted.
        ws2 = self.td / "ws2"
        ws2.mkdir()
        (ws2 / "b.py").write_text("x = 1\n")
        st, d = call(port, "POST", "/api/workspace",
                     {"path": str(ws2)})
        self.assertEqual(st, 200)
        self.assertFalse(d["trusted"])
        st, d = call(port, "POST", "/api/lsp/open", {
            "path": "b.py", "content": "x = 1\n"})
        self.assertEqual(st, 403)
        self.assertEqual(d.get("code"), "workspace-untrusted")
        self.assertEqual(self.starts(), 0)
        # Trust it (host-local request) and the same call
        # goes through.
        st, d = call(port, "POST", "/api/trust",
                     {"trusted": True})
        self.assertEqual(st, 200)
        st, d = call(port, "POST", "/api/lsp/open", {
            "path": "b.py", "content": "x = 1\n"})
        self.assertEqual(st, 200, d)
        self.assertEqual(self.starts(), 1)


if __name__ == "__main__":
    unittest.main()
