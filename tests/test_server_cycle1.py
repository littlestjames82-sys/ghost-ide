#!/usr/bin/env python3
"""Integration tests for Desktop Cycle 1 against a real
server subprocess (a copied tree in a temp dir, so the
repo and the real home dir are never touched):

- startup workspace is auto-trusted; a folder opened
  later starts untrusted
- while untrusted, terminal / run / MCP calls are 403
  at the API layer; after POST /api/trust they work
- AGENTS.md loads, .ghostide/AGENTS.md overrides, and
  the text lands in the system message the model sees
  (captured by a stub llama.cpp)
- /api/update/check follows the desktop train of
  VERSION.json, not the phone's "latest"
- portable mode: workspace + trust store land inside
  ghostide-data/ beside the app
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


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def call(port, method, path, body=None, timeout=10):
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
    captured = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        StubLlama.captured.append(json.loads(body.decode()))
        out = json.dumps({"choices": [{"message": {
            "role": "assistant", "content": "ok"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        out = json.dumps({"status": "ok"}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp(prefix="ghostide-c1-"))
        self.app = self.td / "app"
        self.app.mkdir()
        for f in ("server.py", "ghost_paths.py", "updater.py",
                  "workspace_trust.py", "lsp_manager.py", "embed_index.py",
                  "debug_bridge.py", "VERSION.json"):
            shutil.copy(REPO / f, self.app / f)
        (self.app / "web").mkdir()
        (self.app / "web" / "index.html").write_text("<html></html>")
        (self.app / "playground").mkdir()
        (self.app / "playground" / "hello.txt").write_text("seeded")
        self.llama_port = free_port()
        self.llama = http.server.ThreadingHTTPServer(
            ("127.0.0.1", self.llama_port), StubLlama)
        threading.Thread(target=self.llama.serve_forever,
                         daemon=True).start()
        StubLlama.captured = []
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
            "LLAMA_BASE": "http://127.0.0.1:%d" % self.llama_port,
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

    def test_trust_instructions_and_update_feed(self):
        ws1 = self.td / "ws1"
        ws1.mkdir()
        feed = self.td / "feed.json"
        feed.write_text(json.dumps({
            "version": "1.0.0", "latest": "3.10.1",
            "desktop": {"version": "3.21.0"}}))
        port = self.start_server({
            "GHOST_IDE_WORKSPACE": str(ws1),
            "GHOST_IDE_UPDATE_URL": "file://" + str(feed)})
        st, health = call(port, "GET", "/api/health")
        self.assertEqual(health["version"], "3.20.0")
        self.assertTrue(health["trusted"])  # startup = trusted
        self.assertFalse(health["portable"])

        # The update check follows the desktop train.
        st, chk = call(port, "GET", "/api/update/check")
        self.assertTrue(chk["ok"])
        self.assertEqual(chk["latest"], "3.21.0")
        self.assertTrue(chk["updateAvailable"])

        # A folder opened later starts untrusted.
        ws2 = self.td / "ws2"
        (ws2 / ".ghostide").mkdir(parents=True)
        (ws2 / "AGENTS.md").write_text("root rules")
        (ws2 / ".ghostide" / "AGENTS.md").write_text(
            "private rules")
        st, d = call(port, "POST", "/api/workspace",
                     {"path": str(ws2)})
        self.assertEqual(st, 200)
        self.assertFalse(d["trusted"])
        st, t = call(port, "GET", "/api/trust")
        self.assertFalse(t["trusted"])
        self.assertIsNone(t["decision"])

        # Execution routes are refused at the API layer.
        for route, body in (
                ("/api/terminal", {"command": "echo hi"}),
                ("/api/run", {"path": "x.py"}),
                ("/api/mcp/call", {"name": "x", "args": {}}),
                ("/api/tests/run", {})):
            st, d = call(port, "POST", route, body)
            self.assertEqual(st, 403, route)
            self.assertEqual(d.get("code"), "workspace-untrusted")

        # Instructions: the override wins, and it reaches
        # the model's system context.
        st, ins = call(port, "GET", "/api/instructions")
        self.assertEqual([f["rel"] for f in ins["files"]],
                         [".ghostide/AGENTS.md"])
        st, _ = call(port, "POST", "/api/chat", {
            "messages": [{"role": "system",
                          "content": "base prompt"},
                         {"role": "user", "content": "hi"}]})
        self.assertEqual(st, 200)
        sent = StubLlama.captured[-1]["messages"]
        self.assertIn("base prompt", sent[0]["content"])
        self.assertIn("private rules", sent[0]["content"])
        self.assertNotIn("root rules", sent[0]["content"])

        # Trust it: execution opens up, decision persists.
        st, d = call(port, "POST", "/api/trust",
                     {"trusted": True})
        self.assertTrue(d["trusted"])
        st, d = call(port, "POST", "/api/terminal",
                     {"command": "echo cycle1-ok"})
        self.assertEqual(st, 200)
        self.assertIn("cycle1-ok", d["stdout"])
        store = json.loads((self.td / "home" / ".ghostide"
                            / "trusted-workspaces.json")
                           .read_text())
        self.assertTrue(store["workspaces"][str(ws2)]["trusted"])

    def test_portable_mode_layout(self):
        port = self.start_server({"GHOSTIDE_PORTABLE": "1"})
        st, health = call(port, "GET", "/api/health")
        self.assertTrue(health["portable"])
        data = self.app / "ghostide-data"
        self.assertEqual(health["workspace"],
                         str(data / "workspace"))
        self.assertTrue((data / "workspace" / "hello.txt")
                        .is_file())  # seeded from playground
        self.assertTrue(
            (data / "trusted-workspaces.json").is_file())
        self.assertTrue(health["trusted"])


if __name__ == "__main__":
    unittest.main()
