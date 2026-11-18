#!/usr/bin/env python3
"""Integration tests for Desktop Cycle 3 D6 (model
store) against a real server subprocess (a copied tree
in a temp dir, the test_embed_server pattern):

- GET /api/models/store: the catalog cards carry the
  pinned sizes from MODEL_CATALOG (no drift), the
  embedding card is present, machine and disk blocks
  are shaped as documented
- a stub GGUF (header + padding; it is NOT a runnable
  model and this test never asks the loader to run it)
  imports from a local path, appears in the store and
  in the picker's data (/api/model/info) after Set
  active, which the switch path accepts
- a non-GGUF file is refused with the reason and
  registers nothing
- a URL import against a local fixture server
  completes, records the SHA-256 of the served bytes
  and is labelled source "url"
- a slow-drip URL import can be cancelled over HTTP:
  the state returns to idle and the .part file goes
- delete removes an imported model's file and registry
  entry, and deleting the active (not loaded) model
  resets the picker
"""
import hashlib
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
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STUB = b"GGUF" + b"s" * 4096
STUB_SHA = hashlib.sha256(STUB).hexdigest()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def call(port, method, path, body=None, timeout=15):
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path),
        method=method)
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


DRIP = b"GGUF" + b"d" * (3 * 1024 * 1024)


class DripHandler(http.server.BaseHTTPRequestHandler):
    """Serves a 3 MB GGUF 64 KB at a time with a pause
    between chunks. The worker reads in 1 MB chunks, so
    the transfer stays in flight for several worker
    reads: long enough to observe progress and cancel
    mid-flight."""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type",
                         "application/octet-stream")
        self.send_header("Content-Length",
                         str(len(DRIP)))
        self.end_headers()
        for i in range(0, len(DRIP), 65536):
            try:
                self.wfile.write(DRIP[i:i + 65536])
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            time.sleep(0.1)

    def log_message(self, *a):
        pass


class FastHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type",
                         "application/octet-stream")
        self.send_header("Content-Length",
                         str(len(STUB)))
        self.end_headers()
        self.wfile.write(STUB)

    def log_message(self, *a):
        pass


class ModelStoreServerCase(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp(
            prefix="ghostide-d6-srv-"))
        self.app = self.td / "app"
        self.app.mkdir()
        for f in ("server.py", "ghost_paths.py",
                  "updater.py", "workspace_trust.py",
                  "lsp_manager.py", "debug_bridge.py",
                  "embed_index.py", "VERSION.json"):
            shutil.copy(REPO / f, self.app / f)
        (self.app / "web").mkdir()
        (self.app / "web" / "index.html").write_text(
            "<html></html>")
        (self.app / "playground").mkdir()
        (self.app / "playground" / "hello.txt").write_text(
            "seeded")
        self.ws = self.td / "ws"
        self.ws.mkdir()
        self.models = self.td / "models"
        self.models.mkdir()
        self.proc = None
        self.httpd = None

    def tearDown(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()
        if self.httpd:
            self.httpd.shutdown()
        shutil.rmtree(self.td, ignore_errors=True)

    def start_server(self):
        port = free_port()
        env = dict(os.environ)
        env.update({
            "HOME": str(self.td / "home"),
            "GHOST_IDE_PORT": str(port),
            "GHOST_IDE_WORKSPACE": str(self.ws),
            "GHOST_IDE_MODELS": str(self.models),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        self.proc = subprocess.Popen(
            [sys.executable, str(self.app / "server.py")],
            cwd=str(self.app), env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                st, _ = call(port, "GET", "/api/health",
                             timeout=2)
                if st == 200:
                    return port
            except Exception:
                pass
            if self.proc.poll() is not None:
                raise AssertionError(
                    "server exited early:\n"
                    + self.proc.stdout.read())
            time.sleep(0.2)
        raise AssertionError("server did not come up")

    def serve_stub(self, handler):
        self.httpd = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever,
                         daemon=True).start()
        return self.httpd.server_address[1]

    def store(self, port):
        st, d = call(port, "GET", "/api/models/store")
        self.assertEqual(st, 200, d)
        return d

    def wait_import(self, port, want, timeout=40):
        deadline = time.time() + timeout
        while time.time() < deadline:
            d = self.store(port)
            if d["import"]["state"] == want:
                return d
            time.sleep(0.25)
        self.fail("import did not reach state %r (last: "
                  "%r)" % (want, d["import"]))

    def test_store_import_active_delete(self):
        port = self.start_server()
        st, health = call(port, "GET", "/api/health")
        self.assertEqual(health["version"], "3.22.0")

        d = self.store(port)
        cards = {c["id"]: c for c in d["models"]}
        self.assertEqual(
            {i for i, c in cards.items()
             if c["role"] == "chat"
             and c["kind"] == "catalog"},
            {"0.5b", "1.5b", "3b", "7b"})
        # No drift: the 7B card carries the pinned size.
        self.assertEqual(cards["7b"]["bytes"], 4683073536)
        self.assertEqual(cards["0.5b"]["bytes"],
                         491400064)
        self.assertEqual(cards["embed"]["role"],
                         "embedding")
        self.assertFalse(cards["embed"]["installed"])
        self.assertIn("ramBytes", d["machine"])
        self.assertEqual(d["disk"]["modelsBytes"], 0)

        # Local import of the stub GGUF.
        src = self.td / "stub.gguf"
        src.write_bytes(STUB)
        st, d = call(port, "POST", "/api/models/import",
                     {"path": str(src)})
        self.assertEqual(st, 200, d)
        self.assertTrue(d["ok"], d)
        imp_id = d["model"]["id"]
        self.assertEqual(d["model"]["sha256"], STUB_SHA)
        self.assertTrue(
            (self.models / "stub.gguf").is_file())
        d = self.store(port)
        card = [c for c in d["models"]
                if c["id"] == imp_id]
        self.assertEqual(len(card), 1)
        self.assertEqual(card[0]["kind"], "imported")
        self.assertFalse(card[0]["verified"])
        self.assertFalse(card[0]["active"])

        # Set active: the switch path accepts it (the
        # stub is not a runnable model; nothing here
        # asks the loader to start it).
        st, d = call(port, "POST", "/api/models/active",
                     {"id": imp_id})
        self.assertTrue(d["ok"], d)
        st, info = call(port, "GET", "/api/model/info")
        self.assertEqual(info["modelPath"],
                         str(self.models / "stub.gguf"))
        self.assertTrue(info["exists"])
        d = self.store(port)
        self.assertEqual(d["active"]["id"], imp_id)

        # A non-GGUF file is refused, registering
        # nothing.
        bad = self.td / "bad.gguf"
        bad.write_bytes(b"plain text, not a model")
        st, d = call(port, "POST", "/api/models/import",
                     {"path": str(bad)})
        self.assertIn("GGUF", d["error"])
        d = self.store(port)
        self.assertEqual(
            len([c for c in d["models"]
                 if c["kind"] == "imported"]), 1)
        self.assertFalse((self.models / "bad.gguf")
                         .exists())

        # Delete the active (not loaded) imported
        # model: file and registry entry go, the
        # picker resets.
        st, d = call(port, "POST", "/api/models/delete",
                     {"id": imp_id})
        self.assertTrue(d["ok"], d)
        self.assertFalse(
            (self.models / "stub.gguf").exists())
        d = self.store(port)
        self.assertEqual(
            [c for c in d["models"]
             if c["kind"] == "imported"], [])
        self.assertIsNone(d["active"]["id"])

    def test_url_import_completes(self):
        port = self.start_server()
        fport = self.serve_stub(FastHandler)
        url = "http://127.0.0.1:%d/remote.gguf" % fport
        st, d = call(port, "POST", "/api/models/import",
                     {"url": url})
        self.assertTrue(d["ok"], d)
        d = self.wait_import(port, "done")
        card = [c for c in d["models"]
                if c["kind"] == "imported"]
        self.assertEqual(len(card), 1)
        self.assertEqual(card[0]["source"], "url")
        self.assertEqual(card[0]["sha256"], STUB_SHA)
        self.assertTrue(
            (self.models / "remote.gguf").is_file())

    def test_url_import_cancel(self):
        port = self.start_server()
        fport = self.serve_stub(DripHandler)
        url = "http://127.0.0.1:%d/slow.gguf" % fport
        st, d = call(port, "POST", "/api/models/import",
                     {"url": url})
        self.assertTrue(d["ok"], d)
        deadline = time.time() + 20
        d = self.store(port)
        while time.time() < deadline:
            if d["import"]["state"] == "downloading" \
                    and d["import"]["done"] > 0:
                break
            time.sleep(0.25)
            d = self.store(port)
        self.assertEqual(d["import"]["state"],
                         "downloading")
        self.assertGreater(d["import"]["done"], 0)
        st, d = call(port, "POST", "/api/models/cancel",
                     {"id": "import"})
        self.assertTrue(d["ok"], d)
        d = self.wait_import(port, "idle")
        self.assertFalse(
            (self.models / "slow.gguf.part").exists())
        self.assertFalse(
            (self.models / "slow.gguf").exists())
        self.assertEqual(
            [c for c in d["models"]
             if c["kind"] == "imported"], [])


if __name__ == "__main__":
    unittest.main()
