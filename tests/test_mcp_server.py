#!/usr/bin/env python3
"""End-to-end tests for Desktop Cycle 2 D8 (MCP polish)
against a real server subprocess (copied tree, temp HOME
and workspace):

- a stdio fixture server lists tools with annotations
  and policy defaults; a disabled tool is refused by the
  server itself (the fixture's call log proves the call
  never arrived); disabling the whole server refuses too
- an HTTP fixture server answers only with the stored
  Authorization header, which the user adds through the
  config API (the token never appears in any API reply)
- an OAuth fixture (discovery, dynamic registration,
  PKCE authorize, token, refresh) connects through the
  real start -> browser redirect -> callback flow, and
  an expired token refreshes on the next call
- status honesty, catalog and paste-import over HTTP
"""
import base64
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
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def call(port, method, path, body=None, timeout=30):
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
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw}


def get_raw(port, path, timeout=15):
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:%d%s" % (port, path),
                timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


class StubLlama(http.server.BaseHTTPRequestHandler):
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

    def do_GET(self):
        out = json.dumps({"status": "ok"}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


class McpHttpFixture:
    """Streamable-HTTP MCP fixture: one tool (whoami)
    that reports the tail of the Authorization header it
    received; 401 unless the header matches ``expect``
    (when set)."""

    def __init__(self, expect=None):
        self.expect = expect
        self.seen = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length")
                        or 0)
                body = self.rfile.read(n) if n else b""
                msg = json.loads(body.decode()) if body \
                    else {}
                auth = self.headers.get("Authorization")
                outer.seen.append(auth)
                if outer.expect is not None and \
                        auth != outer.expect:
                    self.send_response(401)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                mid = msg.get("id")
                if mid is None:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                method = msg.get("method")
                if method == "initialize":
                    result = {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "serverInfo": {"name": "httpfx",
                                       "version": "1"}}
                elif method == "tools/list":
                    result = {"tools": [{
                        "name": "whoami",
                        "description": "Report the caller.",
                        "inputSchema": {"type": "object",
                                        "properties": {}},
                        "annotations": {
                            "readOnlyHint": True}}]}
                elif method == "tools/call":
                    result = {"content": [{
                        "type": "text",
                        "text": "auth: " +
                        (auth or "none")[-12:]}],
                        "isError": False}
                else:
                    result = {}
                data = json.dumps({"jsonrpc": "2.0",
                                   "id": mid,
                                   "result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Type",
                                 "application/json")
                self.send_header("Content-Length",
                                 str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True)

    @property
    def url(self):
        return "http://127.0.0.1:%d/mcp" % \
            self.server.server_address[1]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        return False


class OAuthMcpFixture:
    """OAuth authorization server + the MCP endpoint it
    protects, in one threading server. /mcp answers only
    with a Bearer token this fixture issued."""

    def __init__(self):
        self.codes = {}
        self.tokens = set()
        self.refresh_count = 0
        self.token_n = 0
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, obj, status=200):
                data = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type",
                                 "application/json")
                self.send_header("Content-Length",
                                 str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                origin = "http://127.0.0.1:%d" % \
                    outer.server.server_address[1]
                if u.path == "/.well-known/" \
                        "oauth-protected-resource":
                    return self._json({
                        "resource": origin + "/mcp",
                        "authorization_servers": [origin]})
                if u.path == "/.well-known/" \
                        "oauth-authorization-server":
                    return self._json({
                        "issuer": origin,
                        "authorization_endpoint":
                            origin + "/authorize",
                        "token_endpoint": origin + "/token",
                        "registration_endpoint":
                            origin + "/register"})
                if u.path == "/authorize":
                    q = urllib.parse.parse_qs(u.query)
                    outer.codes["c1"] = q[
                        "code_challenge"][0]
                    loc = q["redirect_uri"][0] + \
                        "?code=c1&state=" + q["state"][0]
                    self.send_response(302)
                    self.send_header("Location", loc)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                return self._json({"error": "nope"}, 404)

            def do_POST(self):
                n = int(self.headers.get("Content-Length")
                        or 0)
                body = self.rfile.read(n) if n else b""
                u = urllib.parse.urlparse(self.path)
                if u.path == "/register":
                    return self._json(
                        {"client_id": "e2e-client"})
                if u.path == "/token":
                    form = urllib.parse.parse_qs(
                        body.decode())
                    grant = form.get("grant_type", [""])[0]
                    if grant == "authorization_code":
                        digest = base64.urlsafe_b64encode(
                            hashlib.sha256(form.get(
                                "code_verifier",
                                [""])[0].encode()).digest()
                        ).decode().rstrip("=")
                        if digest != outer.codes.get("c1"):
                            return self._json(
                                {"error": "bad pkce"}, 400)
                    elif grant == "refresh_token":
                        outer.refresh_count += 1
                    else:
                        return self._json(
                            {"error": "bad grant"}, 400)
                    outer.token_n += 1
                    tok = "acc-%d" % outer.token_n
                    outer.tokens.add(tok)
                    return self._json({
                        "access_token": tok,
                        "refresh_token": "ref-1",
                        "expires_in": 3600,
                        "token_type": "Bearer"})
                if u.path == "/mcp":
                    auth = self.headers.get("Authorization")
                    token = (auth or "").replace(
                        "Bearer ", "")
                    if token not in outer.tokens:
                        self.send_response(401)
                        self.send_header(
                            "Content-Length", "0")
                        self.end_headers()
                        return
                    msg = json.loads(body.decode()) \
                        if body else {}
                    mid = msg.get("id")
                    if mid is None:
                        self.send_response(202)
                        self.send_header(
                            "Content-Length", "0")
                        self.end_headers()
                        return
                    method = msg.get("method")
                    if method == "initialize":
                        result = {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {},
                            "serverInfo": {
                                "name": "oauthfx",
                                "version": "1"}}
                    elif method == "tools/list":
                        result = {"tools": [{
                            "name": "whoami",
                            "description": "Report caller.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {}}}]}
                    elif method == "tools/call":
                        result = {"content": [{
                            "type": "text",
                            "text": "token: " + token}],
                            "isError": False}
                    else:
                        result = {}
                    return self._json({"jsonrpc": "2.0",
                                       "id": mid,
                                       "result": result})
                return self._json({"error": "nope"}, 404)

        self.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True)

    @property
    def url(self):
        return "http://127.0.0.1:%d/mcp" % \
            self.server.server_address[1]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        return False


class TestMcpServerE2E(unittest.TestCase):
    TOKEN = "Bearer e2e-secret-token"

    def setUp(self):
        self.td = Path(tempfile.mkdtemp(
            prefix="ghostide-d8e2e-"))
        self.app = self.td / "app"
        self.app.mkdir()
        for f in ("server.py", "ghost_paths.py",
                  "updater.py", "workspace_trust.py",
                  "lsp_manager.py", "embed_index.py", "debug_bridge.py",
                  "VERSION.json"):
            shutil.copy(REPO / f, self.app / f)
        (self.app / "web").mkdir()
        (self.app / "web" / "index.html").write_text(
            "<html></html>")
        (self.app / "playground").mkdir()
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

    def start_server(self, ws):
        port = free_port()
        env = dict(os.environ)
        env.update({
            "HOME": str(self.td / "home"),
            "GHOST_IDE_PORT": str(port),
            "GHOST_IDE_WORKSPACE": str(ws),
            "GHOSTIDE_ECO_HOME": str(REPO.parent),
            "LLAMA_BASE": "http://127.0.0.1:%d"
                          % self.llama_port,
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        proc = subprocess.Popen(
            [sys.executable, str(self.app / "server.py")],
            cwd=str(self.app), env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True)
        self.procs.append(proc)
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                st, _ = call(port, "GET", "/api/health",
                             timeout=2)
                if st == 200:
                    return port
            except Exception:
                pass
            if proc.poll() is not None:
                raise AssertionError(
                    "server exited early:\n"
                    + proc.stdout.read())
            time.sleep(0.2)
        raise AssertionError("server did not come up")

    def test_stdio_policy_and_http_header_auth(self):
        ws = self.td / "ws"
        ws.mkdir()
        fixture = ws / "fake_mcp_server.py"
        shutil.copy(
            REPO / "tests" / "fixtures"
            / "fake_mcp_server.py", fixture)
        log = self.td / "calls.log"
        with McpHttpFixture(expect=self.TOKEN) as httpfx:
            (ws / ".mcp.json").write_text(json.dumps({
                "mcpServers": {
                    "fx": {"command": sys.executable,
                           "args": [str(fixture)],
                           "env": {"FAKE_MCP_LOG":
                                   str(log)}},
                    "web": {"url": httpfx.url}}}))
            port = self.start_server(ws)
            st, health = call(port, "GET", "/api/health")
            self.assertEqual(health["version"], "3.22.0")
            self.assertTrue(health["trusted"])

            # Tools carry annotations + policy defaults.
            st, td = call(port, "POST", "/api/mcp/tools",
                          {"server": "fx"})
            self.assertEqual(st, 200, td)
            tools = {t["name"]: t for t in td["tools"]}
            self.assertEqual(
                tools["echo"]["annotations"]
                ["readOnlyHint"], True)
            self.assertEqual(
                tools["write_note"]["annotations"]
                ["destructiveHint"], True)
            self.assertTrue(tools["echo"]["enabled"])
            self.assertEqual(tools["echo"]["approval"],
                             "ask")

            # A normal call lands; then disabling the
            # tool refuses it server-side and the fixture
            # never sees the call.
            st, cd = call(port, "POST", "/api/mcp/call",
                          {"server": "fx", "tool": "echo",
                           "arguments": {"text": "hi"}})
            self.assertIn("echo: hi", cd.get("text", ""))
            st, pd = call(port, "POST", "/api/mcp/policy",
                          {"server": "fx",
                           "tool": "write_note",
                           "enabled": False})
            self.assertEqual(st, 200, pd)
            st, cd = call(port, "POST", "/api/mcp/call",
                          {"server": "fx",
                           "tool": "write_note",
                           "arguments": {"text": "x"}})
            self.assertEqual(st, 400)
            self.assertIn("disabled", cd["error"])
            self.assertEqual(
                log.read_text().strip().splitlines(),
                ["call echo"])
            st, pv = call(port, "GET", "/api/mcp/policy")
            self.assertFalse(
                pv["servers"]["fx"]["tools"]
                ["write_note"]["enabled"])
            self.assertTrue(
                (ws / ".ghostide"
                 / "mcp-policy.json").is_file())

            # Allow-mode persists too.
            st, pd = call(port, "POST", "/api/mcp/policy",
                          {"server": "fx", "tool": "echo",
                           "approval": "allow"})
            self.assertEqual(
                pd["servers"]["fx"]["tools"]["echo"]
                ["approval"], "allow")

            # The HTTP server refuses us until the header
            # is stored through the config API.
            st, cd = call(port, "POST", "/api/mcp/call",
                          {"server": "web",
                           "tool": "whoami",
                           "arguments": {}})
            self.assertEqual(st, 400)
            st, cv = call(port, "POST",
                          "/api/mcp/config/server",
                          {"name": "web",
                           "entry": {"url": httpfx.url,
                                     "headers": {
                                         "Authorization":
                                             self.TOKEN}}})
            self.assertEqual(st, 200, cv)
            self.assertNotIn(self.TOKEN, json.dumps(cv))
            st, cd = call(port, "POST", "/api/mcp/call",
                          {"server": "web",
                           "tool": "whoami",
                           "arguments": {}})
            self.assertEqual(st, 200, cd)
            self.assertIn("auth:", cd.get("text", ""))

            # Status: web connected; then disabling fx at
            # server level shows "disabled" and refuses.
            st, sd = call(port, "GET", "/api/mcp/status")
            rows = {r["name"]: r for r in sd["servers"]}
            self.assertEqual(rows["web"]["status"],
                             "connected")
            self.assertEqual(rows["web"]["label"],
                             "Remote server")
            self.assertEqual(rows["fx"]["label"],
                             "Runs commands on this "
                             "computer")
            st, pd = call(port, "POST", "/api/mcp/policy",
                          {"server": "fx",
                           "server_enabled": False})
            st, cd = call(port, "POST", "/api/mcp/call",
                          {"server": "fx", "tool": "echo",
                           "arguments": {"text": "hi"}})
            self.assertEqual(st, 400)
            st, sd = call(port, "GET", "/api/mcp/status")
            rows = {r["name"]: r for r in sd["servers"]}
            self.assertEqual(rows["fx"]["status"],
                             "disabled")

            # Catalog + import over HTTP.
            st, cat = call(port, "GET", "/api/mcp/catalog")
            ids = [c["id"] for c in cat["catalog"]]
            self.assertIn("filesystem", ids)
            fs = [c for c in cat["catalog"]
                  if c["id"] == "filesystem"][0]
            self.assertIn(str(ws), fs["entry"]["args"][-1])
            st, imp = call(port, "POST",
                           "/api/mcp/config/import",
                           {"text": json.dumps({
                               "mcpServers": {
                                   "imp": {"command": "npx",
                                           "args": ["-y",
                                                    "p"]},
                                   "bad": {"args": []}}})})
            self.assertEqual(imp["imported"], ["imp"])
            self.assertIn("bad", imp["errors"])
            st, cv = call(port, "GET", "/api/mcp/config")
            names = [s["name"] for s in cv["servers"]]
            self.assertIn("imp", names)

    def test_oauth_connect_and_refresh(self):
        ws = self.td / "ws2"
        ws.mkdir()
        with OAuthMcpFixture() as fx:
            (ws / ".mcp.json").write_text(json.dumps({
                "mcpServers": {"oauthfx": {
                    "url": fx.url, "oauth": True}}}))
            port = self.start_server(ws)
            st, sd = call(port, "GET", "/api/mcp/status")
            rows = {r["name"]: r for r in sd["servers"]}
            self.assertEqual(rows["oauthfx"]["status"],
                             "needs-auth")
            st, od = call(port, "POST",
                          "/api/mcp/oauth/start",
                          {"server": "oauthfx"})
            self.assertEqual(st, 200, od)
            # A browser would follow the authorize URL;
            # urllib follows the 302 into our callback,
            # which performs the exchange.
            st, page = get_raw(port, "/api/health")
            with urllib.request.urlopen(
                    od["auth_url"], timeout=15) as r:
                body = r.read().decode()
            self.assertIn("Connected", body)
            st, cd = call(port, "POST", "/api/mcp/call",
                          {"server": "oauthfx",
                           "tool": "whoami",
                           "arguments": {}})
            self.assertEqual(st, 200, cd)
            self.assertIn("token: acc-1",
                          cd.get("text", ""))
            # Expire the stored token; the next call must
            # refresh (fixture counts it) and use acc-2.
            store_path = self.td / "home" / ".ghostide" \
                / "mcp-oauth.json"
            store = json.loads(store_path.read_text())
            store["oauthfx"]["expires_at"] = 1
            store_path.write_text(json.dumps(store))
            st, cd = call(port, "POST", "/api/mcp/call",
                          {"server": "oauthfx",
                           "tool": "whoami",
                           "arguments": {}})
            self.assertEqual(st, 200, cd)
            self.assertIn("token: acc-2",
                          cd.get("text", ""))
            self.assertEqual(fx.refresh_count, 1)
            st, sd = call(port, "GET", "/api/mcp/status")
            rows = {r["name"]: r for r in sd["servers"]}
            self.assertEqual(rows["oauthfx"]["status"],
                             "connected")


if __name__ == "__main__":
    unittest.main()
