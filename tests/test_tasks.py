#!/usr/bin/env python3
"""HTTP integration tests for portable task records
(Mobile Cycle 3, S1) against a real server subprocess,
plus the cross-implementation canonical-form proof:

- POST /api/tasks stores a valid record verbatim under
  .ghostide/tasks/<id>.json; GET lists summaries and
  ?id= fetches the record
- duplicate create is a 409; update replaces; updating
  or fetching a missing record is a 404
- the shared strict validation refuses by name: wrong
  schema, missing / newer / older schemaVersion (the
  newer error names the version and says "newer
  GhostIDE"), bad id (incl. traversal), bad kind, bad
  status, bad budget / approvals / steps, oversize (413)
- the shared fixture (tests/fixtures/task_record_v1.json)
  validates, round-trips through the store, and its
  canonical form - computed by server.py's own
  _task_canonical in a subprocess - equals the checked-in
  expected string byte for byte, before and after the
  round-trip. The JVM suite (TkTest) proves the Java
  implementation agrees on the same two files.

The copied-tree setup mirrors tests/test_agent_runs.py
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
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURE = REPO / "tests" / "fixtures" / "task_record_v1.json"
CANONICAL = REPO / "tests" / "fixtures" / \
    "task_record_v1.canonical.txt"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def call(port, method, path, body=None, timeout=15,
         raw=None):
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path), method=method)
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
    if data is not None:
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


def record(**over):
    rec = {
        "schema": "ghostide.task", "schemaVersion": 1,
        "id": "task-20261118-120000-test",
        "kind": "agent-run", "title": "Fix the thing",
        "goal": "fix the thing in a.py",
        "workspace": "/tmp/ws", "createdBy": "desktop",
        "status": "done",
        "budget": {"stepCap": 50},
        "approvals": {"asked": 1, "allowed": 1, "denied": 0},
        "checkpoint": None, "planPath": None,
        "steps": {"count": 2, "lastLabel": "edit a.py"},
        "createdAt": "2026-11-18T12:00:00",
        "updatedAt": "2026-11-18T12:01:00",
    }
    rec.update(over)
    return rec


class TasksCase(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp(
            prefix="ghostide-tasks-"))
        self.app = self.td / "app"
        self.app.mkdir()
        for f in ("server.py", "ghost_paths.py", "updater.py",
                  "workspace_trust.py", "lsp_manager.py",
                  "embed_index.py", "debug_bridge.py",
                  "VERSION.json"):
            shutil.copy(REPO / f, self.app / f)
        (self.app / "web").mkdir()
        (self.app / "web" / "index.html").write_text(
            "<html></html>")
        (self.app / "playground").mkdir()
        self.ws = self.td / "ws"
        self.ws.mkdir()
        (self.ws / "a.py").write_text("old line\nkeep\n")
        self.llama_port = free_port()
        self.llama = http.server.ThreadingHTTPServer(
            ("127.0.0.1", self.llama_port), StubLlama)
        threading.Thread(target=self.llama.serve_forever,
                         daemon=True).start()
        self.port = free_port()
        self.env = dict(os.environ)
        self.env.update({
            "HOME": str(self.td / "home"),
            "GHOST_IDE_PORT": str(self.port),
            "GHOST_IDE_WORKSPACE": str(self.ws),
            "LLAMA_BASE": "http://127.0.0.1:%d"
                          % self.llama_port,
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        self.proc = subprocess.Popen(
            [sys.executable, str(self.app / "server.py")],
            cwd=str(self.app), env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True)
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                st, _ = call(self.port, "GET", "/api/health",
                             timeout=2)
                if st == 200:
                    return
            except Exception:
                pass
            if self.proc.poll() is not None:
                raise AssertionError(
                    "server exited early:\n"
                    + self.proc.stdout.read())
            time.sleep(0.2)
        raise AssertionError("server did not come up")

    def tearDown(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        self.llama.shutdown()
        shutil.rmtree(self.td, ignore_errors=True)

    def canonical(self, obj):
        """server.py's own canonical form, computed in a
        subprocess against the copied tree."""
        code = (
            "import json,sys,server;"
            "sys.stdout.write(server._task_canonical("
            "json.loads(sys.argv[1])))")
        r = subprocess.run(
            [sys.executable, "-c", code,
             json.dumps(obj)],
            cwd=str(self.app), env=self.env,
            capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_create_get_list_update(self):
        st, d = call(self.port, "POST", "/api/tasks",
                     record())
        self.assertEqual(st, 200)
        self.assertEqual(
            d["path"], ".ghostide/tasks/"
            "task-20261118-120000-test.json")
        on_disk = self.ws / ".ghostide" / "tasks" / \
            "task-20261118-120000-test.json"
        self.assertTrue(on_disk.is_file())
        self.assertEqual(
            json.loads(on_disk.read_text())["title"],
            "Fix the thing")

        st, d = call(self.port, "POST", "/api/tasks",
                     record())
        self.assertEqual(st, 409)
        self.assertIn("already exists", d["error"])

        st, d = call(self.port, "GET", "/api/tasks")
        self.assertEqual(st, 200)
        self.assertEqual(len(d["tasks"]), 1)
        self.assertEqual(d["tasks"][0]["status"], "done")
        self.assertEqual(d["tasks"][0]["steps"], 2)
        self.assertEqual(
            d["tasks"][0]["createdBy"], "desktop")

        st, d = call(self.port, "GET",
                     "/api/tasks?id=task-20261118-120000-test")
        self.assertEqual(st, 200)
        self.assertEqual(d["record"]["goal"],
                         "fix the thing in a.py")

        newer = record(status="failed",
                       updatedAt="2026-11-18T12:05:00")
        st, d = call(self.port, "POST", "/api/tasks/update",
                     newer)
        self.assertEqual(st, 200)
        st, d = call(self.port, "GET",
                     "/api/tasks?id=task-20261118-120000-test")
        self.assertEqual(d["record"]["status"], "failed")

        st, d = call(self.port, "GET",
                     "/api/tasks?id=task-20261118-120000-nope")
        self.assertEqual(st, 404)
        self.assertEqual(d["error"], "no such task record")
        st, d = call(self.port, "POST", "/api/tasks/update",
                     record(id="task-20261118-120000-nope"))
        self.assertEqual(st, 404)
        st, d = call(self.port, "GET",
                     "/api/tasks?id=../escape")
        self.assertEqual(st, 400)
        self.assertEqual(d["error"], "bad task id")

    def test_validation_refuses_by_name(self):
        cases = [
            ({"schema": "other"}, "not a GhostIDE task record"),
            ({"schemaVersion": None},
             "no readable schema version"),
            ({"schemaVersion": 2},
             "written by a newer GhostIDE "
             "(task schema version 2)"),
            ({"schemaVersion": 0},
             "older than any this build can read"),
            ({"id": "../escape"}, "bad task id"),
            ({"id": "has space"}, "bad task id"),
            ({"kind": "chore"}, "kind must be one of"),
            ({"title": ""}, "title must be a string"),
            ({"title": "x" * 201}, "title must be a string"),
            ({"createdBy": "phone"},
             "createdBy must be desktop or android"),
            ({"status": "paused"}, "status must be one of"),
            ({"budget": {"stepCap": -1}},
             "budget.stepCap must be an integer"),
            ({"budget": {"stepCap": True}},
             "budget.stepCap must be an integer"),
            ({"approvals": {"asked": 1, "allowed": 1}},
             "approvals must be an object"),
            ({"steps": {"count": -1, "lastLabel": ""}},
             "steps must be an object"),
            ({"checkpoint": 42},
             "checkpoint must be a string"),
            ({"createdAt": "yesterday"},
             "createdAt must be an ISO 8601"),
            ({"payload": [1, 2]}, "payload must be an object"),
        ]
        for over, frag in cases:
            rec = record()
            for k, v in over.items():
                if v is None:
                    rec.pop(k, None)
                else:
                    rec[k] = v
            st, d = call(self.port, "POST", "/api/tasks", rec)
            self.assertEqual(st, 400, (over, d))
            self.assertIn(frag, d["error"], (over, d))
        # nothing was stored by any refusal
        st, d = call(self.port, "GET", "/api/tasks")
        self.assertEqual(d["tasks"], [])

    def test_oversize_refused_before_parsing(self):
        big = json.dumps(record()).encode()
        pad = b" " * (300 * 1024)
        st, d = call(self.port, "POST", "/api/tasks",
                     raw=big + pad)
        self.assertEqual(st, 413)
        self.assertIn("task record too large", d["error"])

    def test_record_is_data_never_executed(self):
        rec = record(
            id="task-20261118-120100-data",
            title="$(touch pwned) <script>alert(1)</script>")
        st, _ = call(self.port, "POST", "/api/tasks", rec)
        self.assertEqual(st, 200)
        self.assertFalse((self.ws / "pwned").exists())
        st, d = call(self.port, "GET",
                     "/api/tasks?id=task-20261118-120100-data")
        self.assertIn("<script>", d["record"]["title"])

    def test_unknown_fields_preserved(self):
        rec = record()
        rec["futureField"] = {"nested": [1, 2, 3]}
        st, _ = call(self.port, "POST", "/api/tasks", rec)
        self.assertEqual(st, 200)
        st, d = call(self.port, "GET",
                     "/api/tasks?id=" + rec["id"])
        self.assertEqual(d["record"]["futureField"],
                         {"nested": [1, 2, 3]})

    def test_fixture_validates_and_canonical_round_trip(self):
        fixture = json.loads(FIXTURE.read_text())
        expected = CANONICAL.read_text().strip()
        self.assertEqual(self.canonical(fixture), expected)
        st, d = call(self.port, "POST", "/api/tasks",
                     fixture)
        self.assertEqual(st, 200, d)
        st, d = call(self.port, "GET",
                     "/api/tasks?id=" + fixture["id"])
        self.assertEqual(st, 200)
        self.assertEqual(self.canonical(d["record"]),
                         expected)
        st, d = call(self.port, "GET", "/api/tasks")
        self.assertEqual(len(d["tasks"]), 1)
        self.assertEqual(d["tasks"][0]["id"], fixture["id"])


if __name__ == "__main__":
    unittest.main()
