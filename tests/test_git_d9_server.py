#!/usr/bin/env python3
"""Tests for Desktop Cycle 3 D9 (git depth: hunk
staging + the three-pane conflict editor) against
REAL git repositories in temp dirs.

Two layers:
- GitDepthUnitCase drives the server module's git
  helpers directly (the import pattern proven by the
  D9 prototype): out-of-order hunk staging, a binary
  file (no hunks, file-level only), a newly added
  file's single index hunk, a deleted file's hunk.
- GitDepthServerCase runs a real server subprocess
  (the test_model_store_server pattern) and walks the
  whole HTTP surface: a two-hunk file staged one hunk
  at a time, the stale-selection refusal after the
  file moves, discard, then a real two-branch merge
  conflict resolved through the conflict endpoints
  and committed through the existing commit route.
  The marker-remaining save block is client policy;
  its override path is proven here at the API level
  (the server stages marker-bearing content when the
  client sends it after the user's explicit override)
  and the block itself is pinned in the D9 harness.
"""
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def git(cwd, *args, ok=True):
    r = subprocess.run(["git"] + list(args), cwd=str(cwd),
                       capture_output=True, text=True)
    if ok and r.returncode != 0:
        raise AssertionError("git %s failed: %s"
                             % (args, r.stderr))
    return r


def make_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main", ".")
    git(path, "config", "user.email", "t@t.t")
    git(path, "config", "user.name", "T")
    return path


def load_server_module():
    spec = importlib.util.spec_from_file_location(
        "ghostide_server_d9", REPO / "server.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class GitDepthUnitCase(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp(
            prefix="ghostide-d9-unit-"))
        self.ws = make_repo(self.td / "ws")
        self.srv = load_server_module()
        self.srv.WORKSPACE = self.ws

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def write_lines(self, name, lines):
        (self.ws / name).write_text(
            "\n".join(lines) + "\n")

    def expect_of(self, h):
        return {"headers": h["headers"],
                "selected": {str(x["index"]): x["sha"]
                             for x in h["hunks"]}}

    def test_stage_second_hunk_only(self):
        lines = ["line %02d" % i for i in range(1, 31)]
        self.write_lines("f.txt", lines)
        git(self.ws, "add", "f.txt")
        git(self.ws, "commit", "-qm", "init")
        lines[2] = "CHANGED A"
        lines[25] = "CHANGED B"
        self.write_lines("f.txt", lines)
        h = self.srv.git_hunks("f.txt", "worktree")
        self.assertEqual(len(h["hunks"]), 2)
        self.assertFalse(h["binary"])
        # Stage ONLY hunk 1 (the second hunk): the
        # patch must land at its own offsets.
        exp = self.expect_of(h)
        exp["selected"] = {"1": h["hunks"][1]["sha"]}
        self.srv.git_apply_hunks(
            "f.txt", "worktree", "stage", [1], exp)
        cached = git(self.ws, "diff", "--cached").stdout
        self.assertIn("CHANGED B", cached)
        self.assertNotIn("CHANGED A", cached)
        wt = git(self.ws, "diff").stdout
        self.assertIn("CHANGED A", wt)
        self.assertNotIn("CHANGED B", wt)

    def test_binary_file_has_no_hunks(self):
        (self.ws / "b.bin").write_bytes(
            b"\x00\x01\x02" + bytes(range(256)))
        git(self.ws, "add", "b.bin")
        git(self.ws, "commit", "-qm", "bin")
        (self.ws / "b.bin").write_bytes(
            b"\x00\x09\x09" + bytes(range(255, -1, -1)))
        h = self.srv.git_hunks("b.bin", "worktree")
        self.assertTrue(h["binary"])
        self.assertEqual(h["hunks"], [])

    def test_new_file_single_index_hunk_unstages(self):
        self.write_lines("new.txt", ["one", "two"])
        git(self.ws, "add", "new.txt")
        h = self.srv.git_hunks("new.txt", "index")
        self.assertEqual(len(h["hunks"]), 1)
        self.srv.git_apply_hunks(
            "new.txt", "index", "unstage", [0],
            self.expect_of(h))
        st = git(self.ws, "status",
                 "--porcelain").stdout
        self.assertIn("?? new.txt", st)

    def test_deleted_file_hunk_stages(self):
        self.write_lines("d.txt", ["x", "y", "z"])
        git(self.ws, "add", "d.txt")
        git(self.ws, "commit", "-qm", "init")
        (self.ws / "d.txt").unlink()
        h = self.srv.git_hunks("d.txt", "worktree")
        self.assertEqual(len(h["hunks"]), 1)
        self.srv.git_apply_hunks(
            "d.txt", "worktree", "stage", [0],
            self.expect_of(h))
        st = git(self.ws, "status",
                 "--porcelain").stdout
        self.assertIn("D  d.txt", st)

    def test_area_action_mismatch_refused(self):
        self.write_lines("f.txt", ["a"])
        git(self.ws, "add", "f.txt")
        git(self.ws, "commit", "-qm", "init")
        self.write_lines("f.txt", ["b"])
        h = self.srv.git_hunks("f.txt", "worktree")
        with self.assertRaises(ValueError):
            self.srv.git_apply_hunks(
                "f.txt", "index", "stage", [0],
                self.expect_of(h))
        with self.assertRaises(ValueError):
            self.srv.git_apply_hunks(
                "f.txt", "worktree", "unstage", [0],
                self.expect_of(h))


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


class GitDepthServerCase(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp(
            prefix="ghostide-d9-srv-"))
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
        self.ws = make_repo(self.td / "ws")
        self.models = self.td / "models"
        self.models.mkdir()
        self.proc = None

    def tearDown(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()
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

    def hunks(self, port, path, area):
        st, d = call(port, "GET",
                     "/api/git/hunks?path=%s&area=%s"
                     % (path, area))
        self.assertEqual(st, 200, d)
        return d

    def apply(self, port, h, indices, action):
        exp = {"headers": h["headers"],
               "selected": {
                   str(i): h["hunks"][i]["sha"]
                   for i in indices}}
        return call(port, "POST", "/api/git/hunks/apply",
                    {"path": h["path"], "area": h["area"],
                     "action": action, "hunks": indices,
                     "expect": exp})

    def test_hunk_flow_over_http(self):
        lines = ["line %02d" % i for i in range(1, 31)]
        (self.ws / "f.txt").write_text(
            "\n".join(lines) + "\n")
        git(self.ws, "add", "f.txt")
        git(self.ws, "commit", "-qm", "init")
        lines[2] = "CHANGED A"
        lines[25] = "CHANGED B"
        (self.ws / "f.txt").write_text(
            "\n".join(lines) + "\n")
        port = self.start_server()
        st, health = call(port, "GET", "/api/health")
        self.assertEqual(health["version"], "3.25.0")

        h = self.hunks(port, "f.txt", "worktree")
        self.assertEqual(len(h["hunks"]), 2)
        self.assertFalse(h["binary"])

        # Stage hunk 0 only: the index gains exactly
        # that hunk's lines.
        st, d = self.apply(port, h, [0], "stage")
        self.assertTrue(d.get("ok"), d)
        cached = git(self.ws, "diff", "--cached").stdout
        self.assertIn("CHANGED A", cached)
        self.assertNotIn("CHANGED B", cached)
        wt = git(self.ws, "diff").stdout
        self.assertIn("CHANGED B", wt)
        self.assertNotIn("CHANGED A", wt)

        # Unstage it again from the index area.
        hi = self.hunks(port, "f.txt", "index")
        self.assertEqual(len(hi["hunks"]), 1)
        st, d = self.apply(port, hi, [0], "unstage")
        self.assertTrue(d.get("ok"), d)
        self.assertEqual(
            git(self.ws, "diff", "--cached").stdout, "")

        # Stale selection: fetch, then move the file,
        # then apply with the old expect block. The
        # server must refuse and stage nothing.
        h2 = self.hunks(port, "f.txt", "worktree")
        cur = (self.ws / "f.txt").read_text()
        (self.ws / "f.txt").write_text(
            cur.replace("line 10", "line TEN"))
        st, d = self.apply(port, h2, [0], "stage")
        self.assertIn("diff changed", d.get("error", ""))
        self.assertEqual(
            git(self.ws, "diff", "--cached").stdout, "")

        # Discard removes exactly the chosen hunk.
        h3 = self.hunks(port, "f.txt", "worktree")
        idx_b = next(x["index"] for x in h3["hunks"]
                     if "CHANGED B" in x["text"])
        st, d = self.apply(port, h3, [idx_b], "discard")
        self.assertTrue(d.get("ok"), d)
        body = (self.ws / "f.txt").read_text()
        self.assertNotIn("CHANGED B", body)
        self.assertIn("CHANGED A", body)
        self.assertIn("line 26", body)

    def test_merge_conflict_flow_over_http(self):
        (self.ws / "c.txt").write_text(
            "alpha\nbeta\ngamma\n")
        git(self.ws, "add", ".")
        git(self.ws, "commit", "-qm", "base")
        git(self.ws, "checkout", "-qb", "feature")
        (self.ws / "c.txt").write_text(
            "alpha\nbeta FEATURE\ngamma\n")
        git(self.ws, "commit", "-qam", "feature")
        git(self.ws, "checkout", "-q", "main")
        (self.ws / "c.txt").write_text(
            "alpha\nbeta MAIN\ngamma\n")
        git(self.ws, "commit", "-qam", "main")
        git(self.ws, "merge", "feature", ok=False)
        port = self.start_server()

        st, d = call(port, "GET", "/api/git/status")
        self.assertEqual(d["conflicts"], ["c.txt"])
        self.assertEqual(d["mergeState"], "merge")

        st, c = call(port, "GET",
                     "/api/git/conflict?path=c.txt")
        self.assertEqual(st, 200, c)
        self.assertEqual(c["stages"], [1, 2, 3])
        self.assertEqual(c["base"],
                         "alpha\nbeta\ngamma\n")
        self.assertEqual(c["ours"],
                         "alpha\nbeta MAIN\ngamma\n")
        self.assertEqual(c["theirs"],
                         "alpha\nbeta FEATURE\ngamma\n")
        self.assertIn("<<<<<<<", c["working"])

        # Resolve the block with "theirs", the way the
        # editor's Use theirs button rewrites it.
        resolved = c["working"].replace(
            "<<<<<<< HEAD\nbeta MAIN\n=======\n"
            "beta FEATURE\n>>>>>>> feature",
            "beta FEATURE")
        self.assertNotIn("<<<<<<<", resolved)
        st, d = call(port, "POST",
                     "/api/git/conflict/resolve",
                     {"path": "c.txt", "content": resolved})
        self.assertTrue(d.get("ok"), d)
        self.assertEqual(d["remaining"], 0)
        self.assertEqual(d["mergeState"], "merge")

        st, d = call(port, "GET", "/api/git/status")
        self.assertEqual(d["conflicts"], [])
        self.assertEqual(d["mergeState"], "merge")

        # The merge commits through the existing
        # commit route, with two parents.
        st, d = call(port, "POST", "/api/git/commit",
                     {"message": "merge feature"})
        self.assertTrue(d.get("ok"), d)
        parents = git(self.ws, "cat-file", "-p",
                      "HEAD").stdout
        self.assertEqual(
            len([ln for ln in parents.splitlines()
                 if ln.startswith("parent ")]), 2)
        st, d = call(port, "GET", "/api/git/status")
        self.assertIsNone(d["mergeState"])
        self.assertEqual(d["changes"], [])

    def test_resolve_override_stages_marker_content(self):
        # The override path: after the user's explicit
        # confirm, the client may save content that
        # still carries marker-like text (a file that
        # legitimately documents conflict markers, say).
        # The server stages exactly what it is sent.
        (self.ws / "m.txt").write_text("one\ntwo\n")
        git(self.ws, "add", ".")
        git(self.ws, "commit", "-qm", "base")
        git(self.ws, "checkout", "-qb", "side")
        (self.ws / "m.txt").write_text("one\nSIDE\n")
        git(self.ws, "commit", "-qam", "side")
        git(self.ws, "checkout", "-q", "main")
        (self.ws / "m.txt").write_text("one\nMAIN\n")
        git(self.ws, "commit", "-qam", "main")
        git(self.ws, "merge", "side", ok=False)
        port = self.start_server()
        doc = ("one\n<<<<<<< example\n"
               "markers kept on purpose\n")
        st, d = call(port, "POST",
                     "/api/git/conflict/resolve",
                     {"path": "m.txt", "content": doc})
        self.assertTrue(d.get("ok"), d)
        self.assertEqual(d["remaining"], 0)
        self.assertEqual(
            (self.ws / "m.txt").read_text(), doc)
        st, d = call(port, "GET", "/api/git/status")
        self.assertEqual(d["conflicts"], [])


if __name__ == "__main__":
    unittest.main()
