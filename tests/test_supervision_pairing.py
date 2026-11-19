"""Mobile Cycle 3 (M10): phone supervision pairing.

A real server.py subprocess bound to a LAN-style
address (127.0.1.1: the sandbox has no true LAN IP,
and the pair gate's loopback check is the exact
127.0.0.1/::1 pair, so the .1.1 alias exercises the
same non-loopback code path a phone on the LAN
would). Proves the M10 security contract:

- with pairing off (the default), a network caller
  gets nothing: every paired endpoint refuses, and
  joining is refused by name;
- the one-time code is single-use, five minutes or
  five wrong attempts, whichever comes first;
- a supervision token opens ONLY the supervision
  route set (tasks read, run records, approval list
  and decide, follow-up append, review) and is a
  flat 401 everywhere else, including task create;
- an approval decided by the simulated phone is
  recorded against the record's exact hash and
  executed by the desktop's own path (E10);
- a follow-up posted by the phone lands on the
  task record, stamped with the device name;
- unpairing on either side, and turning the switch
  off, revoke at once.
"""
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAN_IP = "127.0.1.1"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class StubLlama:
    def __init__(self, port):
        from http.server import BaseHTTPRequestHandler
        from http.server import ThreadingHTTPServer

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _j(self, obj):
                b = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type",
                                 "application/json")
                self.send_header("Content-Length",
                                 str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                self._j({"status": "ok"})

            def do_POST(self):
                n = int(self.headers.get(
                    "Content-Length") or 0)
                if n:
                    self.rfile.read(n)
                self._j({"choices": [{"message": {
                    "role": "assistant",
                    "content": "ok"}}]})

        self.httpd = ThreadingHTTPServer(
            ("127.0.0.1", port), H)
        import threading
        threading.Thread(target=self.httpd.serve_forever,
                         daemon=True).start()


class SupervisionPairingServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(
            prefix="ghostide-sup-"))
        app = cls.tmp / "app"
        app.mkdir()
        for name in ("server.py", "ghost_paths.py",
                     "updater.py", "workspace_trust.py",
                     "lsp_manager.py", "embed_index.py",
                     "debug_bridge.py", "VERSION.json"):
            shutil.copy(ROOT / name, app / name)
        (app / "web").mkdir()
        (app / "web" / "index.html").write_text(
            "<!doctype html><title>t</title>",
            encoding="utf-8")
        (app / "playground").mkdir()
        ws = cls.tmp / "ws"
        ws.mkdir()
        (ws / "a.py").write_text("x = 1\n",
                                 encoding="utf-8")
        home = cls.tmp / "home"
        home.mkdir()
        cls.port = free_port()
        cls.llama = StubLlama(free_port())
        env = dict(os.environ)
        env.update({
            "HOME": str(home),
            "GHOST_IDE_PORT": str(cls.port),
            "GHOST_IDE_HOST": LAN_IP,
            "GHOST_IDE_WORKSPACE": str(ws),
            "LLAMA_BASE": "http://127.0.0.1:%d"
                          % cls.llama.httpd.server_address[1],
            "GHOSTIDE_ECO_HOME": str(Path.home()
                                     / "workspace"),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        cls.proc = subprocess.Popen(
            [sys.executable, "server.py"], cwd=app,
            env=env, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 30
        cls.ctx = ssl._create_unverified_context()
        while time.time() < deadline:
            try:
                st, _ = cls.call("127.0.0.1", "GET",
                                 "/api/health")
                if st == 200:
                    break
            except OSError:
                pass
            time.sleep(0.25)
        else:
            out = cls.proc.stdout.read() \
                if cls.proc.stdout else ""
            raise RuntimeError(
                "server did not come up: " + out)
        st, fp = cls.call("127.0.0.1", "GET",
                          "/api/pair/certfp")
        assert st == 200, fp
        cls.tls = bool(fp.get("tls"))
        assert cls.tls, "the fixture expects the TLS " \
            "listener on the LAN address (openssl CLI)"

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def call(cls, host, method, path, body=None,
             token=None, sup_token=None):
        # http.client, not urllib: no proxy variables
        # are honored, and the source address is bound
        # explicitly. Binding the LAN calls' source to
        # 127.0.1.1 matters: Linux otherwise sources
        # every 127/8 connection from 127.0.0.1, and
        # the server would see a loopback caller and
        # the pair gate would never engage.
        import http.client
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if token:
            headers["X-Pair-Token"] = token
        if sup_token:
            headers["X-Supervision-Token"] = sup_token
        src = (LAN_IP, 0) if host == LAN_IP else None
        if host == LAN_IP and cls.tls:
            conn = http.client.HTTPSConnection(
                host, cls.port, timeout=10,
                context=cls.ctx, source_address=src)
        else:
            conn = http.client.HTTPConnection(
                host, cls.port, timeout=10,
                source_address=src)
        try:
            conn.request(method, path, body=data,
                         headers=headers)
            r = conn.getresponse()
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, {"text": raw}
        finally:
            conn.close()

    def lan(self, method, path, body=None, **kw):
        return self.call(LAN_IP, method, path, body,
                         **kw)

    def host(self, method, path, body=None, **kw):
        return self.call("127.0.0.1", method, path,
                         body, **kw)

    def pair_up(self, name="Test Phone"):
        st, en = self.host("POST",
                           "/api/supervision/enable",
                           {"enabled": True})
        self.assertEqual(st, 200, en)
        st, cd = self.host("POST",
                           "/api/supervision/code", {})
        self.assertEqual(st, 200, cd)
        st, jn = self.lan("POST",
                          "/api/supervision/join",
                          {"code": cd["code"],
                           "name": name})
        self.assertEqual(st, 200, jn)
        return jn["token"], jn["device"]["id"]

    # --- the gate with pairing off (the default) ---
    def test_01_off_by_default_refuses_everything(self):
        st, body = self.host(
            "GET", "/api/supervision/status")
        self.assertEqual(st, 200)
        self.assertFalse(body["enabled"])
        self.assertEqual(body["devices"], [])
        for method, path in (
                ("GET", "/api/tasks"),
                ("GET", "/api/agent-runs"),
                ("GET", "/api/approve/list"),
                ("GET", "/api/supervision/status"),
                ("GET", "/api/supervision/review"
                        "?taskId=task-x"),
                ("POST", "/api/approve/decide"),
                ("POST", "/api/supervision/followup"),
                ("POST", "/api/supervision/unpair")):
            st, _ = self.lan(method, path,
                             {} if method == "POST"
                             else None)
            self.assertEqual(st, 401, (method, path))
            st, _ = self.lan(
                method, path,
                {} if method == "POST" else None,
                sup_token="bogus-token")
            self.assertEqual(st, 401, (method, path))
        st, body = self.lan(
            "POST", "/api/supervision/join",
            {"code": "123456", "name": "Phone"})
        self.assertEqual(st, 401)
        self.assertIn("off", body["error"])

    # --- management is the host's alone ---
    def test_02_management_is_loopback_only(self):
        st, _ = self.lan("POST",
                         "/api/supervision/enable",
                         {"enabled": True})
        self.assertEqual(st, 401)
        st, _ = self.lan("POST",
                         "/api/supervision/code", {})
        self.assertEqual(st, 401)
        st, body = self.host(
            "GET", "/api/supervision/status")
        self.assertFalse(body["enabled"])

    # --- the code: wrong attempts kill it ---
    def test_03_code_dies_after_attempt_limit(self):
        st, _ = self.host("POST",
                          "/api/supervision/enable",
                          {"enabled": True})
        self.assertEqual(st, 200)
        st, cd = self.host("POST",
                           "/api/supervision/code", {})
        self.assertEqual(st, 200)
        code = cd["code"]
        self.assertEqual(len(code), 6)
        self.assertTrue(code.isdigit())
        wrong = "000000" if code != "000000" \
            else "111111"
        for i in range(4):
            st, body = self.lan(
                "POST", "/api/supervision/join",
                {"code": wrong, "name": "Phone"})
            self.assertEqual(st, 401)
            self.assertIn("wrong pairing code",
                          body["error"])
        st, body = self.lan(
            "POST", "/api/supervision/join",
            {"code": wrong, "name": "Phone"})
        self.assertEqual(st, 401)
        self.assertIn("code is gone", body["error"])
        st, body = self.lan(
            "POST", "/api/supervision/join",
            {"code": code, "name": "Phone"})
        self.assertEqual(st, 401)
        self.assertIn("expired", body["error"])

    # --- join, single-use, and the token's scope ---
    def test_04_join_single_use_and_token_scope(self):
        token, dev_id = self.pair_up()
        st, cd = self.host("POST",
                           "/api/supervision/code", {})
        code2 = cd["code"]
        st, jn = self.lan("POST",
                          "/api/supervision/join",
                          {"code": code2,
                           "name": "Second"})
        self.assertEqual(st, 200)
        st, body = self.lan(
            "POST", "/api/supervision/join",
            {"code": code2, "name": "Third"})
        self.assertEqual(st, 401)
        self.assertIn("expired", body["error"])
        # The token opens the supervision reads.
        st, body = self.lan("GET", "/api/tasks",
                            sup_token=token)
        self.assertEqual(st, 200, body)
        self.assertIn("tasks", body)
        st, body = self.lan(
            "GET", "/api/supervision/status",
            sup_token=token)
        self.assertEqual(st, 200)
        self.assertTrue(body["paired"])
        self.assertEqual(body["device"]["id"], dev_id)
        self.assertNotIn("devices", body)
        # And nothing else: the token is not an IDE
        # pass, not even for reads outside the set,
        # and it cannot create task records.
        for method, path in (
                ("GET", "/api/health"),
                ("GET", "/api/git/status"),
                ("GET", "/api/file?path=a.py"),
                ("GET", "/api/pair/code"),
                ("POST", "/api/tasks")):
            st, _ = self.lan(
                method, path,
                {} if method == "POST" else None,
                sup_token=token)
            self.assertEqual(st, 401, (method, path))
        # The stored state holds a hash, never the
        # token itself.
        st, body = self.host(
            "GET", "/api/supervision/status")
        self.assertEqual(len(body["devices"]), 2)
        home = self.tmp / "home"
        raw = (home / ".ghostide"
               / "supervision-pairing.json").read_text(
                   encoding="utf-8")
        self.assertNotIn(token, raw)
        self.assertNotIn(jn["token"], raw)
        mode = (home / ".ghostide"
                / "supervision-pairing.json").stat() \
            .st_mode & 0o777
        self.assertEqual(mode, 0o600)

    # --- follow-ups land on the record ---
    def test_05_followup_appends_to_the_record(self):
        token, _ = self.pair_up("Followup Phone")
        rec = {
            "schema": "ghostide.task",
            "schemaVersion": 1,
            "id": "task-m10-followup",
            "kind": "agent-run",
            "title": "M10 follow-up fixture",
            "goal": "prove follow-ups",
            "workspace": "ws",
            "createdBy": "desktop",
            "status": "running",
            "budget": {"stepCap": 50},
            "approvals": {"asked": 0, "allowed": 0,
                          "denied": 0},
            "checkpoint": None, "planPath": None,
            "steps": {"count": 1,
                      "lastLabel": "read a.py"},
            "createdAt": "2026-11-18T12:00:00",
            "updatedAt": "2026-11-18T12:00:00",
            "payload": {"runId": "run-m10"},
        }
        st, body = self.host("POST", "/api/tasks", rec)
        self.assertEqual(st, 200, body)
        st, body = self.lan(
            "POST", "/api/supervision/followup",
            {"taskId": rec["id"],
             "text": "Please also update the readme."},
            sup_token=token)
        self.assertEqual(st, 200, body)
        self.assertEqual(body["followups"], 1)
        st, got = self.host(
            "GET", "/api/tasks?id=" + rec["id"])
        self.assertEqual(st, 200)
        fus = got["record"]["payload"]["followups"]
        self.assertEqual(len(fus), 1)
        self.assertEqual(fus[0]["from"],
                         "Followup Phone")
        self.assertEqual(fus[0]["text"],
                         "Please also update the "
                         "readme.")
        self.assertTrue(fus[0]["at"])
        # The phone sees it too, and the review data
        # route answers for the same task.
        st, got = self.lan(
            "GET", "/api/tasks?id=" + rec["id"],
            sup_token=token)
        self.assertEqual(st, 200)
        self.assertEqual(
            len(got["record"]["payload"]
                ["followups"]), 1)
        st, rev = self.lan(
            "GET", "/api/supervision/review?taskId="
            + rec["id"], sup_token=token)
        self.assertEqual(st, 200, rev)
        self.assertEqual(rev["task"]["id"], rec["id"])
        self.assertIsNone(rev["run"])
        # Refusals: empty text, missing task.
        st, _ = self.lan(
            "POST", "/api/supervision/followup",
            {"taskId": rec["id"], "text": "  "},
            sup_token=token)
        self.assertEqual(st, 400)
        st, _ = self.lan(
            "POST", "/api/supervision/followup",
            {"taskId": "task-m10-missing",
             "text": "hello"}, sup_token=token)
        self.assertEqual(st, 404)

    # --- approvals: the phone decides, the ---
    # --- desktop records and executes (E10) ---
    def test_06_approval_decided_by_phone(self):
        token, _ = self.pair_up("Decider Phone")
        st, enq = self.host(
            "POST", "/api/approve/enqueue",
            {"kind": "run",
             "command": "echo m10-hello",
             "action": "Run: echo m10-hello"})
        self.assertEqual(st, 200, enq)
        aid = enq["id"]
        st, lst = self.lan("GET", "/api/approve/list",
                           sup_token=token)
        self.assertEqual(st, 200, lst)
        mine = [i for i in lst["items"]
                if i["id"] == aid]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["action"],
                         "Run command: echo m10-hello")
        st, dec = self.lan(
            "POST", "/api/approve/decide",
            {"id": aid, "decision": "approve"},
            sup_token=token)
        self.assertEqual(st, 200, dec)
        self.assertEqual(dec["decision"], "approve")
        self.assertTrue(dec["executed"])
        self.assertIn("m10-hello", dec["output"])
        st, lst = self.host("GET", "/api/approve/list")
        results = [r for r in lst["results"]
                   if r.get("id") == aid]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["decision"],
                         "approve")
        # A decided item refuses a second decision.
        st, again = self.lan(
            "POST", "/api/approve/decide",
            {"id": aid, "decision": "deny"},
            sup_token=token)
        self.assertEqual(st, 400)
        # Deny path: decided, not executed.
        st, enq = self.host(
            "POST", "/api/approve/enqueue",
            {"kind": "run",
             "command": "echo m10-nope",
             "action": "Run: echo m10-nope"})
        aid2 = enq["id"]
        st, dec = self.lan(
            "POST", "/api/approve/decide",
            {"id": aid2, "decision": "deny"},
            sup_token=token)
        self.assertEqual(st, 200, dec)
        self.assertFalse(dec["executed"])

    # --- unpair and the switch revoke at once ---
    def test_07_unpair_and_switch_revoke(self):
        token, dev_id = self.pair_up("Leaving Phone")
        st, _ = self.lan("GET", "/api/tasks",
                         sup_token=token)
        self.assertEqual(st, 200)
        st, body = self.lan(
            "POST", "/api/supervision/unpair", {},
            sup_token=token)
        self.assertEqual(st, 200, body)
        st, _ = self.lan("GET", "/api/tasks",
                         sup_token=token)
        self.assertEqual(st, 401)
        # Desktop-side unpair by device id.
        token2, dev2 = self.pair_up("Second Phone")
        st, _ = self.lan("GET", "/api/tasks",
                         sup_token=token2)
        self.assertEqual(st, 200)
        st, body = self.host(
            "POST", "/api/supervision/unpair",
            {"deviceId": dev2})
        self.assertEqual(st, 200, body)
        st, _ = self.lan("GET", "/api/tasks",
                         sup_token=token2)
        self.assertEqual(st, 401)
        # The switch: off stops a live token, on
        # restores the remembered pairing.
        token3, _ = self.pair_up("Switch Phone")
        st, _ = self.host("POST",
                          "/api/supervision/enable",
                          {"enabled": False})
        self.assertEqual(st, 200)
        st, _ = self.lan("GET", "/api/tasks",
                         sup_token=token3)
        self.assertEqual(st, 401)
        st, _ = self.host("POST",
                          "/api/supervision/enable",
                          {"enabled": True})
        self.assertEqual(st, 200)
        st, _ = self.lan("GET", "/api/tasks",
                         sup_token=token3)
        self.assertEqual(st, 200)


if __name__ == "__main__":
    unittest.main()
