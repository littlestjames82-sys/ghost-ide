#!/usr/bin/env python3
"""GhostIDE backend.

Stdlib-only server that:
- serves the web IDE (web/)
- provides a workspace-confined file API (list / read / write / create)
- proxies chat + infill to the local llama.cpp server (Qwen2.5-Coder)
- can start the model server if it is not already running

Run:  python3 server.py            (http://127.0.0.1:5173)
Env:  GHOST_IDE_PORT, GHOST_IDE_WORKSPACE, LLAMA_BASE,
      LLAMA_SERVER_BIN, GHOST_IDE_MODEL
"""
import http.client
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
WORKSPACE = Path(os.environ.get(
    "GHOST_IDE_WORKSPACE", ROOT / "playground")).resolve()
PORT = int(os.environ.get("GHOST_IDE_PORT", "5173"))
HOST = os.environ.get("GHOST_IDE_HOST", "127.0.0.1")
APP_VERSION = "3.25.0"
FROZEN = getattr(sys, "frozen", False)

# Desktop Cycle 1 (v3.11.0): portable mode, the desktop
# updater and workspace trust live in sibling modules so
# they can be unit-tested without the server. ghost_paths
# is the one place that decides where app data lives:
# ~/.ghostide by default, ghostide-data/ beside the app
# in portable mode (--portable or GHOSTIDE_PORTABLE=1).
if str(ROOT) not in sys.path:
    # Sibling modules must resolve however the server was
    # loaded: as a script (dir is sys.path[0] already),
    # frozen, or imported by the probe suites.
    sys.path.insert(0, str(ROOT))
import ghost_paths
import lsp_manager as _lsp_mod
import updater as _updater_mod
import workspace_trust as _trust_mod

PORTABLE = ghost_paths.portable_requested()
APP_BASE = ghost_paths.app_base(ROOT, frozen=FROZEN)
DATA_DIR = ghost_paths.data_dir(ROOT, frozen=FROZEN)
UPDATE_MANIFEST_URL = os.environ.get(
    "GHOST_IDE_UPDATE_MANIFEST",
    _updater_mod.DEFAULT_MANIFEST_URL)

TRUST_STORE = _trust_mod.TrustStore(
    DATA_DIR / "trusted-workspaces.json")


def workspace_trusted():
    """D7: the open workspace's trust decision. Unknown
    folders are untrusted until the user decides."""
    return TRUST_STORE.is_trusted(WORKSPACE)


# Routes that execute code or drive tools on the
# workspace's behalf. While the workspace is untrusted
# these are refused at the API layer (403), not merely
# hidden in the UI: terminal, run/tests/debug/REPL, MCP
# tool calls and prompts, and the agent's tool runners.
TRUST_EXEC_ROUTES = frozenset({
    "/api/terminal", "/api/terminal/reset",
    "/api/run", "/api/tests/run",
    "/api/debug/start", "/api/debug/cmd", "/api/repl",
    "/api/mcp/call", "/api/mcp/prompt", "/api/mcp/restart",
    "/api/eco/run", "/api/eco/toolrun",
    "/api/ghostre/run", "/api/rea/run",
    "/api/verify/run", "/api/refactor",
    # D4 (Desktop Cycle 2): LSP routes spawn and drive
    # language server processes, so they sit behind the
    # same trust gate. The read-only GETs (status,
    # diagnostics) spawn nothing and stay open.
    "/api/lsp/open", "/api/lsp/change", "/api/lsp/close",
    "/api/lsp/save", "/api/lsp/hover",
    "/api/lsp/definition", "/api/lsp/completion",
    "/api/lsp/symbols", "/api/lsp/restart",
    "/api/lsp/install",
    # D5 (Desktop Cycle 3): an embedding build reads the
    # whole workspace and a neural search starts the
    # embedding server process, so both sit behind the
    # same gate. The status/download GETs and the model
    # download POST spawn nothing and follow the
    # /api/model/download precedent (open).
    "/api/embed/build", "/api/embed/search",
})


def _trust_denied(handler):
    return handler.send_json(
        {"error": "this workspace is not trusted yet: "
                  "agent actions, terminal and MCP tools "
                  "stay off until you trust the folder",
         "code": "workspace-untrusted"}, status=403)


def _mcp_host_only(handler):
    """D8: MCP policy/config/OAuth changes are settings
    of the host machine (they can carry credentials), so
    - exactly like POST /api/trust - pair guests may not
    make them. Returns True when the caller may proceed."""
    if handler.client_address[0] in ("127.0.0.1", "::1"):
        return True
    handler.send_json(
        {"error": "MCP settings are changed on the host"},
        status=403)
    return False


# Desktop Cycle 2, D2 (agent trust layer): run records.
# At the end of a run the client posts one JSON record
# per run; the server stores it under
# .ghostide/agent-runs/<id>.json. A record is DATA: it
# is shape-checked (object, kind, id, size, step count)
# and stored verbatim, never executed and never
# interpreted beyond the summary fields the list view
# reads. Writing one is a plain workspace file write,
# so - exactly like POST /api/file, which is also not
# in TRUST_EXEC_ROUTES - it is not trust-gated; the
# trust gate covers routes that execute code or drive
# tools, and recording a finished run does neither.
import re as _agent_run_re

AGENT_RUN_MAX_BYTES = 256 * 1024
AGENT_RUN_MAX_STEPS = 400
AGENT_RUN_ID_RE = _agent_run_re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


def _agent_runs_dir():
    return WORKSPACE / ".ghostide" / "agent-runs"


def _agent_run_path(run_id):
    if not AGENT_RUN_ID_RE.match(run_id or "") \
            or ".." in run_id:
        raise ValueError("bad run id")
    return _agent_runs_dir() / (run_id + ".json")


def _save_agent_run(data, raw_len):
    if raw_len > AGENT_RUN_MAX_BYTES:
        raise ValueError(
            "run record too large (limit %d bytes)"
            % AGENT_RUN_MAX_BYTES)
    if not isinstance(data, dict):
        raise ValueError("run record must be a JSON object")
    if data.get("kind") != "ghostide-agent-run":
        raise ValueError("not a GhostIDE agent run record")
    run_id = str(data.get("id") or "")
    p = _agent_run_path(run_id)
    steps = data.get("steps")
    if steps is not None and (
            not isinstance(steps, list)
            or len(steps) > AGENT_RUN_MAX_STEPS):
        raise ValueError(
            "run record steps must be a list of at most %d"
            % AGENT_RUN_MAX_STEPS)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.parent / (".%s.tmp-%d" % (p.name, os.getpid()))
    try:
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, p)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return ".ghostide/agent-runs/" + run_id + ".json"


def _list_agent_runs():
    d = _agent_runs_dir()
    out = []
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            try:
                rec = json.loads(p.read_text())
            except Exception:
                continue
            if not isinstance(rec, dict) \
                    or rec.get("kind") != "ghostide-agent-run":
                continue
            out.append({
                "id": rec.get("id") or p.stem,
                "task": str(rec.get("task") or "")[:200],
                "mode": rec.get("mode") or "act",
                "outcome": rec.get("outcome") or "",
                "startedAt": rec.get("startedAt") or "",
                "endedAt": rec.get("endedAt") or "",
                "files": len(rec.get("filesChanged") or []),
                "checkpoint": rec.get("checkpoint"),
                "planPath": rec.get("planPath"),
            })
    out.sort(key=lambda r: r["endedAt"] or r["startedAt"],
             reverse=True)
    return out[:100]


# Mobile Cycle 3, S1 (portable task/session format): task
# records. ONE schema both platforms - docs/TASK_FORMAT.md
# is the definition and IdeServer.java mirrors it. A task
# record is DATA in the D2 sense: shape-checked strictly,
# stored verbatim under .ghostide/tasks/<id>.json, never
# executed. It describes work; it does not resume work
# (resuming is M2). Like the run records, writing one is a
# plain workspace file write, so these routes are not
# trust-gated either.
TASK_MAX_BYTES = 256 * 1024
TASK_SCHEMA = "ghostide.task"
TASK_SCHEMA_VERSION = 1
TASK_KINDS = ("agent-run", "plan", "note")
TASK_STATUSES = ("draft", "running", "waiting-approval",
                 "stopped", "done", "failed")
TASK_ID_RE = _agent_run_re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
_TASK_TS_RE = _agent_run_re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"
    r"(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$")


def _tasks_dir():
    return WORKSPACE / ".ghostide" / "tasks"


def _task_path(task_id):
    if not TASK_ID_RE.match(task_id or "") \
            or ".." in task_id:
        raise ValueError("bad task id")
    return _tasks_dir() / (task_id + ".json")


def _task_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _validate_task(data, raw_len):
    """The shared strict validation from
    docs/TASK_FORMAT.md, in the document's order, refusing
    with the document's words. Returns the record."""
    if raw_len > TASK_MAX_BYTES:
        raise ValueError(
            "task record too large (limit %d bytes)"
            % TASK_MAX_BYTES)
    if not isinstance(data, dict):
        raise ValueError("task record must be a JSON object")
    if data.get("schema") != TASK_SCHEMA:
        raise ValueError("not a GhostIDE task record")
    ver = data.get("schemaVersion")
    if not _task_int(ver):
        raise ValueError(
            "task record has no readable schema version")
    if ver > TASK_SCHEMA_VERSION:
        raise ValueError(
            "task record was written by a newer GhostIDE "
            "(task schema version %d); this build reads "
            "version %d" % (ver, TASK_SCHEMA_VERSION))
    if ver < 1:
        raise ValueError(
            "task record schema version %d is older than "
            "any this build can read" % ver)
    task_id = data.get("id")
    if not isinstance(task_id, str) \
            or not TASK_ID_RE.match(task_id) \
            or ".." in task_id:
        raise ValueError("bad task id")
    if data.get("kind") not in TASK_KINDS:
        raise ValueError(
            "task record kind must be one of "
            + ", ".join(TASK_KINDS))
    title = data.get("title")
    if not isinstance(title, str) \
            or not 1 <= len(title) <= 200:
        raise ValueError(
            "task record title must be a string of 1 to "
            "200 characters")
    goal = data.get("goal")
    if not isinstance(goal, str) or len(goal) > 20000:
        raise ValueError(
            "task record goal must be a string of at "
            "most 20000 characters")
    ws = data.get("workspace")
    if not isinstance(ws, str) or len(ws) > 1000:
        raise ValueError(
            "task record workspace must be a string of "
            "at most 1000 characters")
    if data.get("createdBy") not in ("desktop", "android"):
        raise ValueError(
            "task record createdBy must be desktop or "
            "android")
    if data.get("status") not in TASK_STATUSES:
        raise ValueError(
            "task record status must be one of "
            + ", ".join(TASK_STATUSES))
    budget = data.get("budget")
    if not isinstance(budget, dict) \
            or not _task_int(budget.get("stepCap")) \
            or not 0 <= budget["stepCap"] <= 100000:
        raise ValueError(
            "task record budget.stepCap must be an "
            "integer from 0 to 100000")
    appr = data.get("approvals")
    if not isinstance(appr, dict) or any(
            not _task_int(appr.get(k)) or appr.get(k) < 0
            for k in ("asked", "allowed", "denied")):
        raise ValueError(
            "task record approvals must be an object "
            "with asked, allowed and denied counts at "
            "or above 0")
    steps = data.get("steps")
    if not isinstance(steps, dict) \
            or not _task_int(steps.get("count")) \
            or steps["count"] < 0 \
            or not isinstance(steps.get("lastLabel"), str) \
            or len(steps["lastLabel"]) > 300:
        raise ValueError(
            "task record steps must be an object with "
            "a count at or above 0 and a lastLabel "
            "string of at most 300 characters")
    for key in ("checkpoint", "planPath"):
        v = data.get(key)
        if v is not None and (not isinstance(v, str)
                              or len(v) > 1000):
            raise ValueError(
                "task record %s must be a string of at "
                "most 1000 characters or null" % key)
    for key in ("createdAt", "updatedAt"):
        v = data.get(key)
        if not isinstance(v, str) or not _TASK_TS_RE.match(v):
            raise ValueError(
                "task record %s must be an ISO 8601 "
                "timestamp string" % key)
    if "provenance" in data \
            and not isinstance(data["provenance"], dict):
        raise ValueError(
            "task record provenance must be an object")
    if "payload" in data \
            and not isinstance(data["payload"], dict):
        raise ValueError(
            "task record payload must be an object")
    return data


def _save_task(data, raw_len, must_exist=False):
    rec = _validate_task(data, raw_len)
    p = _task_path(str(rec["id"]))
    if must_exist and not p.is_file():
        raise FileNotFoundError("no such task record")
    if not must_exist and p.is_file():
        raise FileExistsError(
            "a task record with this id already exists; "
            "update it instead")
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.parent / (".%s.tmp-%d" % (p.name, os.getpid()))
    try:
        tmp.write_text(json.dumps(rec, indent=1))
        os.replace(tmp, p)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    return ".ghostide/tasks/" + str(rec["id"]) + ".json"


def _list_tasks():
    d = _tasks_dir()
    out = []
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            try:
                rec = json.loads(p.read_text())
                # Shape only (raw_len 0): the size cap is
                # enforced on the way in by _save_task,
                # and the stored pretty-printed file can
                # be larger than the posted body.
                _validate_task(rec, 0)
            except Exception:
                continue
            steps = rec.get("steps") or {}
            out.append({
                "id": rec["id"],
                "kind": rec["kind"],
                "title": rec["title"],
                "status": rec["status"],
                "createdBy": rec["createdBy"],
                "createdAt": rec["createdAt"],
                "updatedAt": rec["updatedAt"],
                "steps": steps.get("count", 0),
            })
    out.sort(key=lambda r: r["updatedAt"], reverse=True)
    return out[:100]


def _task_canonical(v):
    """The canonical form from docs/TASK_FORMAT.md:
    sorted keys, no spare whitespace, integral numbers
    without a decimal point. IdeServer's TaskStore
    implements the same form; the shared fixture proves
    the two agree byte for byte."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v == int(v) and abs(v) < 1e15:
            return str(int(v))
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(
            _task_canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":"
            + _task_canonical(v[k])
            for k in sorted(v)) + "}"
    raise TypeError("not a JSON value: %r" % type(v))


_UPDATER = None


def get_updater():
    global _UPDATER
    if _UPDATER is None:
        _UPDATER = _updater_mod.Updater(
            DATA_DIR, APP_VERSION,
            app_dir=APP_BASE, frozen=FROZEN,
            manifest_url=UPDATE_MANIFEST_URL)
    return _UPDATER


_LSP = None


def get_lsp():
    """D4: the language server manager. Follows the
    live WORKSPACE global and the trust store, so a
    workspace switch or a trust decision takes effect
    without rebuilding it."""
    global _LSP
    if _LSP is None:
        _LSP = _lsp_mod.LspManager(
            DATA_DIR,
            workspace_fn=lambda: WORKSPACE,
            trusted_fn=workspace_trusted,
            python_cmd=py_cmd)
    return _LSP


def _lsp_locations(result):
    """Normalise an LSP definition result (Location,
    Location[] or LocationLink[]) into workspace-relative
    jumps the UI can act on directly."""
    if not result:
        return []
    items = result if isinstance(result, list) else [result]
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        uri = it.get("uri") or it.get("targetUri") or ""
        rng = it.get("range") or it.get("targetSelectionRange") \
            or it.get("targetRange") or {}
        start = rng.get("start") or {}
        end = rng.get("end") or start
        p = _lsp_mod.uri_to_path(uri)
        if p is None:
            continue
        try:
            rel = str(Path(p).relative_to(WORKSPACE))
        except ValueError:
            rel = p
        out.append({
            "path": rel, "uri": uri,
            "line": int(start.get("line", 0)),
            "character": int(start.get("character", 0)),
            "endLine": int(end.get("line",
                                   start.get("line", 0))),
            "endCharacter": int(end.get(
                "character", start.get("character", 0)))})
    return out
UPDATE_URL = os.environ.get(
    "GHOST_IDE_UPDATE_URL",
    "https://raw.githubusercontent.com/littlestjames82-sys"
    "/ghost-ide/main/VERSION.json")
LLAMA_BASE = os.environ.get("LLAMA_BASE", "http://127.0.0.1:8080")
PAIR_PEERS = {}  # Roadmap G16: pair-mode presence, id -> peer dict


def pair_snapshot():
    """Live pair peers; entries older than 25 s are pruned."""
    now = time.time()
    for k in [k for k, v in list(PAIR_PEERS.items())
              if now - v["seen"] > 25]:
        PAIR_PEERS.pop(k, None)
    return [dict(v) for v in list(PAIR_PEERS.values())]


# Encrypted backup (Roadmap G17). One format on both builds
# (BackupCrypto.java on the phone mirrors this exactly):
# PBKDF2-HMAC-SHA256 (200k rounds, random salt) derives an
# encryption key + a MAC key; the workspace zip is XORed
# with an HMAC-SHA256 keystream keyed by a random nonce,
# and the MAC covers salt || nonce || ciphertext
# (encrypt-then-MAC). A wrong passphrase fails the MAC.
BACKUP_ITER = 200000
MAX_BODY_BYTES = 64 * 1024 * 1024

# Pair trust (item 12): a per-boot 6-digit code gates
# every /api route for non-loopback callers; loopback
# (the host's own UI) is trusted. See PAIRING.md.
import secrets as _secrets
PAIR_CODE = "%06d" % _secrets.randbelow(1000000)
PAIR_TOKENS = {}
PAIR_POLICY = {"viewOnly": False}

PAIR_MAX_FAILS = 5
PAIR_WINDOW = 600.0
PAIR_LOCK = 600.0
PAIR_FAILS = {}


def pair_join_locked(ip, now):
    """True while this source is locked out of the
    join endpoint after repeated wrong codes."""
    rec = PAIR_FAILS.get(ip)
    return bool(rec and rec[2] > now)


def pair_join_record(ip, ok, now):
    if ok:
        PAIR_FAILS.pop(ip, None)
        return
    rec = PAIR_FAILS.get(ip)
    if rec is None or now - rec[1] > PAIR_WINDOW:
        rec = [0, now, 0.0]
    rec[0] += 1
    if rec[0] >= PAIR_MAX_FAILS:
        rec[2] = now + PAIR_LOCK
    PAIR_FAILS[ip] = rec


PAIR_TOKEN_TTL = 12 * 3600.0


def pair_token_valid(tok, now):
    """True while tok names a live guest token.
    v2.32: tokens expire PAIR_TOKEN_TTL after
    issue; an expired token is forgotten, and the
    guest re-joins through the normal 401 path."""
    rec = PAIR_TOKENS.get(tok)
    if rec is None:
        return False
    if now - rec[1] > PAIR_TOKEN_TTL:
        PAIR_TOKENS.pop(tok, None)
        return False
    return True


# LAN TLS (v2.38, design draft Oct 22, 2026; Ryan's six
# decisions: accept the browser click-through, one
# persistent cert per host, desktop host first with the
# phone always a guest, plain-HTTP fallback with a loud
# warning when no cert can be made). In LAN mode the
# desktop host serves HTTPS with a self-signed cert
# whose SHA-256 fingerprint is the host's identity:
# guests compare it with the host screen before typing
# the code. The code stays the secret; the fingerprint
# is public. Loopback keeps serving plain HTTP (the
# host's own UI never warns). LAN mode only; a
# loopback-only server never makes a cert.
import base64 as _b64
import hashlib as _hashlib
import ipaddress as _ipaddr
import shutil as _shutil
import socket as _socket
import ssl as _ssl

TLS_DIR = Path(os.environ.get(
    "GHOST_IDE_TLS_DIR",
    DATA_DIR / "tls")).resolve()
TLS_CERT = TLS_DIR / "host-cert.pem"
TLS_KEY = TLS_DIR / "host-key.pem"
TLS_META = TLS_DIR / "host-cert.json"
TLS_STATE = {"active": False, "fingerprint": None}


def _lan_ips():
    """This machine's private / link-local IPv4
    addresses plus loopback, for the cert SAN list."""
    ips = {"127.0.0.1"}
    try:
        for info in _socket.getaddrinfo(
                _socket.gethostname(), None,
                _socket.AF_INET):
            ip = info[4][0]
            try:
                a = _ipaddr.ip_address(ip)
            except ValueError:
                continue
            if a.is_loopback:
                continue
            if a.is_private or a.is_link_local:
                ips.add(ip)
    except OSError:
        pass
    try:
        s = _socket.socket(_socket.AF_INET,
                           _socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        a = _ipaddr.ip_address(s.getsockname()[0])
        s.close()
        if a.is_private or a.is_link_local:
            ips.add(str(a))
    except OSError:
        pass
    if HOST not in ("127.0.0.1", "localhost", "::1",
                    "0.0.0.0"):
        ips.add(HOST)
    return sorted(ips)


def _cert_fp(cert_pem_bytes):
    """SHA-256 fingerprint of a PEM cert, colon-grouped
    hex (the display form browsers use)."""
    body = b"".join(
        ln.strip() for ln in cert_pem_bytes.splitlines()
        if ln and b"---" not in ln)
    der = _b64.b64decode(body)
    h = _hashlib.sha256(der).hexdigest().upper()
    return ":".join(h[i:i + 2] for i in range(0, len(h), 2))


def _gen_cert_crypto(ips, cert_path, key_path):
    """Mint the self-signed host cert with the
    cryptography package (the backup-v2 dependency)."""
    import datetime as _dt
    from cryptography import x509
    from cryptography.hazmat.primitives import (
        hashes, serialization)
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key = rsa.generate_private_key(
        public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(
        NameOID.COMMON_NAME, "GhostIDE host")])
    now = _dt.datetime.now(_dt.timezone.utc)
    sans = [x509.DNSName("localhost")]
    sans += [x509.IPAddress(_ipaddr.ip_address(i))
             for i in ips]
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - _dt.timedelta(days=1))
            .not_valid_after(now + _dt.timedelta(days=3650))
            .add_extension(
                x509.SubjectAlternativeName(sans),
                critical=False)
            .add_extension(x509.BasicConstraints(
                ca=True, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption()))
    cert_path.write_bytes(
        cert.public_bytes(serialization.Encoding.PEM))


def _gen_cert_openssl(ips, cert_path, key_path):
    """The same cert via the openssl CLI when the
    cryptography package is absent."""
    san = ",".join(["DNS:localhost"]
                   + ["IP:" + i for i in ips])
    cmd = ["openssl", "req", "-x509", "-newkey", "rsa:2048",
           "-keyout", str(key_path), "-out", str(cert_path),
           "-days", "3650", "-nodes",
           "-subj", "/CN=GhostIDE host",
           "-addext", "subjectAltName=" + san,
           "-addext", "basicConstraints=critical,CA:TRUE"]
    subprocess.run(cmd, check=True, capture_output=True,
                   timeout=60)


def ensure_host_cert():
    """Return (cert_path, key_path) for the persistent
    host cert, generating it when needed, or None when
    no generation route exists. A cert is regenerated
    only when the current address set outgrows its
    SANs; a changed fingerprint is announced on the
    console because guests must re-verify it."""
    ips = _lan_ips()
    if (TLS_CERT.exists() and TLS_KEY.exists()
            and TLS_META.exists()):
        try:
            meta = json.loads(TLS_META.read_text())
            if set(ips) <= set(meta.get("sans", [])):
                TLS_STATE["fingerprint"] = \
                    meta["fingerprint"]
                return (TLS_CERT, TLS_KEY)
        except (ValueError, KeyError, OSError):
            pass
    old_fp = None
    if TLS_CERT.exists():
        try:
            old_fp = _cert_fp(TLS_CERT.read_bytes())
        except Exception:
            old_fp = None
    TLS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(TLS_DIR, 0o700)
    except OSError:
        pass
    made = False
    try:
        _gen_cert_crypto(ips, TLS_CERT, TLS_KEY)
        made = True
    except Exception as e:
        # Visible, not silent: a broken crypto path
        # must not quietly become the openssl path.
        print("TLS: cryptography cert generation "
              f"failed ({e}); trying openssl.")
        made = False
    if not made and _shutil.which("openssl"):
        try:
            _gen_cert_openssl(ips, TLS_CERT, TLS_KEY)
            made = True
        except (subprocess.SubprocessError, OSError):
            made = False
    if not made:
        return None
    try:
        os.chmod(TLS_KEY, 0o600)
    except OSError:
        pass
    fp = _cert_fp(TLS_CERT.read_bytes())
    TLS_STATE["fingerprint"] = fp
    TLS_META.write_text(json.dumps(
        {"fingerprint": fp, "sans": ips}, indent=1))
    if old_fp and old_fp != fp:
        print("TLS: the host certificate changed (the "
              "network addresses moved or the old cert "
              "was removed). Guests must verify the NEW "
              "fingerprint before pairing again.")
    return (TLS_CERT, TLS_KEY)





def _bk_keys(passphrase, salt, iters):
    import hashlib
    master = hashlib.pbkdf2_hmac(
        "sha256", passphrase.encode("utf-8"), salt, iters,
        dklen=64)
    return master[:32], master[32:]


def _bk_crypt(enc_key, nonce, data):
    import hashlib
    import hmac
    out = bytearray(len(data))
    block = 0
    off = 0
    while off < len(data):
        ks = hmac.new(enc_key, nonce + block.to_bytes(8, "big"),
                      hashlib.sha256).digest()
        chunk = data[off:off + 32]
        for i, b in enumerate(chunk):
            out[off + i] = b ^ ks[i]
        off += len(chunk)
        block += 1
    return bytes(out)


_BK_ITER_MIN = 10000
_BK_ITER_MAX = 2000000
_BK_DATA_MAX = 512 * 1024 * 1024


def _bk_check_kdf(salt, iters):
    if not (8 <= len(salt) <= 64):
        raise ValueError(
            "damaged backup (salt length out of bounds)")
    if not (_BK_ITER_MIN <= iters <= _BK_ITER_MAX):
        raise ValueError("backup KDF parameters out of bounds")


def _aesgcm():
    try:
        from cryptography.hazmat.primitives.ciphers.aead \
            import AESGCM
        return AESGCM
    except Exception:
        return None


_ZIP_MAX_ENTRIES = 20000
_ZIP_MAX_ENTRY = 200 * 1024 * 1024
_ZIP_MAX_TOTAL = 512 * 1024 * 1024
# v2.34: free-space prechecks keep 8 MB of slack so a
# backup write or restore never takes the disk to
# absolute zero mid-operation.
_BK_SPACE_SLACK = 8 * 1024 * 1024


def _space_ok(free_bytes, needed_bytes):
    return free_bytes >= needed_bytes + _BK_SPACE_SLACK


def _zipguard_clean(name):
    """Hostile-ZIP entry rules, mirroring ZipGuard.java:
    drop empty/dot/dotdot parts, skip dot-prefixed
    parts and the top-level backups folder."""
    parts = []
    for part in str(name).replace("\\", "/").split("/"):
        if part in ("", ".", ".."):
            continue
        if part.startswith("."):
            return None
        parts.append(part)
    if not parts:
        return None
    clean = "/".join(parts)
    if clean == "backups" or clean.startswith("backups/"):
        return None
    return clean


def backup_encrypt(passphrase, zip_bytes, files, nbytes):
    import base64
    import hashlib
    import hmac
    import os
    AESGCM = _aesgcm()
    if AESGCM is not None:
        # v2: standard AES-256-GCM (AEAD), the format the
        # phone build writes. Needs the cryptography
        # package; without it the desktop keeps writing
        # v1 (see HARDENING_PLAN.md for the tradeoff).
        salt = os.urandom(16)
        iv = os.urandom(12)
        enc_key, _mac = _bk_keys(passphrase, salt, BACKUP_ITER)
        ct = AESGCM(enc_key).encrypt(iv, zip_bytes, None)
        env = {
            "app": "ghostide-backup", "v": 2,
            "createdBy": "GhostIDE",
            "appVersion": APP_VERSION,
            "cipher": "AES-256-GCM",
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "files": files, "bytes": nbytes,
            "kdf": {"algo": "PBKDF2-HMAC-SHA256",
                    "iter": BACKUP_ITER,
                    "salt": base64.b64encode(salt).decode()},
            "iv": base64.b64encode(iv).decode(),
            "data": base64.b64encode(ct).decode(),
        }
        return json.dumps(env, indent=1)
    salt = os.urandom(16)
    nonce = os.urandom(16)
    enc_key, mac_key = _bk_keys(passphrase, salt, BACKUP_ITER)
    ct = _bk_crypt(enc_key, nonce, zip_bytes)
    mac = hmac.new(mac_key, salt + nonce + ct,
                   hashlib.sha256).digest()
    env = {
        "app": "ghostide-backup", "v": 1,
        "createdBy": "GhostIDE",
        "appVersion": APP_VERSION,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "files": files, "bytes": nbytes,
        "kdf": {"algo": "PBKDF2-HMAC-SHA256", "iter": BACKUP_ITER,
                "salt": base64.b64encode(salt).decode()},
        "nonce": base64.b64encode(nonce).decode(),
        "mac": base64.b64encode(mac).decode(),
        "data": base64.b64encode(ct).decode(),
    }
    return json.dumps(env, indent=1)


def backup_decrypt(passphrase, text):
    import base64
    import hashlib
    import hmac
    env = json.loads(text)
    if env.get("app") != "ghostide-backup":
        raise ValueError("not a GhostIDE backup file")
    v = env.get("v")
    salt = base64.b64decode(env["kdf"]["salt"])
    iters = int(env["kdf"]["iter"])
    # Bounds BEFORE key derivation (audit P0: a hostile
    # file once controlled the iteration count).
    _bk_check_kdf(salt, iters)
    data_str = env["data"]
    if len(data_str) > _BK_DATA_MAX * 2:
        raise ValueError("damaged backup (payload too large)")
    ct = base64.b64decode(data_str)
    if len(ct) > _BK_DATA_MAX:
        raise ValueError("damaged backup (payload too large)")
    # v2.34: every envelope field is decoded and
    # length-checked BEFORE key derivation, so a
    # hostile file cannot make the server pay the
    # PBKDF2 cost for a backup that was never valid.
    iv = nonce = mac_want = None
    AESGCM = None
    if v == 2:
        iv = base64.b64decode(env["iv"])
        if not (12 <= len(iv) <= 16):
            raise ValueError(
                "damaged backup (iv length out of bounds)")
        AESGCM = _aesgcm()
        if AESGCM is None:
            raise ValueError(
                "this backup uses the v2 (AES-GCM) format; "
                "the desktop build needs the 'cryptography' "
                "package to restore it")
    elif v == 1:
        nonce = base64.b64decode(env["nonce"])
        if not (8 <= len(nonce) <= 32):
            raise ValueError(
                "damaged backup (nonce length out of bounds)")
        mac_want = base64.b64decode(env["mac"])
        if len(mac_want) != 32:
            raise ValueError(
                "damaged backup (mac length out of bounds)")
    else:
        raise ValueError(
            "unsupported backup version: %r" % (v,))
    enc_key, mac_key = _bk_keys(passphrase, salt, iters)
    if v == 2:
        try:
            return AESGCM(enc_key).decrypt(iv, ct, None)
        except Exception:
            raise ValueError(
                "wrong passphrase or damaged backup "
                "(integrity check failed)")
    mac = hmac.new(mac_key, salt + nonce + ct,
                   hashlib.sha256).digest()
    if not hmac.compare_digest(mac, mac_want):
        raise ValueError(
            "wrong passphrase or damaged backup "
            "(integrity check failed)")
    return _bk_crypt(enc_key, nonce, ct)


# The chat model catalog. Every entry is pinned by exact
# size + SHA-256 and downloads verify both before the file
# becomes a model (see _dl_worker). Pin provenance: the
# sizes and hashes are the HuggingFace LFS metadata for
# the files above, confirmed against real downloads of
# each asset (the 7B pin predates the store; the 0.5B,
# 1.5B and 3B pins were verified byte for byte in the
# Desktop Cycle 3 D6 build). The name/params/quant/ram_gb/
# blurb fields are the model store's card data (D6): one
# source, so a card can never drift from the downloader's
# pins. ram_gb is an ESTIMATE of the total RAM the model
# needs at this IDE's 8192-token context, labelled as an
# estimate wherever it is shown.
MODEL_CATALOG = {
    "0.5b": {
        "file": "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        "url": "https://huggingface.co/Qwen/"
               "Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/"
               "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
        "bytes": 491400064,
        "sha256": "1d9614638d18024d0fbb36575a15f1302a3adf044"
                  "df10345688ec4f6e1c4ff32",
        "name": "Qwen2.5-Coder-0.5B Instruct",
        "params": "0.5B", "quant": "Q4_K_M",
        "ram_gb": 1.2,
        "blurb": "Fastest in the catalog. Best for low "
                 "memory machines and quick completions.",
    },
    "1.5b": {
        "file": "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        "url": "https://huggingface.co/Qwen/"
               "Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/"
               "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        "bytes": 1117320768,
        "sha256": "cc324af070c2ecbfd324a30884d2f951a7ff756ab"
                  "a85cb811a6ec436933bb046",
        "name": "Qwen2.5-Coder-1.5B Instruct",
        "params": "1.5B", "quant": "Q4_K_M",
        "ram_gb": 2.2,
        "blurb": "Fast and light. A good fit for small "
                 "laptops and short sessions.",
    },
    "3b": {
        "file": "qwen2.5-coder-3b-instruct-q4_k_m.gguf",
        "url": "https://huggingface.co/Qwen/"
               "Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/"
               "qwen2.5-coder-3b-instruct-q4_k_m.gguf",
        "bytes": 2104932800,
        "sha256": "724fb256bec1ff062b2f65e4569e871ad2e95ab2a3"
                  "989723d1769c54294730b7",
        "name": "Qwen2.5-Coder-3B Instruct",
        "params": "3B", "quant": "Q4_K_M",
        "ram_gb": 3.6,
        "blurb": "Balanced. Noticeably stronger code than "
                 "the small models, still light to run.",
    },
    "7b": {
        "file": "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        "url": "https://huggingface.co/Qwen/"
               "Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/"
               "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        "bytes": 4683073536,
        "sha256": "509287f78cb4d4cf6b3843734733b914b2c158e43"
                  "e22a7f4bf5e963800894d3c",
        "name": "Qwen2.5-Coder-7B Instruct",
        "params": "7B", "quant": "Q4_K_M",
        "ram_gb": 6.5,
        "blurb": "Best quality in the catalog. The model "
                 "this IDE is tuned around.",
    },
}
MODELS_DIR = Path(os.environ.get(
    "GHOST_IDE_MODELS", DATA_DIR / "models"))


def _find_llama():
    env = os.environ.get("LLAMA_SERVER_BIN")
    if env:
        return env
    name = "llama-server.exe" if os.name == "nt" else "llama-server"
    # The fetched-runtime folder comes first (it is
    # DATA_DIR/llama in portable mode, the app folder's
    # llama/ otherwise; _llama_dir() is defined below, so
    # the portable case is spelled out here).
    fetched = (DATA_DIR / "llama" / name) if PORTABLE else \
        ((ROOT.parent if FROZEN else ROOT) / "llama" / name)
    for cand in (fetched,
                 ROOT / "llama" / name,
                 ROOT.parent / "llama" / name):
        if cand.is_file():
            return str(cand)
    return str(Path.home() / "workspace/tools/llama.cpp"
               "/llama-b11429" / name)


LLAMA_BIN = _find_llama()

# ------------- llama.cpp runtime fetch (G18) -------------
# The desktop packages no longer bundle llama.cpp (it was
# 46 MB of the October package). Like the 7B model, the
# runtime is fetched on first use from a PINNED upstream
# release and verified by SHA-256 before it is used. It
# lands in the app folder's llama/ directory, the first
# place _find_llama() searches. A llama-server that is
# already present (LLAMA_SERVER_BIN, a user's own install,
# or an earlier fetch) is honoured as-is: never downloaded
# over, never overwritten.
LLAMA_RELEASE = "b11429"
LLAMA_CATALOG = {
    "linux-x64": {
        "file": "llama-b11429-bin-ubuntu-x64.tar.gz",
        "bytes": 17693462,
        "sha256": "f6d25dde8f51133143d1453da4fd5f73b14512717"
                  "7612a283bf7995957af3392",
    },
    "macos-arm64": {
        "file": "llama-b11429-bin-macos-arm64.tar.gz",
        "bytes": 11971406,
        "sha256": "740288ec6887be94280a5dfa25b5e23a78285cab"
                  "104519e6c7e218904ee82459",
    },
    "macos-x64": {
        "file": "llama-b11429-bin-macos-x64.tar.gz",
        "bytes": 11487431,
        "sha256": "29ac3ea02be6bd143e824973f2cc5fa74bc409439"
                  "3a9eaab0ff6814f19dd8522",
    },
    "win-x64": {
        "file": "llama-b11429-bin-win-cpu-x64.zip",
        "bytes": 19398918,
        "sha256": "1283323272b04cd07905816a597a0da810918102"
                  "de958f4ff6f7bbaa70ed2efe",
    },
}
for _llama_entry in LLAMA_CATALOG.values():
    _llama_entry["url"] = (
        "https://github.com/ggml-org/llama.cpp/releases/"
        "download/" + LLAMA_RELEASE + "/"
        + _llama_entry["file"])

LLAMA_DL_STATE = {"state": "idle", "done": 0, "total": 0,
                  "error": ""}


def _llama_platform_key():
    import platform as _pf
    machine = _pf.machine().lower()
    if sys.platform.startswith("linux"):
        return ("linux-x64" if machine in ("x86_64", "amd64")
                else None)
    if sys.platform == "darwin":
        return ("macos-arm64" if machine == "arm64"
                else "macos-x64")
    if os.name == "nt":
        return ("win-x64" if machine in ("amd64", "x86_64")
                else None)
    return None


def _llama_dir():
    """Where a fetched llama.cpp lands: the llama/ folder
    of the app folder (beside the executable when frozen,
    the repo root in dev). Portable mode keeps it inside
    ghostide-data/ with the rest of the app data."""
    if PORTABLE:
        return DATA_DIR / "llama"
    base = ROOT.parent if FROZEN else ROOT
    return base / "llama"


def llama_present():
    """Re-resolve on every call, so a runtime fetched
    while the server is running is picked up without a
    restart, and a pre-existing install always wins."""
    global LLAMA_BIN
    LLAMA_BIN = _find_llama()
    return Path(LLAMA_BIN).is_file()


def llama_status():
    if llama_present():
        return "present"
    st = LLAMA_DL_STATE["state"]
    return st if st in ("downloading", "verifying",
                        "error") else "missing"


def _default_model():
    env = os.environ.get("GHOST_IDE_MODEL")
    if env:
        return env
    dl = MODELS_DIR / MODEL_CATALOG["7b"]["file"]
    if dl.is_file():
        return str(dl)
    return str(Path.home() / "workspace/downloads"
               "/qwen2.5-coder-7b-instruct-q4_k_m.gguf")


MODEL = _default_model()
MODEL_NAME = "qwen2.5-coder-7b"

DL_STATE = {"state": "idle", "done": 0, "total": 0,
            "error": "", "id": ""}

# Desktop Cycle 3, D6: download controls for the model
# store. Pause is honest about what it is: the worker
# stops the transfer at the next chunk and KEEPS the
# .part file, so a later Download resumes from it via the
# Range header (the worker already supported resume; D6
# just gives it a stop button). Cancel stops the
# transfer and deletes the .part file. One control dict
# per download worker (chat models, embedding model, URL
# imports); a worker clears both flags when it starts.
DL_CONTROL = {"pause": False, "cancel": False}
EMBED_DL_CONTROL = {"pause": False, "cancel": False}
IMPORT_DL_CONTROL = {"pause": False, "cancel": False}


class _DlStop(Exception):
    """Raised inside a download worker's read loop when
    the store asks it to pause or cancel."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def py_cmd():
    """Interpreter for spawned Python work (run / tests /
    debug / REPL / slices). Dev mode: this Python. Packaged
    (frozen): the app binary is not an interpreter, so use
    a python3 on PATH when one exists."""
    if not FROZEN:
        return [sys.executable]
    import shutil as _sh
    found = _sh.which("python3") or _sh.which("python")
    return [found] if found else [sys.executable]

_model_proc = None


def llama_health():
    try:
        with urllib.request.urlopen(LLAMA_BASE + "/health", timeout=2) as r:
            return json.load(r).get("status") == "ok"
    except Exception:
        return False


def start_model():
    global _model_proc
    if llama_health():
        return {"model": "up", "started": False}
    if _model_proc and _model_proc.poll() is None:
        return {"model": "loading", "started": False}
    if not llama_present():
        # G18: the runtime is not bundled any more; the
        # first Start model fetches it (the Settings row
        # shows progress). The editor keeps working
        # without it - only the AI waits.
        if os.environ.get("LLAMA_SERVER_BIN"):
            return {"model": "down", "llama": "missing",
                    "error": "LLAMA_SERVER_BIN points at a "
                             "missing llama-server"}
        if LLAMA_DL_STATE["state"] not in ("downloading",
                                           "verifying"):
            import threading
            threading.Thread(target=_llama_dl_worker,
                             daemon=True).start()
        return {"model": "down", "llama": "fetching",
                "error": "llama.cpp is not downloaded yet - "
                         "fetching it now; Settings shows "
                         "progress"}
    log = open(ROOT / "llama-server.log", "ab")
    _model_proc = subprocess.Popen(
        [LLAMA_BIN, "--model", MODEL, "--host", "127.0.0.1", "--port",
         str(urllib.parse.urlparse(LLAMA_BASE).port or 8080),
         "--ctx-size", "8192", "--threads", "4", "--alias", MODEL_NAME],
        stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        start_new_session=True)
    return {"model": "loading", "started": True}


def safe_path(rel):
    """Resolve a workspace-relative path, refusing escapes."""
    # R14: C0 controls and DEL are never legitimate
    # in a workspace path; refuse before resolution.
    if any(ord(c) < 32 or ord(c) == 127 for c in rel):
        raise ValueError("control characters in path")
    p = (WORKSPACE / rel).resolve()
    if p != WORKSPACE and WORKSPACE not in p.parents:
        raise ValueError("path escapes workspace")
    return p


# ---------------- Phase 2: desktop power tools ----------------
import shutil
import tempfile
import time

CTX_BUDGET_DEFAULT = 6000  # of the desktop model's 8192 ctx


def run_cmd(args, cwd, timeout=30, env=None):
    """Run a local command, returning (rc, stdout, stderr) truncated."""
    try:
        t0 = time.time()
        r = subprocess.run(args, cwd=str(cwd), capture_output=True,
                           text=True, timeout=timeout, env=env)
        ms = int((time.time() - t0) * 1000)
        return r.returncode, r.stdout[-65536:], r.stderr[-16384:], ms
    except FileNotFoundError:
        raise ValueError("not installed: " + args[0])
    except subprocess.TimeoutExpired:
        raise ValueError("timed out after %ss" % timeout)


def ghostslice_src():
    env = os.environ.get("GHOSTSLICE_SRC")
    if env and Path(env).is_dir():
        return env
    cand = Path.home() / "workspace/ghostslice/src"
    return str(cand) if cand.is_dir() else None


def make_context(mode, budget):
    """Build a chat context bundle with GhostSlice (Phase 2.2).

    The IDE does not grow a second context engine: it shells out to
    GhostSlice's export and reads the manifest it already produces.
    """
    src = ghostslice_src()
    if not src:
        raise ValueError("GhostSlice not found (set GHOSTSLICE_SRC)")
    mode = mode if mode in ("signatures", "full") else "signatures"
    budget = max(500, min(int(budget or CTX_BUDGET_DEFAULT), 200000))
    outdir = Path(tempfile.mkdtemp(prefix="ghostide-slice-"))
    env = dict(os.environ, PYTHONPATH=src)
    r = subprocess.run(
        [py_cmd()[0], "-m", "ghostslice", "export", str(WORKSPACE),
         "-o", str(outdir), "--mode", mode, "--fit", str(budget)],
        capture_output=True, text=True, timeout=180, env=env)
    manifest_p = outdir / "manifest.json"
    if not manifest_p.exists():
        raise ValueError("GhostSlice export failed: " +
                         (r.stderr or r.stdout)[-400:])
    manifest = json.loads(manifest_p.read_text())
    parts = []
    total_chars = 0
    for f in manifest.get("files", []):
        fp = outdir / "files" / f["path"]
        if not fp.is_file():
            continue
        content = fp.read_text(errors="replace")
        header = "===== %s (%s, ~%s tok) =====\n" % (
            f["path"], f.get("mode", mode), f.get("sliced_tokens", "?"))
        parts.append(header + content)
        total_chars += len(header) + len(content)
        if total_chars > 400000:
            break
    shutil.rmtree(outdir, ignore_errors=True)
    tokens = manifest.get("total_sliced_tokens", 0)
    return {
        "text": "\n\n".join(parts),
        "tokens": tokens,
        "originalTokens": manifest.get("total_original_tokens", 0),
        "files": len(manifest.get("files", [])),
        "mode": mode,
        "budget": budget,
        "over": tokens > budget,
    }


def iter_text_files():
    for p in sorted(WORKSPACE.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(WORKSPACE)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if p.stat().st_size > 512 * 1024:
            continue
        yield rel, p


def snapshot_history(p, new_content):
    """Local History (Phase 11): before a save overwrites a file,
    stash the previous on-disk content under
    .ghostide-history/<rel>/<name>.<timestamp>.snap - a dot folder
    every lister/searcher in this project already skips. Keeps the
    newest 20 snapshots per file. Best-effort: history must never
    break a save."""
    try:
        if not p.is_file():
            return
        old = p.read_text(errors="strict")
        if old == new_content:
            return
        rel = p.relative_to(WORKSPACE)
        hdir = WORKSPACE / ".ghostide-history" / rel.parent
        hdir.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        snap = hdir / (rel.name + "." + ts + ".snap")
        n = 1
        while snap.exists():
            snap = hdir / (rel.name + "." + ts + "-" + str(n)
                           + ".snap")
            n += 1
        snap.write_text(old)
        snaps = sorted(hdir.glob(rel.name + ".*.snap"))
        for extra in snaps[:-20]:
            extra.unlink()
    except Exception:
        pass


def check_output_info(output):
    """Parse a checker transcript into (line, message): the line
    is the LAST 'line N' in the text (tracebacks list interpreter
    internals first); the message is the last Error line."""
    import re as _re
    line_no = None
    hits = _re.findall(r"line (\d+)", output)
    if hits:
        line_no = int(hits[-1])
    else:
        m = _re.search(r":(\d+)\s*\n", output)
        if m:
            line_no = int(m.group(1))
    message = ""
    lines = [ln for ln in output.splitlines() if ln.strip()]
    for ln in reversed(lines):
        if "Error" in ln:
            message = ln.strip()
            break
    if not message and lines:
        message = lines[-1].strip()
    return line_no, message


# ---------------- Symbol index (Roadmap G1) ----------------
# A two-pass index over the workspace: pass 1 collects every
# definition (functions, classes, methods, module values);
# pass 2 records every word-boundary occurrence of a defined
# name. Cached against a fingerprint of (path, size, mtime)
# so any save invalidates it and the next query rebuilds.
import re as _re_mod

_SYM_DEFS = [
    (_re_mod.compile(r"^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)"),
     "py"),
    (_re_mod.compile(r"^(\s*)class\s+([A-Za-z_]\w*)"), "py"),
    (_re_mod.compile(r"^([A-Za-z_]\w*)\s*=(?!=)"), "py"),
    (_re_mod.compile(r"^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"),
     "js"),
    (_re_mod.compile(r"^\s*class\s+([A-Za-z_$][\w$]*)"), "js"),
    (_re_mod.compile(
        r"^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)"), "js"),
]
_SYM_CACHE = {"fp": None, "index": None}


def _symbol_index():
    files = []
    fp_parts = []
    for rel, p in iter_text_files():
        try:
            st = p.stat()
        except Exception:
            continue
        fp_parts.append((str(rel), st.st_size, int(st.st_mtime)))
        files.append((str(rel), p))
    fp = hash(tuple(fp_parts))
    if _SYM_CACHE["fp"] == fp and _SYM_CACHE["index"] is not None:
        return _SYM_CACHE["index"]
    symbols = []
    texts = {}
    for rel, p in files:
        try:
            text = p.read_text(errors="strict")
        except Exception:
            continue
        texts[rel] = text
        ext = p.suffix.lower()
        lang = "py" if ext == ".py" else "js"
        for i, line in enumerate(text.splitlines(), 1):
            for pat, plang in _SYM_DEFS:
                if plang != lang:
                    continue
                m = pat.match(line)
                if m:
                    name = m.group(m.lastindex)
                    if plang == "py" and pat is _SYM_DEFS[0][0]:
                        kind = "method" if m.group(1) else "function"
                    elif plang == "py" and pat is _SYM_DEFS[1][0]:
                        kind = "class"
                    elif plang == "py":
                        kind = "value"
                    elif pat is _SYM_DEFS[4][0]:
                        kind = "class"
                    elif pat is _SYM_DEFS[5][0]:
                        kind = "value"
                    else:
                        kind = "function"
                    symbols.append({"name": name, "kind": kind,
                                    "path": rel, "line": i})
                    break
    names = {s["name"] for s in symbols}
    refs = {}
    if names:
        big = _re_mod.compile(r"\b(" + "|".join(
            sorted((_re_mod.escape(n) for n in names),
                   key=len, reverse=True)) + r")\b")
        for rel, text in texts.items():
            for i, line in enumerate(text.splitlines(), 1):
                for m in big.finditer(line):
                    refs.setdefault(m.group(1), []).append(
                        {"path": rel, "line": i,
                         "text": line.strip()[:160]})
    index = {"symbols": symbols, "refs": refs,
             "files": len(texts), "texts": texts}
    _SYM_CACHE["fp"] = fp
    _SYM_CACHE["index"] = index
    return index


def _repo_map(budget_chars):
    """Repo map (Roadmap G2): the workspace's symbols grouped by
    file, files ranked by total references, symbols ranked by
    reference count. Whole files drop off the bottom when the
    character budget runs out."""
    idx = _symbol_index()
    by_file = {}
    for s in idx["symbols"]:
        by_file.setdefault(s["path"], []).append(s)

    def refcount(name):
        return len(idx["refs"].get(name, []))

    def file_score(item):
        return sum(refcount(s["name"]) for s in item[1])

    files_sorted = sorted(by_file.items(), key=file_score,
                          reverse=True)
    header = ("# Repo map - %d files, %d symbols "
              "(ranked by references)"
              % (len(by_file), len(idx["symbols"])))
    lines = [header]
    used = len(header) + 1
    shown = 0
    for path, syms in files_sorted:
        syms_sorted = sorted(syms, key=lambda s: -refcount(s["name"]))
        block = ["## " + path]
        for s in syms_sorted:
            block.append("- %s %s (line %d, %d refs)"
                         % (s["kind"], s["name"], s["line"],
                            refcount(s["name"])))
        block_text = "\n".join(block)
        if shown and used + len(block_text) + 1 > budget_chars:
            lines.append("## ... +%d more files (over map budget)"
                         % (len(files_sorted) - shown))
            break
        lines.extend(block)
        used += len(block_text) + 1
        shown += 1
    return "\n".join(lines)


# ---------------- Refactoring engine (Roadmap G3) ----------------
# Every operation computes the full new contents first and
# returns {files: [{path, content}], diff} for preview; with
# apply=true the caller writes them through the normal save
# path (which snapshots Local History, so refactors undo).
import ast as _ast
import builtins as _builtins
import difflib as _difflib

_IDENT_RE = _re_mod.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


# ---- Roadmap G27: context lab (GhostSlice estimator port) ----
# Constants and algorithm mirror ghostslice/src/ghostslice/
# tokens.py + scanner.py (method v2). Keep in sync with the
# Java port in IdeServer.java.
_GS_TEXT_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".md", ".markdown", ".txt", ".json", ".yaml", ".yml",
    ".toml", ".cfg", ".ini", ".html", ".css", ".sh", ".rb",
    ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cc",
    ".cxx", ".hh", ".cs", ".php", ".swift", ".kt", ".kts",
    ".sql", ".xml", ".scala", ".sc", ".bash", ".zsh", ".ps1",
    ".psm1", ".ipynb",
}
_GS_BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp",
    ".svgz", ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz",
    ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".o",
    ".a", ".class", ".wasm", ".mp3", ".mp4", ".mov", ".avi",
    ".woff", ".woff2", ".ttf", ".eot", ".pyc", ".pyo", ".db",
    ".sqlite", ".sqlite3",
}
_GS_LANG_BY_EXT = {
    ".py": "python", ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript",
    ".md": "markdown", ".markdown": "markdown", ".txt": "text",
    ".json": "json", ".go": "go", ".rs": "rust",
    ".java": "java", ".cs": "csharp", ".php": "php",
    ".rb": "ruby", ".kt": "kotlin", ".kts": "kotlin",
    ".swift": "swift", ".c": "c", ".h": "c", ".cpp": "cpp",
    ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".scala": "scala", ".sc": "scala", ".yaml": "yaml",
    ".yml": "yaml", ".toml": "toml", ".sql": "sql",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell",
    ".ps1": "powershell", ".psm1": "powershell",
    ".ipynb": "notebook",
}
_GS_FAMILY = {
    "python": "python", "notebook": "python",
    "typescript": "ts-js", "javascript": "ts-js", "go": "go",
    "rust": "rust", "c": "c-family", "cpp": "c-family",
    "java": "c-family", "csharp": "c-family", "scala": "c-family",
    "kotlin": "c-family", "swift": "c-family", "php": "c-family",
    "ruby": "c-family", "markdown": "prose", "json": "json-data",
    "yaml": "json-data", "toml": "json-data",
}
_GS_FACTORS = {
    "prose": 0.85, "python": 0.86, "ts-js": 0.75, "go": 0.73,
    "rust": 0.89, "c-family": 0.87, "json-data": 0.95,
    "minified-js": 0.65, "other": 1.00,
}
_GS_SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "dist", "build",
    "out", "__pycache__", ".venv", "venv", "env", ".tox",
    ".mypy_cache",
}
_GS_LOCKFILES = {
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "poetry.lock", "Pipfile.lock", "Cargo.lock",
    "composer.lock", "Gemfile.lock", "go.sum", "uv.lock",
}


def _gs_raw_tokens(text):
    # Replicates re.findall(r"[A-Za-z0-9_]+|[^\w\s]") counting:
    # word runs cost 1 (len <= 4) or ceil(len/4); each non-word
    # non-space char costs 1.
    total = 0
    run = 0
    for ch in text:
        if ch == "_" or ch.isalnum():
            run += 1
            continue
        if run:
            total += 1 if run <= 4 else (run + 3) // 4
            run = 0
        if not ch.isspace():
            total += 1
    if run:
        total += 1 if run <= 4 else (run + 3) // 4
    return total


def _gs_looks_minified(text):
    if len(text) < 400:
        return False
    lines = text.splitlines()
    if not lines:
        return False
    longest = max(len(ln) for ln in lines)
    return longest >= 300 and len(text) / len(lines) >= 200


def _gs_estimate(text, language):
    raw = _gs_raw_tokens(text)
    if raw == 0:
        return 0
    fam = _GS_FAMILY.get(language or "", "other")
    if fam == "ts-js" and _gs_looks_minified(text):
        fam = "minified-js"
    factor = _GS_FACTORS[fam]
    if factor == 1.0:
        return raw
    return int(raw * factor + 0.5)


def _context_stats():
    files = []
    total_tokens = 0
    total_bytes = 0
    for dirpath, dirnames, filenames in os.walk(WORKSPACE):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in _GS_SKIP_DIRS and not d.startswith("."))
        for name in sorted(filenames):
            p = Path(dirpath) / name
            rel = str(p.relative_to(WORKSPACE))
            ext = p.suffix.lower()
            if ext in _GS_BINARY_EXTS:
                continue
            if ext and ext not in _GS_TEXT_EXTS:
                continue
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if size > 5_000_000:
                files.append({"path": rel, "bytes": size,
                              "tokens": None})
                total_bytes += size
                continue
            try:
                text = p.read_bytes().decode("utf-8", "ignore")
            except OSError:
                continue
            # GhostSlice sniffs extensionless files; a NUL byte
            # means binary in practice - skip those.
            if not ext and "\x00" in text:
                continue
            tokens = _gs_estimate(
                text, _GS_LANG_BY_EXT.get(ext))
            entry = {"path": rel, "bytes": size,
                     "tokens": tokens}
            if name in _GS_LOCKFILES:
                entry["lock"] = True
            files.append(entry)
            total_tokens += tokens
            total_bytes += size
            if len(files) >= 5000:
                break
    files.sort(key=lambda f: -(f["tokens"] or 0))
    return {
        "files": files, "totalTokens": total_tokens,
        "totalBytes": total_bytes, "fileCount": len(files),
        "method": "GhostSlice estimates (BPE-like split v2, "
                  "per-language calibrated, not exact "
                  "tokenizer counts)",
    }


# ---- Roadmap G32: verify pipeline ----
def _check_all():
    results = []
    checked = 0
    seen = 0
    skipped_type = 0
    capped = 0
    for rel, p in iter_text_files():
        seen += 1
        ext = p.suffix.lower()
        if ext == ".py":
            argv = [py_cmd()[0], "-c",
                    "import ast,sys; "
                    "ast.parse(open(sys.argv[1], "
                    "encoding='utf-8').read())", str(p)]
        elif ext in (".js", ".mjs"):
            argv = ["node", "--check", str(p)]
        elif ext == ".json":
            argv = [py_cmd()[0], "-c",
                    "import json,sys; "
                    "json.load(open(sys.argv[1]))", str(p)]
        else:
            skipped_type += 1
            continue
        if checked >= 100:
            capped += 1
            continue
        checked += 1
        rc, out, err, ms = run_cmd(argv, cwd=str(WORKSPACE))
        if rc != 0:
            output = (out + err).strip()
            ln, msg = check_output_info(output)
            results.append({"path": str(rel), "line": ln,
                            "message": msg})
    return {"problems": results, "checked": checked,
            "seen": seen, "skippedType": skipped_type,
            "capped": capped}


def _verify_run():
    """One health pass: check-all + tests + slice report,
    composed from the same helpers the individual tools use,
    plus an evidence level with printed criteria. Writes
    VERIFY_REPORT.md into the workspace."""
    checks = _check_all()
    targets = [f["path"] for f in discover_tests()]
    test_results = []
    for rel in targets:
        test_results.extend(run_test_file(rel))
    t_passed = sum(1 for r in test_results
                   if r["status"] == "pass")
    t_failed = len(test_results) - t_passed
    stats = _context_stats()
    problems = checks["problems"]
    if test_results and not problems and t_failed == 0:
        level, label = "L3", "Green: checks and tests executed, all passing"
    elif test_results:
        level, label = "L2", "Tested: checks and tests executed (failures present)"
    elif not problems:
        level, label = "L1", "Checked: syntax green; no tests exist to run"
    else:
        level, label = "L1", "Checked: syntax problems present; no tests ran"
    import datetime as _dt
    stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = []
    lines.append("# Verify report")
    lines.append("")
    lines.append("Project health pass by GhostIDE "
                 "(verify pipeline, Roadmap G32).")
    lines.append("When: " + stamp)
    lines.append("")
    lines.append("## Evidence level: " + level)
    lines.append(label + ".")
    lines.append("Levels: L1 = syntax checks executed; "
                 "L2 = checks and tests executed; "
                 "L3 = executed and all green, with at "
                 "least one real test.")
    lines.append("")
    lines.append("## Syntax checks")
    lines.append("Files checked: " + str(checks["checked"]) +
                 ". Problems: " + str(len(problems)) + ".")
    for pr in problems:
        lines.append("- " + pr["path"] + ":" +
                     str(pr["line"]) + " " + pr["message"])
    lines.append("")
    lines.append("## Tests")
    if targets:
        lines.append("Test files: " + str(len(targets)) +
                     " (" + ", ".join(targets) + ").")
        lines.append("Tests run: " + str(len(test_results)) +
                     ". Passed: " + str(t_passed) +
                     ". Failed: " + str(t_failed) + ".")
        for r in test_results:
            if r["status"] != "pass":
                lines.append("- FAIL " + r.get("file", "") +
                             " " + r.get("name", "") + ": " +
                             str(r.get("message", ""))[:200])
    else:
        lines.append("No test files discovered "
                     "(test_*.py, *_test.py, *.test.js).")
    lines.append("")
    lines.append("## Slice report (context cost)")
    lines.append("Text files: " + str(stats["fileCount"]) +
                 ". Bytes: " + str(stats["totalBytes"]) +
                 ". Estimated tokens if Ghost read "
                 "everything: " + str(stats["totalTokens"]) + ".")
    for f in stats["files"][:5]:
        lines.append("- " + f["path"] + ": " +
                     str(f["tokens"]) + " tokens")
    lines.append("")
    lines.append("Method: " + stats["method"])
    # E7: the GhostVerify evidence contract. Executed = work
    # this run actually performed; Claimed = statements the
    # report makes without executing anything; Gaps = what
    # was not covered, named as gaps, never as passes.
    contract_executed = [
        "Syntax checks executed on %d file(s) "
        "(python ast, node --check, json parse)." % checks["checked"],
    ]
    if targets:
        contract_executed.append(
            "Tests executed: %d test(s) in %d file(s): "
            "%d passed, %d failed."
            % (len(test_results), len(targets), t_passed, t_failed))
    else:
        contract_executed.append(
            "Test discovery executed: no test files found.")
    contract_claimed = [
        "Slice report figures (%d text files, %d bytes, "
        "~%d tokens) are measurements of the workspace, "
        "not checks of those files' correctness."
        % (stats["fileCount"], stats["totalBytes"],
           stats["totalTokens"]),
        "Evidence level %s is derived only from the "
        "executed items above." % level,
    ]
    contract_gaps = [
        "Checks are syntax-only: imports, types and runtime "
        "behavior are not verified by this pipeline.",
    ]
    if checks["capped"]:
        contract_gaps.append(
            "%d checkable file(s) were NOT checked: the "
            "pipeline caps at 100 files per run."
            % checks["capped"])
    if checks["skippedType"]:
        contract_gaps.append(
            "%d text file(s) have no syntax checker (only "
            ".py, .js, .mjs and .json are checked); they "
            "were counted, not verified."
            % checks["skippedType"])
    if not targets:
        contract_gaps.append(
            "No tests exist in this workspace, so no "
            "behavior was executed; the level cannot "
            "exceed L1.")
    lines.append("")
    lines.append("## Evidence contract (GhostVerify)")
    lines.append("Executed:")
    for item in contract_executed:
        lines.append("- " + item)
    lines.append("Claimed, not executed:")
    for item in contract_claimed:
        lines.append("- " + item)
    lines.append("Gaps:")
    for item in contract_gaps:
        lines.append("- " + item)
    report = "\n".join(lines) + "\n"
    (WORKSPACE / "VERIFY_REPORT.md").write_text(
        report, encoding="utf-8")
    return {
        "checks": checks,
        "tests": {"files": targets,
                  "total": len(test_results),
                  "passed": t_passed, "failed": t_failed,
                  "failures": [r for r in test_results
                               if r["status"] != "pass"][:20]},
        "slice": {"fileCount": stats["fileCount"],
                  "totalTokens": stats["totalTokens"],
                  "totalBytes": stats["totalBytes"],
                  "top": stats["files"][:5]},
        "evidence": {"level": level, "label": label},
        "contract": {"executed": contract_executed,
                     "claimed": contract_claimed,
                     "gaps": contract_gaps},
        "reportPath": "VERIFY_REPORT.md",
        "report": report,
    }


# ---- Roadmap G38: classroom view ----
# A read-only live window into the host's session. The host
# IDE publishes snapshots (current file + live content +
# chat tail); viewers open /classroom, enter the class
# code, follow along, and can annotate. Viewers have no
# write path to the workspace: their only endpoints are
# state (read) and annotate (append to a capped list).
_classroom = {"code": None, "host": None, "state": None,
              "annotations": []}


def _classroom_info():
    import socket as _sock
    urls = []
    try:
        s = _sock.socket(_sock.AF_INET, _sock.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            urls.append("http://" + ip + ":" + str(PORT)
                        + "/classroom.html")
    except Exception:
        pass
    return {"bound": HOST, "urls": urls, "port": PORT}


def _classroom_start():
    import secrets as _sec
    _classroom["code"] = "%04d" % _sec.randbelow(10000)
    _classroom["host"] = _sec.token_hex(8)
    _classroom["state"] = None
    _classroom["annotations"] = []
    return {"code": _classroom["code"],
            "host": _classroom["host"],
            "info": _classroom_info()}


# ---- Roadmap G29: semantic (meaning) code search ----
_SEM_STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on",
    "for", "with", "that", "this", "it", "is", "are", "be",
    "by", "at", "from", "into", "when", "where", "which",
    "what", "does", "do", "how", "code", "function", "file",
    "me", "find", "show",
}
_SEM_GROUPS = [
    ["download", "fetch", "retrieve", "request", "pull"],
    ["retry", "attempt", "backoff", "again", "repeat"],
    ["fail", "failure", "error", "exception", "except",
     "crash", "timeout", "broken"],
    ["send", "deliver", "email", "mail", "notify", "message"],
    ["welcome", "greet", "hello", "onboard"],
    ["price", "cost", "total", "amount", "sum", "charge",
     "due", "owe", "bill"],
    ["tax", "vat", "fee", "rate", "levy", "duty"],
    ["save", "store", "persist", "write", "dump"],
    ["read", "parse", "load", "decode", "scan"],
    ["delete", "remove", "erase", "drop", "clear"],
    ["create", "make", "build", "generate"],
    ["update", "change", "edit", "modify", "rename"],
    ["search", "find", "lookup", "query", "filter"],
    ["sort", "order", "rank", "arrange"],
    ["check", "validate", "verify", "test", "assert"],
    ["start", "begin", "launch", "run", "boot", "init"],
    ["stop", "end", "halt", "kill", "close", "shutdown"],
    ["user", "account", "customer", "member", "signup",
     "register"],
    ["pay", "payment", "checkout", "card", "invoice",
     "billing"],
    ["image", "picture", "photo", "icon", "thumbnail"],
    ["time", "date", "clock", "schedule", "delay", "sleep",
     "wait"],
    ["password", "login", "auth", "token", "session",
     "credential"],
    ["encrypt", "decrypt", "hash", "cipher", "secure"],
    ["compress", "archive", "zip", "backup", "export",
     "import"],
    ["print", "log", "display", "render", "show", "draw"],
    ["connect", "socket", "network", "server", "client",
     "port"],
    ["database", "table", "record", "sql", "storage"],
    ["string", "text", "word", "char", "format", "template"],
    ["number", "count", "compute", "calculate", "math"],
    ["file", "path", "directory", "folder", "extension"],
]


def _sem_stem(w):
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 5 and w.endswith("ing"):
        return w[:-3]
    if len(w) > 4 and w.endswith("ed"):
        return w[:-2]
    if len(w) > 4 and w.endswith("es"):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def _sem_words(text):
    # Split snake_case, camelCase and plain text into words.
    words = []
    cur = ""
    prev_lower = False
    for ch in text:
        if ch.isalnum():
            if ch.isupper() and prev_lower and cur:
                words.append(cur)
                cur = ch
            else:
                cur += ch
            prev_lower = ch.islower() or ch.isdigit()
        else:
            if cur:
                words.append(cur)
                cur = ""
            prev_lower = False
    if cur:
        words.append(cur)
    return [w.lower() for w in words if len(w) > 1]


_SEM_EXPAND = {}
for _grp in _SEM_GROUPS:
    _stems = {_sem_stem(w) for w in _grp}
    for _w in _stems:
        _SEM_EXPAND.setdefault(_w, set()).update(_stems)


def _sem_chunks():
    idx = _symbol_index()
    texts = idx["texts"]
    by_file = {}
    for s in idx["symbols"]:
        by_file.setdefault(s["path"], []).append(s)
    chunks = []
    for path, defs in by_file.items():
        defs.sort(key=lambda d: d["line"])
        lines = texts.get(path, "").splitlines()
        for i, d in enumerate(defs):
            end = defs[i + 1]["line"] - 1 if i + 1 < len(defs) \
                else len(lines)
            end = min(end, d["line"] + 79)
            body = "\n".join(lines[d["line"] - 1:end])
            freq = {}
            for w in _sem_words(body):
                st = _sem_stem(w)
                if st not in _SEM_STOP:
                    freq[st] = freq.get(st, 0) + 1
            name_stems = {_sem_stem(w)
                          for w in _sem_words(d["name"])}
            chunks.append({
                "name": d["name"], "kind": d["kind"],
                "path": path, "line": d["line"],
                "snippet": lines[d["line"] - 1].strip()[:160]
                if lines else "",
                "freq": freq, "nameStems": name_stems})
    return chunks


def _sem_search(q):
    q = (q or "").strip()
    if not q:
        return []
    q_stems = []
    for w in _sem_words(q):
        # Stopwords match the RAW word first: stemming
        # first would turn "does" into "doe" and slip it
        # past the stop set.
        if w in _SEM_STOP:
            continue
        st = _sem_stem(w)
        if st not in _SEM_STOP and st not in q_stems:
            q_stems.append(st)
    if not q_stems:
        return []
    results = []
    for c in _sem_chunks():
        score = 0
        matched = []
        covered = 0
        for t in q_stems:
            hit = False
            if t in c["nameStems"]:
                score += 12
                matched.append(t)
                hit = True
            elif t in c["freq"]:
                score += 3 + min(2, c["freq"][t] - 1)
                matched.append(t)
                hit = True
            for e in _SEM_EXPAND.get(t, ()):
                if e == t:
                    continue
                if e in c["nameStems"]:
                    score += 6
                    if e not in matched:
                        matched.append(e)
                    hit = True
                elif e in c["freq"]:
                    score += 2
                    if e not in matched:
                        matched.append(e)
                    hit = True
            if hit:
                covered += 1
        if covered > 1:
            score += 5 * (covered - 1)
        if score > 0:
            results.append({
                "name": c["name"], "kind": c["kind"],
                "path": c["path"], "line": c["line"],
                "snippet": c["snippet"], "score": score,
                "matched": matched[:8]})
    results.sort(key=lambda r: (-r["score"], r["path"],
                                r["line"]))
    return results[:12]


# ---------------- Neural embeddings (Desktop Cycle 3, D5) ----
# The fourth search layer, additive over GhostIndex FTS5,
# the symbol index and the lexical meaning search above: a
# local embedding model turns workspace chunks into vectors
# (embed_index.py), stored in .ghostide/embeddings.db and
# ranked by cosine. The engine is a second llama-server in
# embedding mode on its own port, started on demand and
# idle-stopped, so the chat model server is never disturbed.
# Everything degrades honestly: with no model downloaded or
# no index built, the routes say so, and the agent's
# SEMANTIC action falls back to the lexical meaning search.
import embed_index as _embed_mod

EMBED_MODEL = {
    "id": "nomic-embed-v1.5-q8",
    "file": "nomic-embed-text-v1.5.Q8_0.gguf",
    "url": "https://huggingface.co/nomic-ai/"
           "nomic-embed-text-v1.5-GGUF/resolve/main/"
           "nomic-embed-text-v1.5.Q8_0.gguf",
    # Pin provenance: upstream publishes no standalone
    # checksum file for this GGUF, so, following the
    # llama.cpp pin precedent, the SHA-256 below was
    # computed from the real downloaded asset (146,146,432
    # bytes, fetched from the URL above) and that hash of
    # the verified file is the pin.
    "bytes": 146146432,
    "sha256": "3e24342164b3d94991ba9692fdc0dd08e3fd7362e0a"
              "acc396a9a5c54a544c3b7",
    "dim": 768,
    # nomic-embed-text-v1.5 is trained with task prefixes:
    # documents and queries embed in different modes.
    "doc_prefix": "search_document: ",
    "query_prefix": "search_query: ",
}
EMBED_DL_STATE = {"state": "idle", "done": 0, "total": 0,
                  "error": "", "id": ""}
EMBED_BUILD_STATE = {"state": "idle", "done": 0, "total": 0,
                     "error": "", "stats": None, "skipped": 0}
EMBED_BASE = os.environ.get(
    "GHOSTIDE_EMBED_BASE", "http://127.0.0.1:8081")
EMBED_IDLE_SECONDS = 600
EMBED_MAX_FILES = 2000
EMBED_SKIP_DIRS = {".git", "node_modules", ".ghostide",
                   ".ghostide-history", "__pycache__",
                   ".venv", "venv", "dist", "build"}
_embed_proc = None
_embed_last_used = 0.0


def _embed_model_path():
    return MODELS_DIR / EMBED_MODEL["file"]


def _embed_model_present():
    p = _embed_model_path()
    return p.is_file() \
        and p.stat().st_size == EMBED_MODEL["bytes"]


def _embed_dl_worker():
    """Background embedding-model download: the chat model
    worker's discipline - a .part file with resume, an
    exact-size gate and SHA-256 verification before the
    file becomes the model. Only ever started from the
    Settings / Find panel download action, never silently."""
    import hashlib
    entry = EMBED_MODEL
    EMBED_DL_CONTROL.update({"pause": False,
                             "cancel": False})
    try:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        dest = MODELS_DIR / entry["file"]
        part = MODELS_DIR / (entry["file"] + ".part")
        have = part.stat().st_size if part.exists() else 0
        if have > entry["bytes"]:
            part.unlink()
            have = 0
        EMBED_DL_STATE.update({
            "state": "downloading", "id": entry["id"],
            "done": have, "total": entry["bytes"],
            "error": ""})
        req = urllib.request.Request(entry["url"])
        if have:
            req.add_header("Range", "bytes=%d-" % have)
        with urllib.request.urlopen(req, timeout=60) as r:
            if have and r.status != 206:
                have = 0
            with open(part, "ab" if have else "wb") as f:
                done = have
                while True:
                    # D6: pause/cancel, same contract as
                    # the chat model worker.
                    if EMBED_DL_CONTROL["cancel"]:
                        raise _DlStop("cancel")
                    if EMBED_DL_CONTROL["pause"]:
                        raise _DlStop("pause")
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    EMBED_DL_STATE["done"] = done
        if part.stat().st_size != entry["bytes"]:
            EMBED_DL_STATE.update({
                "state": "error",
                "error": "download incomplete - tap Download "
                         "again to resume"})
            return
        if EMBED_DL_CONTROL["cancel"]:
            raise _DlStop("cancel")
        EMBED_DL_STATE["state"] = "verifying"
        h = hashlib.sha256()
        with open(part, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 22), b""):
                h.update(chunk)
        if h.hexdigest() != entry["sha256"]:
            part.unlink(missing_ok=True)
            EMBED_DL_STATE.update({
                "state": "error",
                "error": "checksum mismatch - the file was "
                         "deleted; download again"})
            return
        part.rename(dest)
        EMBED_DL_STATE.update({"state": "done",
                               "done": entry["bytes"]})
    except _DlStop as stop:
        # D6: pause keeps the partial file; cancel
        # removes it.
        if stop.kind == "cancel":
            part.unlink(missing_ok=True)
            EMBED_DL_STATE.update({"state": "idle",
                                   "done": 0, "error": ""})
        else:
            EMBED_DL_STATE.update({"state": "paused"})
    except Exception as e:
        EMBED_DL_STATE.update({"state": "error",
                               "error": str(e)})


def _embed_health():
    try:
        with urllib.request.urlopen(
                EMBED_BASE + "/health", timeout=2) as r:
            return json.load(r).get("status") == "ok"
    except Exception:
        return False


def _embed_stop():
    global _embed_proc
    if _embed_proc and _embed_proc.poll() is None:
        _embed_proc.terminate()
        try:
            _embed_proc.wait(timeout=5)
        except Exception:
            _embed_proc.kill()
    _embed_proc = None


def _embed_stop_if_idle():
    if _embed_proc and _embed_proc.poll() is None \
            and _embed_last_used \
            and time.time() - _embed_last_used \
            > EMBED_IDLE_SECONDS:
        _embed_stop()


def _embed_engine_state():
    if _embed_health():
        return "up"
    if _embed_proc and _embed_proc.poll() is None:
        return "starting"
    return "down"


def _embed_start():
    """Start the embedding llama-server on demand: its own
    process and port, alongside (never instead of) the chat
    model server. Returns once health answers; raises
    ValueError with the honest reason when it cannot."""
    global _embed_proc, _embed_last_used
    _embed_stop_if_idle()
    if _embed_health():
        _embed_last_used = time.time()
        return
    if not _embed_model_present():
        raise ValueError(
            "the embedding model is not downloaded yet - "
            "Settings has the download")
    if not llama_present():
        raise ValueError(
            "llama.cpp is not downloaded yet - Settings "
            "has the download")
    if _embed_proc is None or _embed_proc.poll() is not None:
        log = open(ROOT / "embed-server.log", "ab")
        port = urllib.parse.urlparse(EMBED_BASE).port or 8081
        _embed_proc = subprocess.Popen(
            [LLAMA_BIN, "--model", str(_embed_model_path()),
             "--embedding", "--pooling", "mean",
             "--host", "127.0.0.1", "--port", str(port),
             "--ctx-size", "8192", "--threads", "4",
             "--alias", EMBED_MODEL["id"]],
            stdout=log, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True)
    deadline = time.time() + 60
    while time.time() < deadline:
        if _embed_health():
            _embed_last_used = time.time()
            return
        if _embed_proc.poll() is not None:
            raise ValueError(
                "the embedding server exited during startup "
                "- see embed-server.log")
        time.sleep(0.25)
    raise ValueError(
        "the embedding server did not come up in 60 seconds")


def _embed_texts(texts, kind):
    """Embed a batch of texts with the local model. kind is
    "doc" or "query" and picks the model's task prefix.
    Texts go to the long-lived server in batches of 32 -
    never one process spawn per chunk."""
    global _embed_last_used
    if not texts:
        return []
    prefix = EMBED_MODEL["doc_prefix" if kind == "doc"
                         else "query_prefix"]
    _embed_start()
    out = []
    for i in range(0, len(texts), 32):
        batch = [prefix + t for t in texts[i:i + 32]]
        req = urllib.request.Request(
            EMBED_BASE + "/v1/embeddings",
            data=json.dumps({"input": batch}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.load(r)
        except Exception as e:
            raise ValueError(
                "embedding request failed: " + str(e))
        rows = sorted(data.get("data", []),
                      key=lambda x: x.get("index", 0))
        if len(rows) != len(batch):
            raise ValueError(
                "embedding server returned %d vectors for "
                "%d texts" % (len(rows), len(batch)))
        out.extend(row["embedding"] for row in rows)
    _embed_last_used = time.time()
    return out


def _embed_collect_files():
    """Workspace files for the embedding index. The walk
    prunes VCS, vendor and app-data folders (including
    .ghostide itself, so the index never indexes its own
    database), skips dot-folders, binaries and oversize
    files, and caps the file count. Returns (texts,
    skipped); skipped counts everything seen but not
    indexed, so status can report it honestly."""
    texts = {}
    skipped = 0
    for dirpath, dirnames, filenames in os.walk(WORKSPACE):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in EMBED_SKIP_DIRS
            and not d.startswith("."))
        for name in sorted(filenames):
            p = Path(dirpath) / name
            rel = str(p.relative_to(WORKSPACE))
            try:
                if p.stat().st_size > 512 * 1024:
                    skipped += 1
                    continue
            except Exception:
                skipped += 1
                continue
            if len(texts) >= EMBED_MAX_FILES:
                skipped += 1
                continue
            try:
                texts[rel] = p.read_text(errors="strict")
            except Exception:
                skipped += 1
    return texts, skipped


def _embed_index():
    return _embed_mod.EmbedIndex(
        WORKSPACE / ".ghostide" / "embeddings.db",
        model_id=EMBED_MODEL["id"])


def _embed_build_sync():
    """One index build/refresh pass: re-embeds only files
    whose content hash moved, purges deleted files.
    Raises ValueError with an honest reason when the model
    or the runtime is missing."""
    if not _embed_model_present():
        raise ValueError(
            "the embedding model is not downloaded yet - "
            "Settings has the download")
    if not llama_present():
        raise ValueError(
            "llama.cpp is not downloaded yet - Settings "
            "has the download")
    texts, skipped = _embed_collect_files()
    symbols_by_path = {}
    try:
        for s in _symbol_index()["symbols"]:
            symbols_by_path.setdefault(
                s["path"], []).append(s)
    except Exception:
        symbols_by_path = {}
    idx = _embed_index()

    def prog(done, total):
        EMBED_BUILD_STATE.update(
            {"done": done, "total": total})

    try:
        stats = idx.sync(
            texts, symbols_by_path,
            lambda ts: _embed_texts(ts, "doc"),
            progress=prog, now=int(time.time()))
    finally:
        idx.close()
    stats["skipped"] = skipped
    return stats


def _embed_build_worker():
    try:
        EMBED_BUILD_STATE.update({
            "state": "building", "done": 0, "total": 0,
            "error": "", "stats": None, "skipped": 0})
        stats = _embed_build_sync()
        EMBED_BUILD_STATE.update({
            "state": "done", "stats": stats,
            "skipped": stats.get("skipped", 0)})
    except Exception as e:
        EMBED_BUILD_STATE.update(
            {"state": "error", "error": str(e)})


def embed_status():
    _embed_stop_if_idle()
    # Snapshot the build state BEFORE reading the index:
    # when the snapshot says a build is done, the index
    # read that follows is guaranteed to be at least that
    # build's result, so one response never pairs fresh
    # build stats with a pre-build index.
    build = dict(EMBED_BUILD_STATE)
    idx = _embed_index()
    try:
        st = idx.stats()
    finally:
        idx.close()
    return {
        "model": {"id": EMBED_MODEL["id"],
                  "file": EMBED_MODEL["file"],
                  "present": _embed_model_present(),
                  "bytes": EMBED_MODEL["bytes"],
                  "path": str(_embed_model_path()),
                  "download": dict(EMBED_DL_STATE)},
        "engine": _embed_engine_state(),
        "index": {"exists": st["exists"],
                  "files": st["files"],
                  "chunks": st["chunks"],
                  "updated": st["updated"],
                  "skipped": build.get("skipped", 0),
                  "dim": st["dim"]},
        "build": build,
        "available": _embed_model_present()
        and st["chunks"] > 0,
    }


def embed_search(query, limit=10):
    """Neural search over the workspace index. Returns
    {results, engine: "neural"} when the layer is live, or
    {results: [], available: False, code, notice} when it
    is not, so callers can fall back honestly instead of
    failing silently."""
    q = (query or "").strip()
    if not q:
        return {"results": [], "available": False,
                "code": "empty-query",
                "notice": "empty query"}
    if not _embed_model_present():
        return {"results": [], "available": False,
                "code": "no-model",
                "notice": "the embedding model is not "
                          "downloaded yet"}
    idx = _embed_index()
    try:
        st = idx.stats()
        if st["chunks"] == 0:
            return {"results": [], "available": False,
                    "code": "no-index",
                    "notice": "the neural index is empty - "
                              "build it from the Find panel"}
        try:
            qvec = _embed_texts([q], "query")[0]
        except ValueError as e:
            return {"results": [], "available": False,
                    "code": "engine-error", "notice": str(e)}
        results = idx.search(qvec, limit)
    finally:
        idx.close()
    for r in results:
        r["score"] = round(r["score"], 4)
    return {"results": results, "engine": "neural",
            "available": True}


# ---------------- Model store (Desktop Cycle 3, D6) ----
# The store is a UX layer over the model system that was
# already here: the pinned catalog and its verified
# download worker (_dl_worker), the embedding model's
# worker (_embed_dl_worker) and the path switcher. D6
# adds: one listing that joins catalog + embedding +
# imported models with machine-fit guidance, pause/cancel
# controls on the existing workers, delete with an
# active-model guard, and a custom GGUF import (local
# file or URL) whose registry lives in app data
# (DATA_DIR/imported-models.json, portable-aware), never
# in the catalog constants. Imported models are labelled
# "Imported by you": GhostIDE checks the GGUF header and
# records the file's SHA-256 at import, and claims
# nothing about where the file came from.
GGUF_MAGIC = b"GGUF"
EMBED_RAM_GB = 0.6
IMPORTED_MODELS_FILE = DATA_DIR / "imported-models.json"
IMPORT_DL_STATE = {"state": "idle", "done": 0, "total": 0,
                   "error": "", "name": "", "part": "",
                   "origin": ""}


def _machine_ram_bytes():
    """Total physical RAM in bytes, or None when it
    cannot be read on this platform. None means the
    store shows no fit guidance; the number is never
    guessed."""
    try:
        if sys.platform.startswith("linux"):
            with open("/proc/meminfo",
                      encoding="utf-8") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        return int(line.split()[1]) * 1024
        elif sys.platform == "darwin":
            out = subprocess.run(
                ["sysctl", "-n", "hw.memsize"],
                capture_output=True, text=True, timeout=5)
            if out.returncode == 0:
                return int(out.stdout.strip())
        elif os.name == "nt":
            import ctypes

            class _MemStatus(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual",
                     ctypes.c_ulonglong)]
            m = _MemStatus()
            m.dwLength = ctypes.sizeof(_MemStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(
                    ctypes.byref(m)):
                return int(m.ullTotalPhys)
    except Exception:
        pass
    return None


def _fit_class(ram_gb, total_bytes):
    """Machine-fit guidance for one model: "fits" when
    the estimated need is at most 60% of total RAM,
    "tight" up to 90%, "too-big" beyond that, and
    "unknown" when either number is missing. Guidance
    only; nothing is ever blocked by it."""
    if not ram_gb or not total_bytes:
        return "unknown"
    total_gb = total_bytes / float(1024 ** 3)
    if ram_gb <= 0.6 * total_gb:
        return "fits"
    if ram_gb <= 0.9 * total_gb:
        return "tight"
    return "too-big"


def _sha256_file(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def _gguf_ok(path):
    """True when the file starts with the GGUF header.
    The only format check an import gets: it proves the
    file claims to be a GGUF, nothing more."""
    try:
        with open(path, "rb") as f:
            return f.read(4) == GGUF_MAGIC
    except Exception:
        return False


def _imported_models():
    try:
        data = json.loads(IMPORTED_MODELS_FILE.read_text(
            encoding="utf-8"))
        if isinstance(data, list):
            return [e for e in data
                    if isinstance(e, dict)
                    and e.get("id") and e.get("file")]
    except Exception:
        pass
    return []


def _save_imported_models(entries):
    IMPORTED_MODELS_FILE.parent.mkdir(parents=True,
                                      exist_ok=True)
    tmp = IMPORTED_MODELS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(entries, indent=1),
                   encoding="utf-8")
    os.replace(tmp, IMPORTED_MODELS_FILE)


def _imported_by_id(mid):
    for e in _imported_models():
        if e["id"] == mid:
            return e
    return None


def _import_id(name, digest):
    slug = _re_mod.sub(r"[^a-z0-9]+", "-",
                       (name or "model").lower()).strip("-")
    return "imp-" + (slug[:24] or "model") + "-" + digest[:8]


def _register_import(entry):
    entries = [e for e in _imported_models()
               if e["file"] != entry["file"]
               and e["id"] != entry["id"]]
    entries.append(entry)
    _save_imported_models(entries)
    return entry


def _unique_model_dest(fname):
    """A models-dir path for fname that does not clobber
    a different existing file (a same-name file with the
    same content is reused by the callers' hash check)."""
    dest = MODELS_DIR / fname
    if not dest.exists():
        return dest
    stem, suf = dest.stem, dest.suffix
    n = 2
    while dest.exists():
        dest = MODELS_DIR / ("%s-%d%s" % (stem, n, suf))
        n += 1
    return dest


def _dl_view(state):
    total = state.get("total") or 0
    done = state.get("done") or 0
    return {"state": state.get("state", "idle"),
            "done": done, "total": total,
            "percent": (100.0 * done / total) if total
            else 0.0,
            "error": state.get("error", "")}


def _model_loaded():
    """True when a chat model is actually running: our
    own llama-server process, or anything answering on
    the model endpoint (for example a server the user
    started themselves)."""
    if _model_proc and _model_proc.poll() is None:
        return True
    return llama_health()


def models_store():
    """The store listing: catalog chat models, the
    embedding model and imported models as cards, plus
    machine RAM, disk usage and the active model. Card
    data for catalog models comes straight from
    MODEL_CATALOG / EMBED_MODEL, so the store can never
    drift from the downloader's pins."""
    total_ram = _machine_ram_bytes()
    active_path = Path(MODEL)
    rec_id = None
    fits = [mid for mid, e in MODEL_CATALOG.items()
            if _fit_class(e["ram_gb"], total_ram) == "fits"]
    if fits:
        rec_id = max(
            fits,
            key=lambda m: float(
                MODEL_CATALOG[m]["params"][:-1]))
    cards = []
    for mid, e in MODEL_CATALOG.items():
        dest = MODELS_DIR / e["file"]
        exists = dest.is_file()
        cards.append({
            "id": mid, "kind": "catalog", "role": "chat",
            "name": e["name"], "params": e["params"],
            "quant": e["quant"], "file": e["file"],
            "bytes": e["bytes"],
            "installed": exists
            and dest.stat().st_size == e["bytes"],
            "installedBytes": dest.stat().st_size
            if exists else None,
            "ramGB": e["ram_gb"],
            "fit": _fit_class(e["ram_gb"], total_ram),
            "recommended": mid == rec_id,
            "blurb": e["blurb"], "verified": True,
            "active": active_path == dest,
            "download": _dl_view(DL_STATE)
            if DL_STATE.get("id") == mid else None})
    epath = _embed_model_path()
    cards.append({
        "id": "embed", "kind": "catalog",
        "role": "embedding",
        "name": "nomic-embed-text-v1.5", "params": "",
        "quant": "Q8_0", "file": EMBED_MODEL["file"],
        "bytes": EMBED_MODEL["bytes"],
        "installed": _embed_model_present(),
        "installedBytes": epath.stat().st_size
        if epath.is_file() else None,
        "ramGB": EMBED_RAM_GB,
        "fit": _fit_class(EMBED_RAM_GB, total_ram),
        "recommended": False,
        "blurb": "Embedding model. Powers Neural search "
                 "in the Find panel and the agent's "
                 "SEMANTIC action. After downloading, "
                 "build the index from the Find panel's "
                 "Neural mode.",
        "verified": True, "active": False,
        "download": _dl_view(EMBED_DL_STATE)})
    for ent in _imported_models():
        p = MODELS_DIR / ent["file"]
        exists = p.is_file()
        cards.append({
            "id": ent["id"], "kind": "imported",
            "role": "chat", "name": ent["name"],
            "params": "", "quant": "",
            "file": ent["file"], "bytes": ent["bytes"],
            "installed": exists,
            "installedBytes": p.stat().st_size
            if exists else None,
            "ramGB": None, "fit": "unknown",
            "recommended": False,
            "blurb": "Imported by you"
            + (" from a web address. GhostIDE recorded "
               "its SHA-256 at import; where it came "
               "from is not verified by GhostIDE."
               if ent.get("source") == "url"
               else ". GhostIDE recorded its SHA-256 "
                    "at import."),
            "verified": False,
            "sha256": ent.get("sha256", ""),
            "source": ent.get("source", "file"),
            "active": active_path == p,
            "download": None})
    models_bytes = 0
    if MODELS_DIR.is_dir():
        for f in MODELS_DIR.iterdir():
            if f.is_file():
                try:
                    models_bytes += f.stat().st_size
                except OSError:
                    pass
    free = None
    try:
        anchor = MODELS_DIR
        while not anchor.exists() \
                and anchor.parent != anchor:
            anchor = anchor.parent
        free = shutil.disk_usage(anchor).free
    except Exception:
        free = None
    active_id = None
    for c in cards:
        if c["active"] and c["role"] == "chat":
            active_id = c["id"]
    imp = _dl_view(IMPORT_DL_STATE)
    imp["name"] = IMPORT_DL_STATE.get("name", "")
    imp["origin"] = IMPORT_DL_STATE.get("origin", "")
    return {"ok": True,
            "machine": {
                "ramBytes": total_ram,
                "ramGB": (total_ram / float(1024 ** 3))
                if total_ram else None},
            "disk": {"modelsDir": str(MODELS_DIR),
                     "modelsBytes": models_bytes,
                     "freeBytes": free},
            "active": {"id": active_id, "name": MODEL_NAME,
                       "path": MODEL},
            "import": imp,
            "models": cards}


def _download_target(mid):
    """Which download worker owns a store id, for the
    pause/cancel controls."""
    if mid in MODEL_CATALOG:
        return {"state": DL_STATE, "control": DL_CONTROL,
                "part": MODELS_DIR
                / (MODEL_CATALOG[mid]["file"] + ".part")}
    if mid == "embed":
        return {"state": EMBED_DL_STATE,
                "control": EMBED_DL_CONTROL,
                "part": MODELS_DIR
                / (EMBED_MODEL["file"] + ".part")}
    if mid == "import":
        return {"state": IMPORT_DL_STATE,
                "control": IMPORT_DL_CONTROL,
                "part": Path(IMPORT_DL_STATE["part"])
                if IMPORT_DL_STATE.get("part") else None}
    return None


def _start_store_download(mid):
    import threading
    if mid in MODEL_CATALOG:
        if DL_STATE["state"] in ("downloading",
                                 "verifying"):
            return {"error": "a model download is "
                             "already running"}
        threading.Thread(target=_dl_worker, args=(mid,),
                         daemon=True).start()
        return {"ok": True, "state": "downloading"}
    if mid == "embed":
        if _embed_model_present():
            return {"ok": True, "downloaded": True}
        if EMBED_DL_STATE["state"] in ("downloading",
                                       "verifying"):
            return {"ok": True, "state": "downloading"}
        threading.Thread(target=_embed_dl_worker,
                         daemon=True).start()
        return {"ok": True, "state": "downloading"}
    return {"error": "unknown model: " + str(mid)}


def _pause_download(mid):
    """Pause = stop the transfer at the next chunk and
    keep the partial file; a later Download resumes it
    through the Range header. With nothing downloading
    this is an honest no-op that reports the state."""
    t = _download_target(mid)
    if t is None:
        return {"error": "unknown model: " + str(mid)}
    st = t["state"]
    if st["state"] == "downloading":
        t["control"]["pause"] = True
        return {"ok": True, "download": _dl_view(st),
                "note": "pausing: the partial file is "
                        "kept and the next Download "
                        "resumes it"}
    return {"ok": True, "download": _dl_view(st),
            "note": "nothing is downloading"}


def _cancel_download(mid):
    """Cancel = stop the transfer and delete the partial
    file. A finished download that is being verified is
    too late to cancel and says so."""
    t = _download_target(mid)
    if t is None:
        return {"error": "unknown model: " + str(mid)}
    st = t["state"]
    if st["state"] == "downloading":
        t["control"]["cancel"] = True
        return {"ok": True, "download": _dl_view(st),
                "note": "cancelling: the partial file "
                        "will be deleted"}
    if st["state"] == "verifying":
        return {"error": "the download is complete and "
                         "being verified; it is too late "
                         "to cancel"}
    if st["state"] == "paused":
        if t["part"] is not None:
            t["part"].unlink(missing_ok=True)
        st.update({"state": "idle", "done": 0,
                   "error": ""})
        return {"ok": True, "download": _dl_view(st),
                "note": "partial file deleted"}
    return {"ok": True, "download": _dl_view(st),
            "note": "nothing to cancel"}


def _switch_to_path(p):
    """Point the IDE at a model file (the /api/model/
    switch behaviour, shared with the store's Set active
    action): the running process we started is stopped;
    Start model relaunches with the new file."""
    global MODEL, MODEL_NAME
    MODEL = str(p)
    MODEL_NAME = p.name.replace(".gguf", "")
    if _model_proc and _model_proc.poll() is None:
        _model_proc.terminate()
    return {"ok": True, "modelName": MODEL_NAME,
            "modelPath": MODEL,
            "bytes": p.stat().st_size}


def _set_active_model(mid):
    if mid == "embed":
        return {"error": "the embedding model powers "
                         "Neural search; it cannot be "
                         "the chat model"}
    if mid in MODEL_CATALOG:
        e = MODEL_CATALOG[mid]
        p = MODELS_DIR / e["file"]
        if not (p.is_file()
                and p.stat().st_size == e["bytes"]):
            return {"error": "that model is not "
                             "downloaded yet"}
        return _switch_to_path(p)
    ent = _imported_by_id(mid)
    if ent is not None:
        p = MODELS_DIR / ent["file"]
        if not p.is_file():
            return {"error": "the imported model file "
                             "is missing"}
        return _switch_to_path(p)
    return {"error": "unknown model: " + str(mid)}


def _delete_model(mid, stop=False):
    """Delete an installed model's file (and its import
    registry entry). Guards: a model whose download is
    in flight must be cancelled first; the ACTIVE model
    cannot be deleted while it is loaded unless the
    caller asked to stop it first, and a model server
    started outside GhostIDE cannot be stopped by us."""
    global MODEL, MODEL_NAME
    if mid == "embed":
        if EMBED_DL_STATE["state"] in (
                "downloading", "verifying", "paused"):
            return {"error": "a download of this model "
                             "is in progress; cancel it "
                             "first"}
        if EMBED_BUILD_STATE.get("state") == "building":
            return {"error": "the neural index is "
                             "building; wait for it to "
                             "finish, then delete"}
        p = _embed_model_path()
        if not p.is_file():
            return {"error": "the embedding model is "
                             "not downloaded"}
        _embed_stop()
        p.unlink()
        (MODELS_DIR / (EMBED_MODEL["file"] + ".part")
         ).unlink(missing_ok=True)
        return {"ok": True, "deleted": EMBED_MODEL["file"]}
    ent = None
    if mid in MODEL_CATALOG:
        if DL_STATE.get("id") == mid \
                and DL_STATE["state"] in (
                    "downloading", "verifying", "paused"):
            return {"error": "a download of this model "
                             "is in progress; cancel it "
                             "first"}
        p = MODELS_DIR / MODEL_CATALOG[mid]["file"]
    else:
        ent = _imported_by_id(mid)
        if ent is None:
            return {"error": "unknown model: " + str(mid)}
        p = MODELS_DIR / ent["file"]
    if not p.is_file():
        return {"error": "that model is not installed"}
    was_active = Path(MODEL) == p
    if was_active and _model_loaded():
        if not stop:
            return {"error": "this model is loaded and "
                             "running; stop it before "
                             "deleting",
                    "code": "model-loaded",
                    "canStop": True}
        if _model_proc and _model_proc.poll() is None:
            _model_proc.terminate()
            for _ in range(50):
                if _model_proc.poll() is not None:
                    break
                time.sleep(0.1)
        if _model_loaded():
            return {"error": "the running model was "
                             "started outside GhostIDE, "
                             "so GhostIDE cannot stop it; "
                             "stop it yourself, then "
                             "delete"}
    p.unlink()
    Path(str(p) + ".part").unlink(missing_ok=True)
    if ent is not None:
        _save_imported_models(
            [e for e in _imported_models()
             if e["id"] != mid])
    if was_active:
        MODEL = _default_model()
        MODEL_NAME = Path(MODEL).name.replace(
            ".gguf", "")
    return {"ok": True, "deleted": p.name}


def _import_local(path_str, name=None):
    """Import a GGUF from a file on this machine: header
    check, copy into the models folder, SHA-256 recorded
    in the import registry. No verification claim beyond
    that."""
    src = Path(path_str or "").expanduser()
    if not src.is_file():
        return {"error": "no such file: "
                         + str(path_str)}
    if not _gguf_ok(src):
        return {"error": "that file is not a GGUF model "
                         "(it does not start with the "
                         "GGUF header)"}
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    fname = src.name
    if not fname.lower().endswith(".gguf"):
        fname += ".gguf"
    dest = MODELS_DIR / fname
    if dest.resolve() != src.resolve():
        if dest.exists() \
                and _sha256_file(dest) != _sha256_file(src):
            dest = _unique_model_dest(fname)
        if dest.resolve() != src.resolve():
            shutil.copyfile(src, dest)
    digest = _sha256_file(dest)
    disp = (name or "").strip() \
        or dest.name.replace(".gguf", "")
    entry = _register_import({
        "id": _import_id(disp, digest), "name": disp,
        "file": dest.name,
        "bytes": dest.stat().st_size, "sha256": digest,
        "source": "file", "origin": str(src),
        "imported_at": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    return {"ok": True, "model": entry}


def _import_url_worker(url, fname, disp):
    """Background URL import: the download workers'
    discipline (a .part file, Range resume, pause and
    cancel) minus the catalog pin, because an imported
    file has no pin to check against. On completion the
    GGUF header is checked and the SHA-256 is computed
    and stored in the registry; the source is recorded
    as not verified."""
    IMPORT_DL_CONTROL.update({"pause": False,
                              "cancel": False})
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    part = MODELS_DIR / (fname + ".part")
    IMPORT_DL_STATE.update({
        "state": "downloading", "done": 0, "total": 0,
        "error": "", "name": disp, "part": str(part),
        "origin": url})
    try:
        have = part.stat().st_size if part.exists() else 0
        req = urllib.request.Request(
            url, headers={"User-Agent":
                          "GhostIDE model import"})
        if have:
            req.add_header("Range", "bytes=%d-" % have)
        with urllib.request.urlopen(req, timeout=60) as r:
            if have and r.status != 206:
                have = 0
            total = have
            try:
                total += int(
                    r.headers.get("Content-Length") or 0)
            except Exception:
                total = have
            IMPORT_DL_STATE["total"] = total
            IMPORT_DL_STATE["done"] = have
            with open(part, "ab" if have else "wb") as f:
                done = have
                while True:
                    if IMPORT_DL_CONTROL["cancel"]:
                        raise _DlStop("cancel")
                    if IMPORT_DL_CONTROL["pause"]:
                        raise _DlStop("pause")
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    IMPORT_DL_STATE["done"] = done
        if not _gguf_ok(part):
            part.unlink(missing_ok=True)
            IMPORT_DL_STATE.update({
                "state": "error",
                "error": "the downloaded file is not a "
                         "GGUF model (it does not start "
                         "with the GGUF header); nothing "
                         "was imported"})
            return
        dest = MODELS_DIR / fname
        if dest.exists() \
                and _sha256_file(dest) != _sha256_file(part):
            dest = _unique_model_dest(fname)
        os.replace(part, dest)
        digest = _sha256_file(dest)
        _register_import({
            "id": _import_id(disp, digest), "name": disp,
            "file": dest.name,
            "bytes": dest.stat().st_size,
            "sha256": digest, "source": "url",
            "origin": url,
            "imported_at": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        IMPORT_DL_STATE.update({
            "state": "done",
            "done": dest.stat().st_size,
            "total": dest.stat().st_size})
    except _DlStop as stop:
        if stop.kind == "cancel":
            part.unlink(missing_ok=True)
            IMPORT_DL_STATE.update({"state": "idle",
                                    "done": 0, "error": ""})
        else:
            IMPORT_DL_STATE.update({"state": "paused"})
    except Exception as e:
        IMPORT_DL_STATE.update({"state": "error",
                                "error": str(e)})


def _start_url_import(url, name=None):
    import threading
    url = (url or "").strip()
    if not (url.startswith("https://")
            or url.startswith("http://")):
        return {"error": "the address must start with "
                         "http:// or https://"}
    if IMPORT_DL_STATE["state"] in ("downloading",
                                     "verifying"):
        return {"error": "an import is already running"}
    base = urllib.parse.urlparse(url).path.rsplit(
        "/", 1)[-1]
    if not base.lower().endswith(".gguf"):
        base = "imported-model.gguf"
    disp = (name or "").strip() \
        or base.replace(".gguf", "")
    threading.Thread(target=_import_url_worker,
                     args=(url, base, disp),
                     daemon=True).start()
    return {"ok": True, "state": "downloading",
            "name": disp}


def _models_host_only(handler):
    """D6: model import and delete act on the host's
    files (import reads any path the host user can read;
    delete removes files from the host's model library),
    so - exactly like the D8 MCP settings guard - pair
    guests may not use them. Returns True when the
    caller may proceed."""
    if handler.client_address[0] in ("127.0.0.1", "::1"):
        return True
    handler.send_json(
        {"error": "model import and delete happen on "
                  "the host"},
        status=403)
    return False


# ---- Roadmap G28: offline reference docs ----
_refdocs_cache = None


def _refdocs():
    global _refdocs_cache
    if _refdocs_cache is not None:
        return _refdocs_cache
    try:
        data = json.loads(
            (ROOT / "refdocs.json").read_text(encoding="utf-8"))
        _refdocs_cache = data.get("entries", [])
    except Exception:
        _refdocs_cache = []
    return _refdocs_cache


def _rd_tokens(text):
    toks = []
    cur = ""
    for ch in text.lower():
        if ch.isalnum():
            cur += ch
        elif cur:
            toks.append(cur)
            cur = ""
    if cur:
        toks.append(cur)
    return toks


def _refdoc_search(q, limit=12):
    q = (q or "").strip().lower()
    if not q:
        return []
    tokens = _rd_tokens(q)
    scored = []
    for e in _refdocs():
        title = e["title"].lower()
        s = 0
        if title == q:
            s += 100
        elif q and title.endswith(q):
            s += 60
        elif q in title:
            s += 40
        parts = title.replace(".", " ").split()
        summary = e["summary"].lower()
        body = e["body"].lower()
        for t in tokens:
            if t in parts:
                s += 15
            elif t in title:
                s += 6
            if t in summary:
                s += 3
            if t in body:
                s += 1
        if s > 0:
            scored.append((s, e["title"], e))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [{"id": e["id"], "lang": e["lang"],
             "title": e["title"], "summary": e["summary"],
             "score": s} for s, _t, e in scored[:limit]]


def _refactor_diff(changes):
    out = []
    for path, old, new in changes:
        out.extend(_difflib.unified_diff(
            old.splitlines(), new.splitlines(),
            fromfile="a/" + path, tofile="b/" + path, lineterm=""))
    return "\n".join(out)


def _check_ident(name):
    if not _IDENT_RE.match(name or ""):
        raise ValueError("not a valid name: " + str(name))


def refactor_extract_function(data):
    _check_ident(data.get("name", ""))
    name = data["name"]
    p = safe_path(data["path"])
    text = p.read_text()
    lines = text.splitlines()
    start = int(data["startLine"])
    end = int(data["endLine"])
    tree = _ast.parse(text)
    owners = [tree] + [n for n in _ast.walk(tree)
                       if isinstance(n, (_ast.FunctionDef,
                                         _ast.AsyncFunctionDef))]
    block = None
    owner = None
    for cand in owners:
        body = cand.body
        inside = [st for st in body
                  if start <= st.lineno and st.end_lineno <= end]
        partial = [st for st in body
                   if not (st.end_lineno < start or st.lineno > end)
                   and st not in inside]
        if inside and not partial:
            idxs = [body.index(st) for st in inside]
            if idxs == list(range(idxs[0], idxs[0] + len(idxs))):
                block = inside
                owner = cand
                break
    if block is None:
        raise ValueError("Selection must cover whole statements "
                         "inside one function or at module level.")
    if any(isinstance(n, (_ast.FunctionDef, _ast.AsyncFunctionDef,
                           _ast.ClassDef)) and n.name == name
           for n in _ast.walk(tree)):
        raise ValueError("A definition named " + name +
                         " already exists in this file.")
    first, last = block[0], block[-1]
    loads, stores = set(), set()
    for st in block:
        for n in _ast.walk(st):
            if isinstance(n, _ast.Name):
                if isinstance(n.ctx, _ast.Load):
                    loads.add(n.id)
                elif isinstance(n.ctx, _ast.Store):
                    stores.add(n.id)
            elif isinstance(n, (_ast.FunctionDef, _ast.AsyncFunctionDef,
                                _ast.ClassDef)):
                stores.add(n.name)
    defined_before = set()
    if isinstance(owner, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
        a = owner.args
        for arg in (list(a.posonlyargs) + list(a.args)
                    + list(a.kwonlyargs)):
            defined_before.add(arg.arg)
        if a.vararg:
            defined_before.add(a.vararg.arg)
        if a.kwarg:
            defined_before.add(a.kwarg.arg)
    for st in owner.body:
        if st.lineno >= first.lineno:
            break
        for n in _ast.walk(st):
            if isinstance(n, _ast.Name) and isinstance(
                    n.ctx, _ast.Store):
                defined_before.add(n.id)
            elif isinstance(n, (_ast.FunctionDef,
                                _ast.AsyncFunctionDef, _ast.ClassDef)):
                defined_before.add(n.name)
            elif isinstance(n, _ast.Import):
                for al in n.names:
                    defined_before.add((al.asname or al.name)
                                       .split(".")[0])
            elif isinstance(n, _ast.ImportFrom):
                for al in n.names:
                    defined_before.add(al.asname or al.name)
    builtin_names = set(dir(_builtins))
    params = sorted((loads - stores) & defined_before - builtin_names)
    loads_after = set()
    for st in owner.body:
        if st.lineno > last.end_lineno:
            for n in _ast.walk(st):
                if isinstance(n, _ast.Name) and isinstance(
                        n.ctx, _ast.Load):
                    loads_after.add(n.id)
    returns = sorted(stores & loads_after)
    indent = " " * first.col_offset
    block_lines = lines[first.lineno - 1:last.end_lineno]
    base = " " * first.col_offset
    body_lines = [(l[len(base):] if l.startswith(base) else l)
                  for l in block_lines]
    fn = ["def " + name + "(" + ", ".join(params) + "):"]
    for l in body_lines:
        fn.append("    " + l if l.strip() else l)
    if returns:
        fn.append("    return " + ", ".join(returns))
    call = name + "(" + ", ".join(params) + ")"
    if returns:
        call = ", ".join(returns) + " = " + call
    call_line = indent + call
    if isinstance(owner, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
        insert_at = min([owner.lineno]
                        + [d.lineno for d in owner.decorator_list])
    else:
        insert_at = first.lineno
    out = []
    for i, l in enumerate(lines, 1):
        if i == insert_at:
            out.extend(fn)
            out.append("")
            out.append("")
        if first.lineno <= i <= last.end_lineno:
            if i == first.lineno:
                out.append(call_line)
            continue
        out.append(l)
    new_text = "\n".join(out) + ("\n" if text.endswith("\n") else "")
    _ast.parse(new_text)
    return {"files": [{"path": data["path"], "content": new_text}],
            "info": {"params": params, "returns": returns}}


def refactor_extract_variable(data):
    _check_ident(data.get("name", ""))
    name = data["name"]
    p = safe_path(data["path"])
    text = p.read_text()
    lines = text.splitlines()
    line_no = int(data["line"])
    scol = int(data["startCol"])
    ecol = int(data["endCol"])
    if not (1 <= line_no <= len(lines)):
        raise ValueError("line out of range")
    expr = lines[line_no - 1][scol:ecol]
    if not expr or not expr.strip() or "\n" in expr:
        raise ValueError("Select an expression on one line first.")
    is_py = p.suffix.lower() == ".py"
    if is_py:
        _ast.parse(expr, mode="eval")
    lo, hi = 1, len(lines)
    if is_py:
        tree = _ast.parse(text)
        best = None
        for n in _ast.walk(tree):
            if isinstance(n, (_ast.FunctionDef, _ast.AsyncFunctionDef)) \
                    and n.lineno <= line_no <= n.end_lineno:
                if best is None or (n.end_lineno - n.lineno) < \
                        (best.end_lineno - best.lineno):
                    best = n
        if best is not None:
            lo, hi = best.lineno, best.end_lineno
    bare = bool(_IDENT_RE.match(expr))
    pat = None
    if bare:
        pat = _re_mod.compile(r"\b" + _re_mod.escape(expr) + r"\b")
    count = 0
    new_lines = list(lines)
    for i in range(lo - 1, hi):
        if pat:
            new_lines[i], n = pat.subn(name, new_lines[i])
        else:
            n = new_lines[i].count(expr)
            if n:
                new_lines[i] = new_lines[i].replace(expr, name)
        count += n
    if count == 0:
        raise ValueError("Expression not found in scope.")
    first_idx = next(i for i in range(lo - 1, hi)
                     if new_lines[i] != lines[i])
    stmt_line = lines[first_idx]
    indent = stmt_line[:len(stmt_line) - len(stmt_line.lstrip())]
    decl = (indent + name + " = " + expr) if is_py else \
        (indent + "const " + name + " = " + expr + ";")
    new_lines.insert(first_idx, decl)
    new_text = "\n".join(new_lines) + \
        ("\n" if text.endswith("\n") else "")
    if is_py:
        _ast.parse(new_text)
    return {"files": [{"path": data["path"], "content": new_text}],
            "info": {"replaced": count, "expression": expr}}


def refactor_inline(data):
    _check_ident(data.get("name", ""))
    name = data["name"]
    idx = _symbol_index()
    defs = [s for s in idx["symbols"]
            if s["name"] == name and s["kind"] == "value"]
    if len(defs) != 1:
        raise ValueError("Inline needs exactly one simple "
                         "assignment to " + name + " in the "
                         "workspace; found " + str(len(defs)) + ".")
    d0 = defs[0]
    p = safe_path(d0["path"])
    def_lines = p.read_text().splitlines()
    def_line = def_lines[d0["line"] - 1]
    m = _re_mod.match(r"^\s*(?:const\s+|let\s+|var\s+)?"
                      + _re_mod.escape(name) + r"\s*=\s*(.+?);?\s*$",
                      def_line)
    if not m:
        raise ValueError("The definition of " + name +
                         " is not a simple one-line assignment.")
    expr = m.group(1)
    assign_pat = _re_mod.compile(r"\b" + _re_mod.escape(name)
                                 + r"\s*=(?!=)")
    refs = idx["refs"].get(name, [])
    by_file = {}
    for r in refs:
        by_file.setdefault(r["path"], []).append(r)
    simple = bool(_re_mod.match(r"^[\w$.\"'/\[\] ]+$", expr))
    replacement = expr if simple else "(" + expr + ")"
    word_pat = _re_mod.compile(r"\b" + _re_mod.escape(name) + r"\b")
    changes = []
    for path, file_refs in by_file.items():
        fp = safe_path(path)
        ftext = fp.read_text()
        flines = ftext.splitlines()
        touched = set(r["line"] for r in file_refs)
        for ln in touched:
            if assign_pat.search(flines[ln - 1]) and not (
                    path == d0["path"] and ln == d0["line"]):
                raise ValueError(name + " is assigned in more "
                                 "than one place (" + path + ").")
        out = []
        for i, l in enumerate(flines, 1):
            if path == d0["path"] and i == d0["line"]:
                continue
            if i in touched:
                l = word_pat.sub(replacement, l)
            out.append(l)
        new_text = "\n".join(out) + \
            ("\n" if ftext.endswith("\n") else "")
        if fp.suffix.lower() == ".py":
            _ast.parse(new_text)
        if new_text != ftext:
            changes.append({"path": path, "content": new_text,
                            "_old": ftext})
    if not changes:
        raise ValueError("Nothing to inline.")
    return {"files": changes,
            "info": {"expression": expr, "files": len(changes)}}


def refactor_move(data):
    src = safe_path(data["from"])
    dst = safe_path(data["to"])
    if not src.is_file():
        raise ValueError("no such file: " + data["from"])
    if dst.exists():
        raise ValueError("already exists: " + data["to"])
    frm, to = data["from"], data["to"]
    changes = []
    total = 0
    if frm.endswith(".py"):
        old_mod = frm[:-3].replace("/", ".")
        new_mod = to[:-3].replace("/", ".")
        mod_pat = _re_mod.compile(
            r"^(\s*(?:import|from)\s+)" + _re_mod.escape(old_mod)
            + r"(?=[\s.]|$)")
        for rel, fp in iter_text_files():
            if str(rel) == frm or not str(rel).endswith(".py"):
                continue
            ftext = fp.read_text()
            flines = ftext.splitlines()
            hit = False
            for i, l in enumerate(flines):
                if mod_pat.search(l):
                    flines[i] = mod_pat.sub(
                        lambda mm: mm.group(1) + new_mod, l, count=1)
                    hit = True
                    total += 1
            if hit:
                new_text = "\n".join(flines) + \
                    ("\n" if ftext.endswith("\n") else "")
                _ast.parse(new_text)
                changes.append({"path": str(rel),
                                "content": new_text, "_old": ftext})
    elif frm.endswith((".js", ".mjs")):
        import posixpath
        for rel, fp in iter_text_files():
            rstr = str(rel)
            if rstr == frm or not rstr.endswith((".js", ".mjs")):
                continue
            idir = posixpath.dirname(rstr) or "."

            def spec(target):
                s = posixpath.relpath(target, idir)
                if s.endswith(".js"):
                    s = s[:-3]
                if not s.startswith("."):
                    s = "./" + s
                return s

            old_spec, new_spec = spec(frm), spec(to)
            ftext = fp.read_text()
            if old_spec == new_spec:
                continue
            n = ftext.count("'" + old_spec + "'") \
                + ftext.count('"' + old_spec + '"')
            if n:
                new_text = ftext.replace("'" + old_spec + "'",
                                         "'" + new_spec + "'") \
                    .replace('"' + old_spec + '"',
                             '"' + new_spec + '"')
                changes.append({"path": rstr, "content": new_text,
                                "_old": ftext})
                total += n
    return {"files": changes, "move": {"from": frm, "to": to},
            "info": {"filesFixed": len(changes),
                     "replacements": total}}


# ---------------- Smart context (Roadmap G4) ----------------
# GhostSlice v2: instead of slicing the whole workspace flat,
# start from a seed file and pull in its dependency graph -
# what it imports, what imports it, the files defining the
# symbols it uses, and its tests - packed into the budget in
# that order, with the manifest saying why each file rode
# along and what got cut.
import posixpath as _posix


def _imports_of(rel, text, all_files):
    deps = set()
    if rel.endswith(".py"):
        for m in _re_mod.finditer(
                r"^\s*(?:from|import)\s+([\w.]+)", text,
                _re_mod.M):
            parts = m.group(1).split(".")
            for k in range(len(parts), 0, -1):
                cand = "/".join(parts[:k]) + ".py"
                if cand in all_files:
                    deps.add(cand)
                    break
                cand2 = "/".join(parts[:k]) + "/__init__.py"
                if cand2 in all_files:
                    deps.add(cand2)
                    break
        base_dir = _posix.dirname(rel)
        for m in _re_mod.finditer(
                r"^\s*from\s*\.([\w.]*)\s+import\s+([\w,\s]+)",
                text, _re_mod.M):
            sub = m.group(1)
            for nm in m.group(2).split(","):
                nm = nm.strip()
                if not nm:
                    continue
                cand = _posix.normpath(_posix.join(
                    base_dir, sub.replace(".", "/"),
                    nm + ".py"))
                if cand in all_files:
                    deps.add(cand)
            if sub:
                cand = _posix.normpath(_posix.join(
                    base_dir, sub.replace(".", "/") + ".py"))
                if cand in all_files:
                    deps.add(cand)
    else:
        base_dir = _posix.dirname(rel)
        for m in _re_mod.finditer(
                r"(?:from\s+|require\(\s*)['\"](\.[^'\"]+)['\"]",
                text):
            raw = m.group(1)
            target = _posix.normpath(_posix.join(base_dir, raw))
            for cand in (target, target + ".js", target + ".mjs",
                         target + "/index.js"):
                if cand in all_files:
                    deps.add(cand)
                    break
    deps.discard(rel)
    return deps


def make_smart_context(seed, budget_tokens):
    if not seed:
        raise ValueError("Smart context needs a seed: open the "
                         "file you are working on first.")
    idx = _symbol_index()
    texts = idx["texts"]
    if seed not in texts:
        raise ValueError("seed file not in the workspace: " + seed)
    budget_chars = max(2000, int(budget_tokens or 6000) * 4)
    all_files = set(texts)
    imports_map = {rel: _imports_of(rel, texts[rel], all_files)
                   for rel in all_files}
    imported_by = {}
    for rel, ds in imports_map.items():
        for d in ds:
            imported_by.setdefault(d, set()).add(rel)
    defs_by_name = {}
    for s in idx["symbols"]:
        defs_by_name.setdefault(s["name"], set()).add(s["path"])
    seed_text = texts[seed]
    used_names = set(_re_mod.findall(r"[A-Za-z_]\w+", seed_text))
    neighbor_score = {}
    for nm in used_names:
        for pf in defs_by_name.get(nm, ()):
            if pf != seed:
                neighbor_score[pf] = neighbor_score.get(pf, 0) + 1
    neighbors = sorted(neighbor_score,
                       key=lambda p: -neighbor_score[p])
    stem = _posix.basename(seed)
    stem = stem.rsplit(".", 1)[0]
    tests = sorted(
        p for p in all_files
        if p != seed and stem in p and (
            _posix.basename(p).startswith("test_")
            or "_test." in _posix.basename(p)
            or ".test." in _posix.basename(p)
            or "/tests/" in "/" + p))
    plan = [(seed, "the file you are editing", 0.45)]
    for p in sorted(imports_map.get(seed, ())):
        plan.append((p, "imported by the seed", 0.25))
    for p in tests:
        plan.append((p, "test for the seed", 0.20))
    for p in sorted(imported_by.get(seed, ())):
        plan.append((p, "imports the seed", 0.25))
    for p in neighbors:
        plan.append((p, "defines a symbol the seed uses", 0.20))
    seen = set()
    included = []
    cut = []
    parts = []
    used = 0
    for path, reason, share in plan:
        if path in seen:
            continue
        seen.add(path)
        content = texts[path]
        cap = int(budget_chars * share)
        piece = content[:cap]
        truncated = len(content) > cap
        cost = len(piece) + len(path) + 60
        if included and used + cost > budget_chars:
            cut.append({"path": path, "reason": reason})
            continue
        header = "===== %s (full%s, %s) =====\n" % (
            path, ", truncated" if truncated else "", reason)
        parts.append(header + piece)
        used += len(header) + len(piece)
        included.append({"path": path, "reason": reason})
    if cut:
        parts.append("===== Also related (not included, "
                     "budget): " + ", ".join(
                         c["path"] + " (" + c["reason"] + ")"
                         for c in cut) + " =====")
    text = "\n\n".join(parts)
    original = sum(len(t) for t in texts.values())
    return {
        "text": text,
        "tokens": max(1, len(text) // 4),
        "originalTokens": max(1, original // 4),
        "files": len(included),
        "mode": "smart",
        "budget": budget_tokens,
        "over": False,
        "included": included,
        "cut": cut,
    }


# ---------------- Test runner (Roadmap G6) ----------------
# Python tests run through a tiny stdlib runner (no pytest
# dependency, identical output everywhere): plain test_*
# functions plus unittest TestCase classes, one JSON line
# per test. Node tests use node --test's TAP output.
# Roadmap G21: SQL checker and runner, run through the
# stdlib sqlite3 against a throwaway in-memory database.
# The checker executes statements in order, so it catches
# syntax errors and missing-table references in sequence;
# the runner also prints result rows for queries.
_SQL_SPLIT = r'''
def _stmts(src):
    import sqlite3
    out, cur = [], ""
    start = 1
    for ln, line in enumerate(src.splitlines(True), 1):
        if not cur.strip():
            start = ln
        cur += line
        if sqlite3.complete_statement(cur):
            if cur.strip():
                out.append((start, cur))
            cur = ""
    if cur.strip():
        out.append((start, cur))
    return out
'''
SQL_CHECKER = (
    "import sqlite3, sys\n"
    + _SQL_SPLIT
    + "src = open(sys.argv[1], encoding='utf-8').read()\n"
    + "db = sqlite3.connect(':memory:')\n"
    + "ss = _stmts(src)\n"
    + "for start, st in ss:\n"
    + "    try:\n"
    + "        db.execute(st)\n"
    + "    except Exception as e:\n"
    + "        print('SQL error at line %d: %s' % (start, e))\n"
    + "        sys.exit(1)\n"
    + "print('SQL OK: %d statement(s) checked on an empty '\n"
    + "      'in-memory database' % len(ss))\n")
SQL_RUNNER = (
    "import sqlite3, sys\n"
    + _SQL_SPLIT
    + "src = open(sys.argv[1], encoding='utf-8').read()\n"
    + "db = sqlite3.connect(':memory:')\n"
    + "for _ln, st in _stmts(src):\n"
    + "    c = db.execute(st)\n"
    + "    if c.description:\n"
    + "        print(' | '.join(d[0] for d in c.description))\n"
    + "        for row in c.fetchall():\n"
    + "            print(' | '.join(['NULL' if v is None else str(v) for v in row]))\n"
    + "    elif c.rowcount and c.rowcount > 0:\n"
    + "        print('ok, %d row(s) affected' % c.rowcount)\n"
    + "    else:\n"
    + "        print('ok')\n"
    + "db.commit()\n")

_TEST_RUNNER = r'''
import importlib.util, json, os, re, sys, traceback, unittest
path = sys.argv[1]
only = sys.argv[2] if len(sys.argv) > 2 else None
sys.path.insert(0, os.path.dirname(os.path.abspath(path)))
sys.path.insert(0, os.getcwd())
spec = importlib.util.spec_from_file_location("ghost_test_mod", path)
mod = importlib.util.module_from_spec(spec)
def last_line(tb):
    line = None
    for ln in tb.splitlines():
        if 'File "' in ln and os.path.basename(path) in ln:
            m = re.search(r"line (\d+)", ln)
            if m:
                line = int(m.group(1))
    return line
try:
    spec.loader.exec_module(mod)
except Exception:
    print(json.dumps({"name": "(module load)", "status": "fail",
                      "message": traceback.format_exc(limit=3),
                      "line": None}))
    sys.exit(0)
for name in sorted(dir(mod)):
    if only and name != only:
        continue
    if name.startswith("test_"):
        fn = getattr(mod, name)
        if callable(fn) and getattr(fn, "__module__", None) == mod.__name__:
            try:
                fn()
                print(json.dumps({"name": name, "status": "pass",
                                  "message": "", "line": None}))
            except Exception:
                tb = traceback.format_exc()
                print(json.dumps({"name": name, "status": "fail",
                    "message": tb.strip().splitlines()[-1]
                               if tb.strip() else "",
                    "line": last_line(tb)}))
loader = unittest.TestLoader()
for name in sorted(dir(mod)):
    obj = getattr(mod, name)
    if isinstance(obj, type) and issubclass(obj, unittest.TestCase) \
            and obj is not unittest.TestCase:
        suite = loader.loadTestsFromTestCase(obj)
        for test in suite:
            result = unittest.TestResult()
            test.run(result)
            tname = name + "." + test._testMethodName
            if result.wasSuccessful():
                print(json.dumps({"name": tname, "status": "pass",
                                  "message": "", "line": None}))
            else:
                probs = result.failures + result.errors
                tb = probs[0][1] if probs else ""
                print(json.dumps({"name": tname, "status": "fail",
                    "message": tb.strip().splitlines()[-1]
                               if tb.strip() else "",
                    "line": last_line(tb)}))
'''


def discover_tests():
    files = []
    for rel, p in iter_text_files():
        rstr = str(rel)
        base = p.name
        kind = None
        if base.startswith("test_") and base.endswith(".py") or \
                base.endswith("_test.py"):
            kind = "py"
        elif base.endswith((".test.js", ".spec.js", ".test.mjs")):
            kind = "node"
        if not kind:
            continue
        tests = []
        if kind == "py":
            try:
                text = p.read_text(errors="strict")
            except Exception:
                text = ""
            for i, line in enumerate(text.splitlines(), 1):
                m = _re_mod.match(r"def (test_\w+)", line) or \
                    _re_mod.match(r"\s+def (test_\w+)", line)
                if m:
                    tests.append({"name": m.group(1), "line": i})
        files.append({"path": rstr, "kind": kind, "tests": tests})
    return files


def run_test_file(rel, only=None):
    p = safe_path(rel)
    results = []
    if rel.endswith(".py"):
        argv = [py_cmd()[0], "-c", _TEST_RUNNER, str(p)]
        if only:
            argv.append(only)
        rc, out, err, ms = run_cmd(
            argv, cwd=str(WORKSPACE), timeout=60)
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                results.append({"name": d["name"], "file": rel,
                                "line": d.get("line"),
                                "status": d["status"],
                                "message": d.get("message", "")})
        if not results:
            results.append({"name": "(runner)", "file": rel,
                            "line": None, "status": "fail",
                            "message": (err or out).strip()[-200:]})
    else:
        js_argv = ["node", "--test"]
        if only:
            # node matches names by regex; discovered
            # names are data, so escape before passing.
            js_argv += ["--test-name-pattern",
                        _re_mod.escape(only)]
        js_argv.append(str(p))
        rc, out, err, ms = run_cmd(js_argv,
                                   cwd=str(WORKSPACE), timeout=60)
        output = out + err
        # Two output dialects: TAP ("ok 1 - name") and the spec
        # reporter ("✔ name (1.0ms)" / "✖ name ..."), which also
        # repeats failures under a "failing tests:" section -
        # dedupe by name, and harvest fail lines from the
        # "test at <file>:<line>:<col>" markers there.
        fail_lines = {}
        olines = output.splitlines()
        for i, line in enumerate(olines):
            m = _re_mod.match(r"test at \S+:(\d+):\d+", line.strip())
            if m:
                for j in range(i + 1, min(i + 3, len(olines))):
                    nm = _re_mod.match(r"✖ (.+?) \(", olines[j].strip())
                    if nm:
                        fail_lines[nm.group(1)] = int(m.group(1))
                        break
        seen_names = set()
        for line in olines:
            s = line.strip()
            status = None
            name = None
            m = _re_mod.match(r"^(not )?ok \d+ - (.+)$", s)
            if m:
                status = "fail" if m.group(1) else "pass"
                name = m.group(2)
                if name.endswith("# SKIP"):
                    # A name-pattern run reports the
                    # tests it skipped; they did not run
                    # and must not count as passes.
                    continue
            else:
                m = _re_mod.match(r"^(✔|✖) (.+?) \([\d.]+m?s\)$", s)
                if m:
                    status = "pass" if m.group(1) == "✔" else "fail"
                    name = m.group(2)
            if name is None or name in seen_names:
                continue
            seen_names.add(name)
            results.append({
                "name": name, "file": rel,
                "line": fail_lines.get(name),
                "status": status, "message": ""})
        if not results:
            results.append({
                "name": "(file)", "file": rel, "line": None,
                "status": "pass" if rc == 0 else "fail",
                "message": output.strip()[-200:] if rc != 0 else ""})
    return results


# ---------------- Debugger sessions (Roadmap G7) ----------------
# One debug_bridge.py subprocess per session; a reader thread
# feeds a queue so HTTP handlers can wait with a timeout
# without fighting the pipe's buffering.
import queue as _queue
import threading as _threading

_DEBUG_SESSIONS = {}


def _dbg_read(session, timeout=30):
    try:
        line = session["queue"].get(timeout=timeout)
    except _queue.Empty:
        return {"event": "timeout"}
    if line is None:
        return {"event": "exited", "code": -1, "stdout": "",
                "error": "debugger process ended"}
    try:
        return json.loads(line)
    except Exception:
        return {"event": "timeout"}


def _dbg_send(session, obj):
    session["proc"].stdin.write(json.dumps(obj) + "\n")
    session["proc"].stdin.flush()


def _dbg_kill(sid):
    session = _DEBUG_SESSIONS.pop(sid, None)
    if session:
        try:
            session["proc"].kill()
        except Exception:
            pass


def _dbg_start(path, breakpoints):
    for sid in list(_DEBUG_SESSIONS):
        _dbg_kill(sid)
    p = safe_path(path)
    if not p.is_file():
        raise ValueError("no such file: " + path)
    bridge = Path(__file__).resolve().parent / "debug_bridge.py"
    proc = subprocess.Popen(
        [py_cmd()[0], "-u", str(bridge), str(p)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        text=True, cwd=str(WORKSPACE), bufsize=1)
    q = _queue.Queue()

    def reader():
        try:
            for line in proc.stdout:
                q.put(line)
        except Exception:
            pass
        q.put(None)

    _threading.Thread(target=reader, daemon=True).start()
    session = {"proc": proc, "queue": q}
    sid = "dbg-%d" % int(time.time() * 1000)
    _DEBUG_SESSIONS[sid] = session
    _dbg_send(session, {"cmd": "start",
                        "breakpoints": [int(b) for b in breakpoints]})
    ev = _dbg_read(session, timeout=15)
    if ev.get("event") == "exited":
        _dbg_kill(sid)
    return sid, ev


def _dbg_cmd(sid, cmd):
    session = _DEBUG_SESSIONS.get(sid)
    if not session:
        raise ValueError("debug session is gone - start again")
    if cmd == "quit":
        try:
            _dbg_send(session, {"cmd": "quit"})
            _dbg_read(session, timeout=3)
        except Exception:
            pass
        _dbg_kill(sid)
        return {"event": "exited", "code": 0, "stdout": ""}
    _dbg_send(session, {"cmd": cmd})
    ev = _dbg_read(session, timeout=60)
    if ev.get("event") == "exited":
        _dbg_kill(sid)
    return ev


# ---------------- Terminal + REPL sessions (Roadmap G10) --------
# One persistent bash for the terminal pane: cwd, env and
# variables survive across commands. A sentinel line printed
# after each command carries its exit code and cwd. A command
# that outlives the timeout costs the session (killed and
# restarted) rather than desyncing the stream.
_TERM = {}
_TERM_LOCK = _threading.Lock()
_TERM_SEQ = [0]


def _term_spawn():
    proc = subprocess.Popen(
        ["bash", "--norc"], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, cwd=str(WORKSPACE), bufsize=1)
    q = _queue.Queue()

    def reader():
        try:
            for line in proc.stdout:
                q.put(line)
        except Exception:
            pass
        q.put(None)

    _threading.Thread(target=reader, daemon=True).start()
    _TERM["proc"] = proc
    _TERM["queue"] = q
    _TERM["pending"] = ""


def _term_kill():
    proc = _TERM.pop("proc", None)
    _TERM.pop("queue", None)
    _TERM["pending"] = ""
    if proc:
        try:
            proc.kill()
        except Exception:
            pass


def _term_run(cmd, timeout=30):
    with _TERM_LOCK:
        proc = _TERM.get("proc")
        if proc is None or proc.poll() is not None:
            _term_spawn()
            proc = _TERM["proc"]
        q = _TERM["queue"]
        _TERM_SEQ[0] += 1
        marker = "__GHOST_TERM_%d__" % _TERM_SEQ[0]
        try:
            proc.stdin.write(cmd + "\n")
            proc.stdin.write(
                "printf '\\n%s rc=%s cwd=%s\\n' '" + marker
                + "' \"$?\" \"$(pwd)\"\n")
            proc.stdin.flush()
        except Exception:
            _term_kill()
            return {"stdout": "", "stderr": "terminal session "
                    "died; it restarts with your next command",
                    "code": -1, "cwd": str(WORKSPACE)}
        buf = _TERM.get("pending", "")
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                chunk = q.get(timeout=max(
                    0.05, deadline - time.time()))
            except _queue.Empty:
                break
            if chunk is None:
                _term_kill()
                return {"stdout": buf, "stderr": "(shell exited; "
                        "a fresh one starts with your next "
                        "command)", "code": -1,
                        "cwd": str(WORKSPACE)}
            buf += chunk
            idx = buf.find("\n" + marker + " ")
            if idx >= 0:
                end = buf.find("\n", idx + 1)
                line = buf[idx + 1:end if end >= 0 else len(buf)]
                m = _re_mod.search(r"rc=(-?\d+) cwd=(.*)$", line)
                _TERM["pending"] = buf[end + 1:] if end >= 0 else ""
                return {"stdout": buf[:idx] + (
                        "\n" if idx > 0 and
                        not buf[:idx].endswith("\n") else ""),
                        "stderr": "",
                        "code": int(m.group(1)) if m else 0,
                        "cwd": m.group(2) if m else str(WORKSPACE)}
        _term_kill()
        return {"stdout": buf, "stderr": "(timed out after %ds; "
                "the terminal session was restarted)" % timeout,
                "code": -1, "cwd": str(WORKSPACE)}


# One persistent CPython REPL (python3 -u -i). Output arrives
# in raw chunks (prompts have no newline), collected with a
# settle window: quiet for `settle` seconds after data means
# the turn is done.
_REPL = {}
_REPL_LOCK = _threading.Lock()


def _repl_spawn():
    proc = subprocess.Popen(
        [py_cmd()[0], "-u", "-i"], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd=str(WORKSPACE))
    q = _queue.Queue()
    fd = proc.stdout.fileno()

    def reader():
        try:
            while True:
                data = os.read(fd, 4096)
                if not data:
                    break
                q.put(data.decode("utf-8", "replace"))
        except Exception:
            pass
        q.put(None)

    _threading.Thread(target=reader, daemon=True).start()
    _REPL["proc"] = proc
    _REPL["queue"] = q
    _REPL["dead"] = False


def _repl_kill():
    proc = _REPL.pop("proc", None)
    _REPL.pop("queue", None)
    if proc:
        try:
            proc.kill()
        except Exception:
            pass


def _repl_drain(settle=0.35, maxwait=6.0):
    q = _REPL["queue"]
    out = []
    deadline = time.time() + maxwait
    last_data = time.time()
    got_any = False
    while time.time() < deadline:
        try:
            chunk = q.get(timeout=0.1)
        except _queue.Empty:
            if got_any and time.time() - last_data > settle:
                break
            continue
        if chunk is None:
            _REPL["dead"] = True
            break
        out.append(chunk)
        got_any = True
        last_data = time.time()
    return "".join(out)


def _repl_send(text):
    with _REPL_LOCK:
        proc = _REPL.get("proc")
        if proc is None or proc.poll() is not None \
                or _REPL.get("dead"):
            _repl_spawn()
            banner = _repl_drain(settle=0.5, maxwait=6.0)
            if not text:
                return banner
            prefix = banner
        else:
            prefix = ""
        try:
            _REPL["proc"].stdin.write(
                (text + "\n").encode("utf-8"))
            _REPL["proc"].stdin.flush()
        except Exception:
            _repl_kill()
            return prefix + "(python exited)"
        out = _repl_drain()
        if _REPL.get("dead"):
            out += "\n(python exited)"
            _repl_kill()
        return prefix + out


def git_out(args, timeout=30):
    if not shutil.which("git"):
        raise ValueError("git is not installed")
    return run_cmd(["git", "-C", str(WORKSPACE)] + args,
                   WORKSPACE, timeout)


def _branch_name_ok(name):
    """Cycle 7: a branch name must never be usable as a
    git flag (leading dash is excluded by the first
    character class) or as a path (no dot-dot, no
    trailing slash or .lock)."""
    return (bool(_re_mod.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._/-]*", name or ""))
        and ".." not in name
        and not name.endswith("/")
        and not name.endswith(".lock"))


# GitHub connect (v2.08): network git with token auth
# that never lands in .git/config. The token travels
# in an env var; a tiny askpass script answers git's
# prompts from it. The script lives in the system
# temp dir, outside any workspace.
ASKPASS_PATH = None


def _ensure_askpass():
    """Per-process unique askpass script (R2): a
    predictable name in a shared temp dir could be
    pre-planted by another process and would run
    with our token in the environment, so the file
    is created fresh by mkstemp (mode 0600) and
    always written by us."""
    global ASKPASS_PATH
    try:
        if ASKPASS_PATH is not None and ASKPASS_PATH.exists():
            return
        import os as _os
        fd, name = tempfile.mkstemp(
            prefix="ghostide-askpass-", suffix=".sh")
        with _os.fdopen(fd, "w") as f:
            f.write(
                "#!/bin/sh\n"
                "case \"$1\" in\n"
                "*Username*) echo \"x-access-token\" ;;\n"
                "*) echo \"$GHOSTIDE_GH_TOKEN\" ;;\n"
                "esac\n")
        ASKPASS_PATH = Path(name)
        ASKPASS_PATH.chmod(0o700)
    except Exception:
        pass


def git_net(args, token="", timeout=180, cwd=None):
    if not shutil.which("git"):
        raise ValueError("git is not installed")
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    if token:
        _ensure_askpass()
        env["GIT_ASKPASS"] = str(ASKPASS_PATH)
        env["GHOSTIDE_GH_TOKEN"] = token
    return run_cmd(["git"] + args, cwd or WORKSPACE, timeout,
                   env=env)


def repo_name_from_url(url):
    clean = (url or "").strip().rstrip("/").removesuffix(".git")
    parts = clean.replace("/", " ").replace(":", " ").split()
    return parts[-1] if parts else ""


def _dl_worker(mid):
    """Background model download (Roadmap G18): streams to
    a .part file with resume, then an exact-size gate and
    SHA-256 verification before the file becomes the
    model - the same discipline as the phone downloader."""
    global MODEL, MODEL_NAME
    import hashlib
    entry = MODEL_CATALOG[mid]
    DL_CONTROL.update({"pause": False, "cancel": False})
    try:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        dest = MODELS_DIR / entry["file"]
        part = MODELS_DIR / (entry["file"] + ".part")
        have = part.stat().st_size if part.exists() else 0
        if have > entry["bytes"]:
            part.unlink()
            have = 0
        DL_STATE.update({"state": "downloading", "id": mid,
                         "done": have, "total": entry["bytes"],
                         "error": ""})
        req = urllib.request.Request(entry["url"])
        if have:
            req.add_header("Range", "bytes=%d-" % have)
        with urllib.request.urlopen(req, timeout=60) as r:
            if have and r.status != 206:
                have = 0
            with open(part, "ab" if have else "wb") as f:
                done = have
                while True:
                    # D6: pause keeps the .part file (a
                    # later Download resumes it); cancel
                    # removes it. Checked per chunk.
                    if DL_CONTROL["cancel"]:
                        raise _DlStop("cancel")
                    if DL_CONTROL["pause"]:
                        raise _DlStop("pause")
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    DL_STATE["done"] = done
        if part.stat().st_size != entry["bytes"]:
            DL_STATE.update({
                "state": "error",
                "error": "download incomplete - tap Download "
                         "again to resume"})
            return
        if DL_CONTROL["cancel"]:
            raise _DlStop("cancel")
        DL_STATE["state"] = "verifying"
        h = hashlib.sha256()
        with open(part, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 22), b""):
                h.update(chunk)
        if h.hexdigest() != entry["sha256"]:
            part.unlink(missing_ok=True)
            DL_STATE.update({
                "state": "error",
                "error": "checksum mismatch - the file was "
                         "deleted; download again"})
            return
        part.rename(dest)
        DL_STATE.update({"state": "done", "done": entry["bytes"]})
        MODEL = str(dest)
        MODEL_NAME = dest.name.replace(".gguf", "")
    except _DlStop as stop:
        # D6: pause keeps the partial file for a Range
        # resume; cancel removes it.
        if stop.kind == "cancel":
            part.unlink(missing_ok=True)
            DL_STATE.update({"state": "idle", "done": 0,
                             "error": ""})
        else:
            DL_STATE.update({"state": "paused"})
    except Exception as e:
        DL_STATE.update({"state": "error", "error": str(e)})


def _llama_dl_worker():
    """Background llama.cpp fetch (Roadmap G18): the same
    discipline as the model download - streams to a .part
    file with resume, an exact-size gate and SHA-256
    verification, and only then extraction into the app
    folder's llama/ directory. Never runs when a
    llama-server is already present."""
    import hashlib
    import tarfile
    import zipfile
    if os.environ.get("LLAMA_SERVER_BIN"):
        LLAMA_DL_STATE.update({
            "state": "error",
            "error": "LLAMA_SERVER_BIN is set; GhostIDE "
                     "uses that llama-server instead"})
        return
    if llama_present():
        LLAMA_DL_STATE.update({"state": "done"})
        return
    key = _llama_platform_key()
    entry = LLAMA_CATALOG.get(key or "")
    if entry is None:
        LLAMA_DL_STATE.update({
            "state": "error",
            "error": "no prebuilt llama.cpp for this "
                     "platform; install llama.cpp and set "
                     "LLAMA_SERVER_BIN"})
        return
    try:
        dest_dir = _llama_dir()
        stage = dest_dir.parent / ".llama-download"
        stage.mkdir(parents=True, exist_ok=True)
        part = stage / (entry["file"] + ".part")
        have = part.stat().st_size if part.exists() else 0
        if have > entry["bytes"]:
            part.unlink()
            have = 0
        LLAMA_DL_STATE.update({"state": "downloading",
                               "done": have,
                               "total": entry["bytes"],
                               "error": ""})
        req = urllib.request.Request(entry["url"])
        if have:
            req.add_header("Range", "bytes=%d-" % have)
        with urllib.request.urlopen(req, timeout=60) as r:
            if have and r.status != 206:
                have = 0
            with open(part, "ab" if have else "wb") as f:
                done = have
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    LLAMA_DL_STATE["done"] = done
        if part.stat().st_size != entry["bytes"]:
            LLAMA_DL_STATE.update({
                "state": "error",
                "error": "download incomplete - try again "
                         "to resume"})
            return
        LLAMA_DL_STATE["state"] = "verifying"
        h = hashlib.sha256()
        with open(part, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 22), b""):
                h.update(chunk)
        if h.hexdigest() != entry["sha256"]:
            part.unlink(missing_ok=True)
            LLAMA_DL_STATE.update({
                "state": "error",
                "error": "checksum mismatch - the file was "
                         "deleted; download again"})
            return
        tmp = stage / "extract"
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir()
        if entry["file"].endswith(".zip"):
            # The Windows asset carries its files at the
            # archive root, like the old package layout.
            with zipfile.ZipFile(part) as z:
                z.extractall(tmp)
        else:
            # The tar assets carry one top folder
            # (llama-<release>/); strip it, as the old
            # build scripts did.
            with tarfile.open(part) as t:
                members = []
                for m in t.getmembers():
                    pieces = m.name.split("/", 1)
                    if len(pieces) == 2 and pieces[1]:
                        m.name = pieces[1]
                        members.append(m)
                try:
                    t.extractall(tmp, members=members,
                                 filter="data")
                except TypeError:
                    t.extractall(tmp, members=members)
        name = ("llama-server.exe" if os.name == "nt"
                else "llama-server")
        if not (tmp / name).is_file():
            raise ValueError(
                "llama-server not found in the downloaded "
                "archive")
        if os.name != "nt":
            (tmp / name).chmod(0o755)
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        tmp.rename(dest_dir)
        part.unlink(missing_ok=True)
        LLAMA_DL_STATE.update({"state": "done",
                               "done": entry["bytes"]})
    except Exception as e:
        LLAMA_DL_STATE.update({"state": "error",
                               "error": str(e)})


# ---------------- Roadmap ECO E1: ecosystem tool runner -------
# The Ghost ecosystem companions are zero-dependency Python.
# The IDE runs the tools themselves (never a reimplementation)
# against the current workspace and renders their own reports.
# A tool is "ready" when its source tree is found: $GHOSTIDE_
# ECO_HOME/<id>/src, ~/ghost-ecosystem/<id>/src, or (dev)
# ~/workspace/<id>/src. Tools without a runner yet are listed
# with the roadmap goal that wires them.
ECO_CATALOG = [
    ("ghostslice", "GhostSlice", "E-adjacent (native)",
     "Context slicing - already native in GhostIDE"),
    ("ghostindex", "GhostIndex", "E1", "Offline FTS5 index of this workspace"),
    ("ghostdeps", "GhostDeps", "E1",
     "Declared vs imported dependencies, evidence only"),
    ("ghostrecall", "GhostRecall", "E5", "Recall of prior slices and sessions"),
    ("ghostatlas", "GhostAtlas", "E5", "Project map"),
    ("ghostprimer", "GhostPrimer", "E4", "First-session starter bundle"),
    ("ghosthandoff", "GhostHandoff", "E4", "Session handoff pack, propose-only"),
    ("ghostconvert", "GhostConvert", "E6", "Slice bundles to other formats"),
    ("ghostverify", "GhostVerify", "E7", "Evidence contract for executed work"),
    ("ghostbench", "GhostBench", "E7", "Opt-in live benchmark runs"),
    ("ghostreview", "GhostReview", "E8", "Plain-English verdict over a diff"),
    ("ghostscope", "GhostScope", "E9", "What a change touches"),
    ("ghostexposure", "GhostExposure", "E9", "Exposure evidence, no verdicts"),
    ("ghostapprove", "GhostApprove", "E10", "Approval queue, never executes"),
    ("ghostenv", "GhostEnv", "E11", ".env audit - names only, never values"),
    ("ghostlogs", "GhostLogs", "E13", "Log slicer: error windows, deduped"),
    ("ghostdata", "GhostData", "E14", "Structured data slicer, redacted"),
    ("ghostschema", "GhostSchema", "E14", "OpenAPI / JSON Schema slicer"),
    ("ghostworktree", "GhostWorktree", "E15", "Git worktree manager"),
    ("ghostwatch", "GhostWatch", "E16", "Freshness watcher"),
    ("ghostreplay", "GhostReplay", "E16", "Session replay"),
    ("ghostconsole", "GhostConsole", "E17", "Read-only ecosystem board"),
    ("ghostledger", "GhostLedger", "E17", "Session token ledger"),
    ("ghostmcpdoctor", "GhostMCP Doctor", "E17", "Read-only MCP diagnostics"),
    ("ghostmcp", "GhostMCP", "MCP", "MCP client - servers, tools, calls (MCP panel)"),
    ("ghostrecipes", "GhostRecipes", "E18", "Data-only project recipes"),
    ("ghostleads", "GhostLeads", "E19", "Offline lead drafts, drafts only"),
    ("quoteshot", "QuoteShot", "E19", "Offline quotes from a price book"),
    ("ghostlift", "GhostLift", "listed", "Context lift"),
    ("ghostshard", "GhostShard", "listed", "Planner only - dispatch: false"),
    ("ghostpacks", "GhostPacks", "listed", "Pack builder"),
    ("ghostfixture", "GhostFixture", "listed", "Minimal repro projects"),
    ("ghostdocs", "GhostDocs", "listed", "Docs slicer (native docs mode)"),
    ("ghostport", "GhostPort", "listed", "Migration CLI - stays a CLI"),
    ("ghostproxy", "GhostProxy", "listed",
     "Live-traffic proxy - out of scope for an offline IDE"),
    ("ghostre", "GhostRE", "RE1",
     "Reverse engineering inspector - REA's provider-free "
     "core, Ghost-native (Reverse panel)"),
]
ECO_RUNNABLE = {"ghostindex", "ghostdeps"}


def eco_src_dir(tool_id):
    roots = []
    env_home = os.environ.get("GHOSTIDE_ECO_HOME")
    if env_home:
        roots.append(Path(env_home))
    roots.append(Path.home() / "ghost-ecosystem")
    roots.append(Path.home() / "workspace")
    for root in roots:
        cand = root / tool_id / "src"
        if (cand / tool_id / "__main__.py").is_file():
            return cand
    return None


def eco_tools_state():
    out = []
    for tid, name, goal, blurb in ECO_CATALOG:
        if tid in ECO_RUNNABLE:
            src = eco_src_dir(tid)
            state = "ready" if src else "absent"
        elif goal == "E-adjacent (native)":
            state = "native"
        else:
            state = "listed"
        out.append({"id": tid, "name": name, "goal": goal,
                    "blurb": blurb, "state": state,
                    "runnable": tid in ECO_RUNNABLE})
    return out


def eco_run(tool_id, ws):
    """Run one ecosystem tool against the workspace and return
    its own report text. Raises ValueError with a plain message
    for anything not runnable."""
    if tool_id not in ECO_RUNNABLE:
        raise ValueError("that tool has no in-IDE runner yet - "
                         "it lands with its roadmap goal")
    src = eco_src_dir(tool_id)
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    env = dict(os.environ)
    env["PYTHONPATH"] = str(src)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    cmds = []
    if tool_id == "ghostindex":
        db = ws / ".ghostide" / "ghostindex.db"
        db.parent.mkdir(parents=True, exist_ok=True)
        env["GHOSTINDEX_DB"] = str(db)
        cmds = [["index", str(ws)], ["stats"]]
    elif tool_id == "ghostdeps":
        cmds = [["pack", str(ws)]]
    parts = []
    for args in cmds:
        try:
            r = subprocess.run(
                [sys.executable, "-m", tool_id] + args,
                cwd=str(ws), env=env, capture_output=True,
                text=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise ValueError("the tool ran past 120 seconds and "
                             "was stopped")
        text = (r.stdout or "") + (r.stderr or "")
        # Both tools use exit 2 for "could not run"; exit 1 is
        # a normal result for ghostdeps (findings present).
        if r.returncode == 2 or r.returncode < 0:
            raise ValueError("the tool could not run: "
                             + text.strip()[:300])
        parts.append(text.rstrip())
    return "\n".join(parts)[:60000]


# Track B: single-shot runners for the bundled eco tools
# beyond the E1 proof pair. Each wired tool maps to the one
# CLI verb that prints (or, for GhostLogs, writes) its own
# workspace report; the verbs were picked from each tool's
# own --help. File-level tools (ghostlogs, ghostdata,
# ghostschema) take the request's workspace-contained file.
# Every wired tool uses exit 2 for "could not run"; exit 1
# is a normal findings-present result for ghostenv,
# ghostledger, ghostmcpdoctor and ghostexposure, treated
# the way eco_run treats ghostdeps' exit 1.
ECO_TOOLRUN = {"ghostenv", "ghostlogs", "ghostdata",
               "ghostschema", "ghostledger", "ghostmcpdoctor",
               "ghostconsole", "ghostreplay", "ghostexposure"}
ECO_TOOLRUN_FILES = {"ghostlogs", "ghostdata", "ghostschema"}


def eco_toolrun(tool_id, ws, rel=""):
    """Run one Track B tool's report verb and return its own
    report text. Raises ValueError with a plain message for
    anything not wired or not runnable."""
    if tool_id not in ECO_TOOLRUN:
        raise ValueError("that tool has no in-IDE runner yet - "
                         "it lands with its roadmap goal")
    src = eco_src_dir(tool_id)
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    target = None
    if tool_id in ECO_TOOLRUN_FILES:
        if not rel:
            raise ValueError(tool_id + " inspects one file - "
                             "pass the workspace path of the "
                             "file to inspect")
        target = safe_path(rel)
        if not target.is_file():
            raise ValueError("file not found in the workspace: "
                             + rel)
    pack_dir = None
    if tool_id == "ghostenv":
        args = ["check", str(ws)]
    elif tool_id == "ghostlogs":
        # pack writes INCIDENT.md + manifest.json into a
        # directory; the incident file is the report text.
        pack_dir = ws / ".ghostide" / "ghostlogs-pack"
        args = ["pack", str(target), "-o", str(pack_dir)]
    elif tool_id == "ghostdata":
        args = ["schema", str(target)]
    elif tool_id == "ghostschema":
        args = ["inspect", str(target)]
    elif tool_id == "ghostledger":
        # summary reads ./.ghostledger.jsonl, so the run's
        # cwd (the workspace) is the scope.
        args = ["summary"]
    elif tool_id == "ghostmcpdoctor":
        # scan audits MCP client configs in their default
        # locations (home-level plus this project's own
        # .mcp.json / mcp.json, since cwd is the workspace);
        # --no-report keeps it to the printed summary instead
        # of writing report files into the workspace.
        args = ["scan", "--no-report"]
    elif tool_id == "ghostconsole":
        args = ["summary", str(ws)]
    elif tool_id == "ghostreplay":
        args = ["trend", str(ws)]
    else:  # ghostexposure: default built-in starter pack
        args = ["scan", str(ws)]
    env = dict(os.environ)
    env["PYTHONPATH"] = str(src)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        r = subprocess.run(
            [sys.executable, "-m", tool_id] + args,
            cwd=str(ws), env=env, capture_output=True,
            text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise ValueError("the tool ran past 120 seconds and "
                         "was stopped")
    text = (r.stdout or "") + (r.stderr or "")
    if r.returncode == 2 or r.returncode < 0:
        raise ValueError("the tool could not run: "
                         + text.strip()[:300])
    if pack_dir is not None:
        incident = pack_dir / "INCIDENT.md"
        if incident.is_file():
            return incident.read_text(
                encoding="utf-8", errors="replace")[:60000]
    return text.rstrip()[:60000]


# ---------------- Ecosystem board (E17) + log slicing (E13) ----
def eco_board(ws):
    """E17: GhostConsole's board model for this workspace,
    as JSON. The console reads the tools' own latest
    reports (verify, review, scope packs, slices) - the
    IDE's report-producing features already feed it."""
    rc, text = _eco_cli("ghostconsole",
                        ["summary", str(ws), "--json"], ws)
    if rc != 0:
        raise ValueError("GhostConsole could not run: "
                         + text.strip()[:300])
    try:
        return json.loads(text.strip())
    except ValueError:
        raise ValueError("GhostConsole returned unreadable "
                         "output")


def eco_studio(tool, verb, arg, arg2, ws):
    """Studio tools (E18/E19): GhostRecipes, GhostLeads and
    QuoteShot behind one strict allowlist. Every verb maps
    to a fixed argv shape; user input only ever fills the
    marked slots. Returns the tool's text (or the file a
    render verb wrote)."""
    gi = ws / ".ghostide"
    gi.mkdir(parents=True, exist_ok=True)

    def run(tool_name, argv):
        rc, text = _eco_cli(tool_name, argv, ws)
        if rc != 0:
            raise ValueError(text.strip()[:300] or
                             (tool_name + " failed"))
        return text.strip()

    if tool == "ghostrecipes":
        lib = str(ws / "recipes")
        if verb == "renders":
            # Cycle 2 I12: render history - the checklist
            # files renders wrote into .ghostide, newest
            # first. Cycle 3 I5: JSON, so the shelf can
            # offer an Open button per render.
            files = sorted(
                gi.glob("recipe-*.md"),
                key=lambda f: f.stat().st_mtime,
                reverse=True)[:20]
            return json.dumps([{
                "name": f.name,
                "size": f.stat().st_size,
                "mtime": int(f.stat().st_mtime),
            } for f in files])
        if verb == "list":
            return run(tool, ["list", "--library", lib,
                              "--json"])
        if verb in ("show", "validate"):
            if not arg:
                raise ValueError("a recipe id is required")
            return run(tool, [verb, arg, "--library", lib])
        if verb == "render":
            if not arg:
                raise ValueError("a recipe id is required")
            slug = _re_mod.sub(r"[^A-Za-z0-9_.-]", "_", arg)
            out_file = gi / ("recipe-" + slug + ".md")
            run(tool, ["render", arg, "--library", lib,
                       "-o", str(out_file)])
            return ("Rendered to .ghostide/" + out_file.name +
                    "\n\n" + out_file.read_text(
                        encoding="utf-8")[:40000])
        raise ValueError("unknown recipes verb: " + verb)
    if tool == "ghostleads":
        store = ws / "leads.json"
        if verb == "import":
            src = safe_path(arg)
            if not src.is_file():
                raise ValueError("import source not found: "
                                 + arg)
            return run(tool, ["import", str(src),
                              "--store", str(store)])
        if not store.is_file():
            raise ValueError("no leads store yet - import a "
                             "CSV or JSON list first")
        if verb in ("list", "score"):
            return run(tool, [verb, "--store", str(store),
                              "--json"])
        if verb == "pack":
            if not arg:
                raise ValueError("a lead name is required")
            out_dir = gi / "lead-packs"
            run(tool, ["pack", "--store", str(store),
                       "--lead", arg, "--out", str(out_dir)])
            packs = sorted(out_dir.glob("*.md"))
            if not packs:
                raise ValueError("the pack was not written")
            return ("Pack written under .ghostide/lead-packs"
                    "\n\n" + packs[-1].read_text(
                        encoding="utf-8")[:40000])
        raise ValueError("unknown leads verb: " + verb)
    if tool == "quoteshot":
        job = safe_path(arg)
        if not job.is_dir():
            raise ValueError("job folder not found: " + arg)
        if verb in ("show", "items"):
            return run(tool, [verb, str(job)])
        if verb == "render":
            run(tool, ["render", str(job), "--out", str(job)])
            txt = job / "quote.txt"
            if not txt.is_file():
                raise ValueError("the quote was not written")
            return ("Quote rendered into " + arg +
                    " (quote.html + quote.txt)\n\n" +
                    txt.read_text(encoding="utf-8")[:40000])
        raise ValueError("unknown quoteshot verb: " + verb)
    raise ValueError("unknown studio tool: " + tool)


def replay_save(task, trail, ws, elapsed_s=None):
    """E16: record one agent run's action trail for the
    Replay panel. Entries are capped and trimmed here -
    the store is IDE state, not a transcript dump."""
    d = ws / ".ghostide" / "replay"
    d.mkdir(parents=True, exist_ok=True)
    clean = []
    for e in (trail or [])[:200]:
        if not isinstance(e, dict):
            continue
        clean.append({
            "step": int(e.get("step") or 0),
            "type": str(e.get("type") or "")[:40],
            "target": str(e.get("target") or "")[:300]})
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rec = {"task": str(task or "")[:500],
           "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "trail": clean}
    # Cycle 3 I18: the run's wall-clock, when the
    # caller measured it (bounded, never backfilled).
    if (isinstance(elapsed_s, (int, float))
            and 0 <= elapsed_s <= 86400):
        rec["elapsed_s"] = int(elapsed_s)
    name = "run-" + stamp + ".json"
    p = d / name
    n = 1
    while p.exists():
        n += 1
        p = d / ("run-" + stamp + "-" + str(n) + ".json")
    p.write_text(json.dumps(rec, indent=1), encoding="utf-8")
    return {"ok": True, "id": p.name, "steps": len(clean)}


def replay_list(ws):
    d = ws / ".ghostide" / "replay"
    out = []
    if d.is_dir():
        for p in sorted(d.glob("*.json"), reverse=True)[:30]:
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except ValueError:
                continue
            item = {"id": p.name,
                    "task": rec.get("task", ""),
                    "saved_at": rec.get("saved_at", ""),
                    "steps": len(rec.get("trail") or [])}
            if isinstance(rec.get("elapsed_s"), int):
                item["elapsed_s"] = rec["elapsed_s"]
            out.append(item)
    return {"sessions": out}


def replay_get(ws, rid):
    if "/" in rid or "\\" in rid or not rid.endswith(".json"):
        raise ValueError("bad replay id")
    p = ws / ".ghostide" / "replay" / rid
    if not p.is_file():
        raise ValueError("no such replay session")
    return json.loads(p.read_text(encoding="utf-8"))


def eco_datapack(path, ws):
    """I14: build a full GhostData pack for a data file
    (manifest + PROMPT.md + bounded sample under
    .ghostide/data-pack-<stem>) and return the pack's
    PROMPT.md, the human summary of the pack."""
    target = safe_path(path)
    if not target.is_file():
        raise ValueError("not a file in the workspace: "
                         + path)
    stem = _re_mod.sub(r"[^A-Za-z0-9_.-]", "_",
                       target.stem) or "data"
    out_dir = ws / ".ghostide" / ("data-pack-" + stem)
    rc, text = _eco_cli("ghostdata",
                        ["pack", str(target), "-o",
                         str(out_dir)], ws)
    if rc != 0:
        raise ValueError("GhostData could not pack it: "
                         + text.strip()[:300])
    prompt = out_dir / "PROMPT.md"
    if prompt.is_file():
        return ("Pack built at .ghostide/" + out_dir.name +
                "\n\n" + prompt.read_text(
                    encoding="utf-8")[:40000])
    return text.strip()[:40000]


def eco_slicelog(text, ws):
    """E13: slice run output into a GhostLogs incident
    pack. The text is saved as a workspace log file first
    (GhostLogs packs files), then the tool's own INCIDENT
    report comes back."""
    if not (text or "").strip():
        raise ValueError("nothing to slice - run something "
                         "first")
    gi = ws / ".ghostide"
    gi.mkdir(parents=True, exist_ok=True)
    log = gi / "run-output.log"
    log.write_text(text[:2000000], encoding="utf-8")
    return eco_toolrun("ghostlogs", ws,
                       ".ghostide/run-output.log")


# ---------------- Git proof: GhostReview + GhostScope (E8/E9) ----
def _eco_cli(tool_id, args, ws, timeout=120):
    """Run one bundled eco tool CLI, eco_toolrun discipline.
    Returns (returncode, stdout+stderr text)."""
    src = eco_src_dir(tool_id)
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    env = dict(os.environ)
    env["PYTHONPATH"] = str(src)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        r = subprocess.run(
            [sys.executable, "-m", tool_id] + args,
            cwd=str(ws), env=env, capture_output=True,
            text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ValueError("the tool ran past %d seconds and "
                         "was stopped" % timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def git_review(ws):
    """E8: GhostReview's verdict over the working tree diff.
    The tool writes REVIEW.md + review.json into
    .ghostide/review; the panel shows its own words."""
    out_dir = ws / ".ghostide" / "review"
    out_dir.mkdir(parents=True, exist_ok=True)
    rc, text = _eco_cli(
        "ghostreview",
        ["review", str(ws), "-o", str(out_dir), "--json"], ws)
    if rc not in (0, 1):
        raise ValueError("GhostReview could not run: "
                         + text.strip()[:300])
    md = out_dir / "REVIEW.md"
    body = ""
    if md.is_file():
        body = md.read_text(encoding="utf-8",
                            errors="replace")[:60000]
    if not body:
        body = text.strip()[:60000]
    return {"ok": True, "output": body}


def git_scope(ws):
    """E9: GhostScope pack for the working tree diff vs HEAD:
    changed files in full, neighbours, covering tests, and
    its REVIEW.md reading order."""
    rc, diff, _err, _ms = git_out(["diff", "HEAD"])
    if rc != 0:
        raise ValueError("git diff failed in this workspace")
    if not diff.strip():
        raise ValueError("no changes against HEAD to scope - "
                         "edit something first")
    gi_dir = ws / ".ghostide"
    gi_dir.mkdir(parents=True, exist_ok=True)
    diff_file = gi_dir / "scope-diff.patch"
    diff_file.write_text(diff, encoding="utf-8")
    out_dir = gi_dir / "scope-pack"
    rc, text = _eco_cli(
        "ghostscope",
        ["pack", str(ws), "-o", str(out_dir),
         "--diff", str(diff_file), "--json"], ws)
    if rc not in (0, 1):
        raise ValueError("GhostScope could not run: "
                         + text.strip()[:300])
    md = out_dir / "REVIEW.md"
    body = ""
    if md.is_file():
        body = md.read_text(encoding="utf-8",
                            errors="replace")[:60000]
    if not body:
        body = text.strip()[:60000]
    return {"ok": True, "output": body}


# ------------- Desktop Cycle 3, D9: git depth -------------
# Hunk staging and the three-pane conflict editor's data.
# Everything runs through git_out / the same subprocess
# discipline as the other git routes; patches fed to
# git apply arrive on stdin as one argv-built command,
# never as shell strings, and paths are validated with
# safe_path before they reach git.

_HUNK_HDR_RE = _re_mod.compile(
    r"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@")


def _is_conflict_xy(x, y):
    """Porcelain v1 XY pair marking an unmerged path."""
    return x == "U" or y == "U" or (x, y) in (("A", "A"),
                                              ("D", "D"))


def _split_diff(diff_text):
    """Split one file's unified diff into (header lines,
    hunks). Each hunk carries a sha fingerprint of its
    header + body so a selection made against a stale
    diff can be refused, never applied blind."""
    import hashlib
    header = []
    hunks = []
    cur = None
    for ln in diff_text.splitlines():
        if _HUNK_HDR_RE.match(ln):
            if cur is not None:
                hunks.append(cur)
            cur = {"header": ln, "lines": []}
        elif cur is None:
            header.append(ln)
        else:
            cur["lines"].append(ln)
    if cur is not None:
        hunks.append(cur)
    for h in hunks:
        h["text"] = "\n".join([h["header"]] + h["lines"])
        h["sha"] = hashlib.sha256(
            h["text"].encode("utf-8")).hexdigest()
    return header, hunks


def _file_diff(path, cached):
    args = ["diff", "--no-color"]
    if cached:
        args.append("--cached")
    args += ["--", path]
    rc, out, err, _ = git_out(args)
    if rc != 0:
        raise ValueError(err.strip()[:300]
                         or "git diff failed")
    return out


def git_hunks(path, area):
    """Structured hunks for one file and area (worktree =
    unstaged changes, index = staged changes). Binary
    files carry no hunks: the client labels them
    file-level only."""
    safe_path(path)
    diff = _file_diff(path, area == "index")
    header, hunks = _split_diff(diff)
    binary = any(ln.startswith("Binary files")
                 for ln in header)
    return {"path": path, "area": area, "binary": binary,
            "headers": [h["header"] for h in hunks],
            "hunks": [{"index": i, "header": h["header"],
                       "text": h["text"], "sha": h["sha"]}
                      for i, h in enumerate(hunks)]}


def _git_apply(patch, cached=False, reverse=False):
    if not shutil.which("git"):
        raise ValueError("git is not installed")
    args = ["git", "-C", str(WORKSPACE), "apply"]
    if cached:
        args.append("--cached")
    if reverse:
        args.append("--reverse")
    try:
        r = subprocess.run(args, cwd=str(WORKSPACE),
                           input=patch, capture_output=True,
                           text=True, timeout=30)
    except subprocess.TimeoutExpired:
        raise ValueError("git apply timed out")
    if r.returncode != 0:
        raise ValueError(
            (r.stderr or r.stdout).strip()[:300]
            or "git apply failed")


def git_apply_hunks(path, area, action, indices, expect):
    """Stage, unstage or discard selected hunks of one
    file. The client echoes back the hunk headers it saw
    and the fingerprint of each hunk it selected (the
    expect block from /api/git/hunks); the diff is
    re-read here and any drift refuses the whole
    operation before git apply runs, so a stale selection
    is never applied blind."""
    safe_path(path)
    if action not in ("stage", "unstage", "discard"):
        raise ValueError("unknown hunk action")
    if action == "stage" and area != "worktree":
        raise ValueError(
            "staging applies to unstaged hunks")
    if action == "unstage" and area != "index":
        raise ValueError(
            "unstaging applies to staged hunks")
    if action == "discard" and area != "worktree":
        raise ValueError(
            "discarding applies to unstaged hunks")
    diff = _file_diff(path, area == "index")
    header, hunks = _split_diff(diff)
    exp = expect or {}
    stale = ("the diff changed since you loaded it - "
             "refresh and pick the hunks again")
    if exp.get("headers") != [h["header"] for h in hunks]:
        raise ValueError(stale)
    want_sel = {}
    for k, v in (exp.get("selected") or {}).items():
        want_sel[str(k)] = v
    sel = []
    seen = set()
    for i in indices or []:
        if not isinstance(i, int) or isinstance(i, bool) \
                or i < 0 or i >= len(hunks) or i in seen:
            raise ValueError("bad hunk selection")
        seen.add(i)
        if want_sel.get(str(i)) != hunks[i]["sha"]:
            raise ValueError(stale)
        sel.append(hunks[i])
    if not sel:
        raise ValueError("no hunks selected")
    patch = "\n".join(
        header + [h["text"] for h in sel]) + "\n"
    if action == "stage":
        _git_apply(patch, cached=True)
    elif action == "unstage":
        _git_apply(patch, cached=True, reverse=True)
    else:
        _git_apply(patch, reverse=True)
    return {"ok": True}


def _git_dir():
    rc, out, err, _ = git_out(["rev-parse", "--git-dir"])
    if rc != 0:
        return None
    d = Path(out.strip())
    if not d.is_absolute():
        d = WORKSPACE / d
    return d


def git_merge_state():
    """The in-progress operation, read from .git state:
    merge, rebase, cherry-pick or revert, else None.
    Rebase is checked first: a rebase can also leave a
    CHERRY_PICK_HEAD behind while it runs."""
    gd = _git_dir()
    if gd is None:
        return None
    if (gd / "rebase-merge").is_dir() \
            or (gd / "rebase-apply").is_dir():
        return "rebase"
    if (gd / "MERGE_HEAD").is_file():
        return "merge"
    if (gd / "CHERRY_PICK_HEAD").is_file():
        return "cherry-pick"
    if (gd / "REVERT_HEAD").is_file():
        return "revert"
    return None


def git_conflict_paths():
    rc, out, err, _ = git_out(
        ["status", "--porcelain=v1"])
    if rc != 0:
        return []
    paths = []
    for ln in out.splitlines():
        if len(ln) > 3 and _is_conflict_xy(ln[0], ln[1]):
            paths.append(ln[3:].strip())
    return paths


def git_conflict(path):
    """Base / ours / theirs stage contents plus the
    working file for one conflicted path, for the
    three-pane editor. A stage that does not exist in
    this conflict (the base of an add/add, say) comes
    back None, never an error."""
    safe_path(path)
    rc, out, err, _ = git_out(["ls-files", "-u", "--", path])
    if rc != 0:
        raise ValueError(err.strip()[:300]
                         or "git ls-files failed")
    stages = set()
    for ln in out.splitlines():
        parts = ln.split()
        if len(parts) >= 3:
            try:
                stages.add(int(parts[2]))
            except ValueError:
                pass
    if not stages:
        raise ValueError("no conflict recorded for " + path)
    texts = {}
    for n, key in ((1, "base"), (2, "ours"),
                   (3, "theirs")):
        if n in stages:
            rc, out, err, _ = git_out(
                ["show", ":%d:%s" % (n, path)])
            texts[key] = out if rc == 0 else None
        else:
            texts[key] = None
    wp = safe_path(path)
    working = None
    if wp.is_file():
        working = wp.read_text(encoding="utf-8",
                               errors="replace")
    return {"path": path, "stages": sorted(stages),
            "base": texts["base"], "ours": texts["ours"],
            "theirs": texts["theirs"], "working": working}


def git_conflict_resolve(path, content):
    """Write the resolved content and stage it (git
    add). Returns how many conflicted files remain, so
    the panel can say when the operation is ready to
    commit. Nothing here commits or continues: that
    stays the user's step."""
    p = safe_path(path)
    p.write_text(content, encoding="utf-8")
    rc, out, err, _ = git_out(["add", "--", path])
    if rc != 0:
        raise ValueError(err.strip()[:300]
                         or "git add failed")
    return {"ok": True,
            "remaining": len(git_conflict_paths()),
            "mergeState": git_merge_state()}


# ---------------- GhostMCP client (v2.44) ----------------
def mcp_config_path():
    """Workspace .mcp.json / mcp.json first, then the user's
    ~/.ghostide/mcp.json (desktop only by nature)."""
    for cand in (WORKSPACE / ".mcp.json", WORKSPACE / "mcp.json",
                 DATA_DIR / "mcp.json"):
        if cand.is_file():
            return cand
    return None


def _mcp_cli_oneshot(args, timeout=50):
    cfg = mcp_active_config_path()
    if cfg is None:
        raise ValueError("no MCP config found - add a "
                         ".mcp.json to the workspace")
    rc, text = _eco_cli("ghostmcp",
                        args + ["--config", str(cfg)],
                        WORKSPACE, timeout=timeout)
    obj = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
            except ValueError:
                pass
    if obj is None:
        raise ValueError("GhostMCP could not run: "
                         + text.strip()[:300])
    if obj.get("error"):
        raise ValueError(str(obj["error"]))
    return obj


class _McpDaemon:
    """Cycle 2 I1: one persistent GhostMCP serve process
    per config; it keeps a handshaken session per server,
    so lists and calls stop paying a process spawn each.
    Any failure drops back to the one-shot CLI."""

    def __init__(self):
        self.proc = None
        self.cfg = None
        self.lock = _threading.Lock()
        self._lines = None
        self._next = 0
        self._dead_until = 0.0

    def _stop(self):
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
            self._lines = None

    def _start(self, cfg):
        src = eco_src_dir("ghostmcp")
        if src is None:
            raise ValueError("ghostmcp source not found")
        env = dict(os.environ)
        env["PYTHONPATH"] = str(src)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "ghostmcp", "serve",
             "--config", str(cfg)],
            cwd=str(WORKSPACE), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True)
        self.cfg = str(cfg)
        lines = _queue.Queue()
        self._lines = lines
        proc = self.proc

        def pump():
            try:
                for line in proc.stdout:
                    lines.put(line)
            except Exception:
                pass
            lines.put(None)

        t = _threading.Thread(target=pump, daemon=True)
        t.start()

    def request(self, req, timeout=50):
        import time as _time
        with self.lock:
            cfg = mcp_active_config_path()
            if cfg is None:
                raise ValueError("no MCP config found - add "
                                 "a .mcp.json to the workspace")
            if _time.time() < self._dead_until:
                raise ValueError("daemon cooling down")
            if self.proc is None or self.cfg != str(cfg) \
                    or self.proc.poll() is not None:
                self._stop()
                self._start(cfg)
            self._next += 1
            rid = self._next
            req = dict(req)
            req["id"] = rid
            req.setdefault("timeout", timeout)
            try:
                self.proc.stdin.write(json.dumps(req) + "\n")
                self.proc.stdin.flush()
            except (OSError, ValueError):
                self._stop()
                self._dead_until = _time.time() + 30
                raise ValueError("MCP daemon went away")
            while True:
                try:
                    line = self._lines.get(timeout=timeout + 10)
                except Exception:
                    self._stop()
                    self._dead_until = _time.time() + 30
                    raise ValueError("MCP daemon stopped "
                                     "answering")
                if line is None:
                    self._stop()
                    self._dead_until = _time.time() + 30
                    raise ValueError("MCP daemon exited")
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if obj.get("id") == rid:
                    if obj.get("error"):
                        raise ValueError(str(obj["error"]))
                    obj.pop("id", None)
                    return obj


_MCP_DAEMON = _McpDaemon()


def _mcp_cli(args, timeout=50):
    """Translate the CLI-shaped call onto the daemon;
    fall back to the one-shot CLI on any daemon failure
    (the reply shapes are identical by construction)."""
    verb = args[0] if args else ""
    opts = {}
    i = 1
    while i < len(args):
        if args[i].startswith("--") and i + 1 < len(args):
            opts[args[i][2:]] = args[i + 1]
            i += 2
        else:
            i += 1
    req = None
    if verb == "servers":
        req = {"verb": "servers"}
    elif verb in ("tools", "resources", "prompts"):
        req = {"verb": verb, "server": opts.get("server")}
    elif verb == "call":
        try:
            parsed = json.loads(opts.get("args") or "{}")
        except ValueError:
            parsed = {}
        req = {"verb": "call", "server": opts.get("server"),
               "tool": opts.get("tool"), "args": parsed}
    elif verb == "resource":
        req = {"verb": "resource", "server": opts.get("server"),
               "uri": opts.get("uri")}
    elif verb == "prompt":
        try:
            parsed = json.loads(opts.get("args") or "{}")
        except ValueError:
            parsed = {}
        req = {"verb": "prompt", "server": opts.get("server"),
               "name": opts.get("name"), "args": parsed}
    if req is None:
        return _mcp_cli_oneshot(args, timeout=timeout)
    try:
        return _MCP_DAEMON.request(req, timeout=timeout)
    except ValueError as e:
        if "no MCP config" in str(e):
            raise
        return _mcp_cli_oneshot(args, timeout=timeout)


def mcp_servers():
    cfg = mcp_config_path()
    if cfg is None:
        return {"config": None, "servers": []}
    out = _mcp_cli(["servers"])
    out["config"] = str(cfg)
    return out


# I17: MCP list results (tools/resources/prompts are
# near-static per server) are cached for 5 minutes, keyed
# by the config file's mtime so a config edit invalidates
# immediately. Calls, resource reads and prompt gets
# always execute live - the cache removes re-handshakes
# for browsing and agent priming, never for acting.
_MCP_LIST_CACHE = {}
_MCP_LIST_TTL = 300


def _mcp_list_cached(verb, server, argv):
    cfg = mcp_active_config_path()
    try:
        mt = cfg.stat().st_mtime if cfg else 0
    except OSError:
        mt = 0
    key = (str(cfg), verb, server)
    hit = _MCP_LIST_CACHE.get(key)
    if (hit and hit[0] == mt
            and time.time() - hit[1] < _MCP_LIST_TTL):
        return hit[2]
    obj = _mcp_cli(argv)
    _MCP_LIST_CACHE[key] = (mt, time.time(), obj)
    return obj


def mcp_tools(server):
    out = _mcp_list_cached(
        "tools", server, ["tools", "--server", server])
    # D8: every tool carries the workspace policy the
    # panel renders and the agent briefing honors.
    if isinstance(out, dict):
        out = dict(out)
        out["server_enabled"] = mcp_server_enabled(server)
        tools = []
        for t in out.get("tools") or []:
            if isinstance(t, dict):
                t = dict(t)
                setting = mcp_tool_setting(
                    server, str(t.get("name") or ""))
                t["enabled"] = setting["enabled"]
                t["approval"] = setting["approval"]
            tools.append(t)
        out["tools"] = tools
    return out


def mcp_call(server, tool, arguments):
    # D8: the policy is enforced HERE, server-side, so
    # the panel, the agent loop and the approve queue all
    # hit the same refusal for a disabled server or tool.
    if not mcp_server_enabled(server):
        raise ValueError(
            "MCP server '%s' is disabled in this workspace"
            % server)
    if not mcp_tool_setting(server, tool)["enabled"]:
        raise ValueError(
            "MCP tool '%s' on server '%s' is disabled in "
            "this workspace" % (tool, server))
    return _mcp_cli(["call", "--server", server,
                     "--tool", tool,
                     "--args", json.dumps(arguments or {})])


def mcp_resources(server):
    return _mcp_list_cached(
        "resources", server,
        ["resources", "--server", server])


def mcp_resource(server, uri):
    return _mcp_cli(["resource", "--server", server,
                     "--uri", uri])


def mcp_prompts(server):
    return _mcp_list_cached(
        "prompts", server,
        ["prompts", "--server", server])


def mcp_prompt(server, name, arguments):
    if not mcp_server_enabled(server):
        raise ValueError(
            "MCP server '%s' is disabled in this workspace"
            % server)
    return _mcp_cli(["prompt", "--server", server,
                     "--name", name,
                     "--args", json.dumps(arguments or {})])


# ---------------- MCP polish (Desktop Cycle 2, D8) -------
# Per-tool control, HTTP auth (static headers + OAuth) and
# managed config, layered over the GhostMCP client above.
#
# Storage, chosen to match what already exists:
# - per-tool policy (enabled + approval mode) is a
#   WORKSPACE setting: <workspace>/.ghostide/mcp-policy.json
#   {"servers": {name: {"enabled": bool,
#                       "tools": {tool: {"enabled": bool,
#                                        "approval":
#                                          "ask"|"allow"}}}}}
# - static HTTP headers (credentials) NEVER live in a
#   workspace or config file: they are split out into
#   DATA_DIR/mcp-secrets.json (app data, portable-aware,
#   mode 0600), keyed by server name, and merged into the
#   config copy GhostMCP actually reads (the "effective
#   config" below). No route ever returns a header value,
#   only header names - the env names-not-values rule.
# - OAuth tokens live in DATA_DIR/mcp-oauth.json (0600).
#   OAuth itself runs entirely here in the IDE server;
#   GhostMCP only ever sees the resulting Authorization
#   header in the effective config.
# The policy/config/oauth routes are settings, not
# execution: like POST /api/trust they are host-only
# (loopback), and deliberately NOT in TRUST_EXEC_ROUTES.
# Enforcement of the policy is the opposite: mcp_call
# itself refuses disabled servers/tools server-side, so
# no client path (panel, agent, approve queue) can call
# a tool the user turned off.

def _mcp_write_json(path, obj, secret=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (".%s.tmp-%d" % (path.name,
                                        os.getpid()))
    try:
        tmp.write_text(json.dumps(obj, indent=1))
        if secret:
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _mcp_read_json(path, default):
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
    return obj if isinstance(obj, type(default)) else default


# -- per-tool policy --------------------------------------

def mcp_policy_path():
    return WORKSPACE / ".ghostide" / "mcp-policy.json"


def mcp_policy_all():
    raw = _mcp_read_json(mcp_policy_path(), {})
    servers = raw.get("servers")
    return servers if isinstance(servers, dict) else {}


def mcp_server_enabled(server):
    entry = mcp_policy_all().get(server)
    if isinstance(entry, dict) and "enabled" in entry:
        return bool(entry["enabled"])
    return True


def mcp_tool_setting(server, tool):
    """{"enabled": bool, "approval": "ask"|"allow"} with
    the defaults every unconfigured tool gets: enabled,
    and always ask before the agent calls it."""
    out = {"enabled": True, "approval": "ask"}
    entry = mcp_policy_all().get(server)
    if isinstance(entry, dict):
        tools = entry.get("tools")
        if isinstance(tools, dict):
            mine = tools.get(tool)
            if isinstance(mine, dict):
                if "enabled" in mine:
                    out["enabled"] = bool(mine["enabled"])
                if mine.get("approval") in ("ask", "allow"):
                    out["approval"] = mine["approval"]
    return out


def mcp_policy_view():
    """The policy exactly as the panel and the agent read
    it: every configured server with its server-level
    switch and per-tool settings (defaults filled in)."""
    servers = {}
    for name, entry in mcp_policy_all().items():
        if not isinstance(entry, dict):
            continue
        tools = {}
        raw_tools = entry.get("tools")
        if isinstance(raw_tools, dict):
            for tool, mine in raw_tools.items():
                if isinstance(mine, dict):
                    tools[tool] = {
                        "enabled": bool(mine.get(
                            "enabled", True)),
                        "approval": mine.get("approval")
                        if mine.get("approval") in
                        ("ask", "allow") else "ask"}
        servers[name] = {
            "enabled": bool(entry.get("enabled", True)),
            "tools": tools}
    return {"servers": servers}


def mcp_policy_set(data):
    server = str(data.get("server") or "").strip()
    if not server:
        raise ValueError("a policy change needs a server name")
    all_policy = mcp_policy_all()
    entry = all_policy.get(server)
    if not isinstance(entry, dict):
        entry = {}
    if "server_enabled" in data:
        entry["enabled"] = bool(data["server_enabled"])
    tool = str(data.get("tool") or "").strip()
    if tool:
        tools = entry.get("tools")
        if not isinstance(tools, dict):
            tools = {}
        mine = tools.get(tool)
        if not isinstance(mine, dict):
            mine = {}
        if "enabled" in data:
            mine["enabled"] = bool(data["enabled"])
        if "approval" in data:
            if data["approval"] not in ("ask", "allow"):
                raise ValueError(
                    "approval must be \"ask\" or \"allow\"")
            mine["approval"] = data["approval"]
        tools[tool] = mine
        entry["tools"] = tools
    all_policy[server] = entry
    _mcp_write_json(mcp_policy_path(),
                    {"servers": all_policy})
    return mcp_policy_view()


# -- secrets + OAuth token stores -------------------------

def mcp_secrets_path():
    return DATA_DIR / "mcp-secrets.json"


def mcp_secrets_all():
    raw = _mcp_read_json(mcp_secrets_path(), {})
    return raw if isinstance(raw, dict) else {}


def mcp_secret_headers(server):
    mine = mcp_secrets_all().get(server)
    if isinstance(mine, dict):
        headers = mine.get("headers")
        if isinstance(headers, dict):
            return {str(k): str(v)
                    for k, v in headers.items()}
    return {}


def mcp_oauth_path():
    return DATA_DIR / "mcp-oauth.json"


def mcp_oauth_all():
    raw = _mcp_read_json(mcp_oauth_path(), {})
    return raw if isinstance(raw, dict) else {}


# -- the effective config ---------------------------------
# GhostMCP reads one config file. When the user has stored
# headers or OAuth tokens, the IDE writes a merged copy
# into app data and points GhostMCP at that instead, so
# credentials never touch the workspace config on disk.
_MCP_EFFECTIVE = {"key": None, "path": None}


def mcp_raw_config():
    """(path, parsed mcpServers mapping) of the ACTIVE
    config (workspace first, then the user config), or
    (None, {}) when there is none."""
    cfg = mcp_config_path()
    if cfg is None:
        return None, {}
    data = _mcp_read_json(cfg, {})
    servers = data.get("mcpServers")
    return cfg, servers if isinstance(servers, dict) else {}


def mcp_active_config_path():
    """The config file GhostMCP should read right now:
    the effective (merged) copy when secrets or OAuth
    tokens apply, else the active config itself."""
    cfg, servers = mcp_raw_config()
    if cfg is None:
        return None
    secrets = mcp_secrets_all()
    oauth = mcp_oauth_all()
    applies = any(name in secrets or name in oauth
                  for name in servers)
    if not applies:
        return cfg
    try:
        key = (cfg.stat().st_mtime,
               mcp_secrets_path().stat().st_mtime
               if mcp_secrets_path().is_file() else 0,
               mcp_oauth_path().stat().st_mtime
               if mcp_oauth_path().is_file() else 0)
    except OSError:
        key = None
    stale = False
    for name in servers:
        rec = oauth.get(name)
        if isinstance(rec, dict) and rec.get("expires_at") \
                and float(rec["expires_at"]) < \
                time.time() + 120:
            stale = True  # rebuild so the token refreshes
    if not stale and _MCP_EFFECTIVE["key"] == key and \
            _MCP_EFFECTIVE["path"] is not None:
        return _MCP_EFFECTIVE["path"]
    merged = {}
    for name, entry in servers.items():
        if isinstance(entry, dict):
            entry = dict(entry)
            headers = {}
            raw_h = entry.get("headers")
            if isinstance(raw_h, dict):
                headers.update({str(k): str(v)
                                for k, v in raw_h.items()})
            headers.update(mcp_secret_headers(name))
            if mcp_entry_is_oauth(entry):
                token = mcp_oauth_token_for(name, entry)
                if token:
                    headers["Authorization"] = \
                        "Bearer " + token
            if headers:
                entry["headers"] = headers
        merged[name] = entry
    out = DATA_DIR / "mcp-effective.json"
    _mcp_write_json(out, {"mcpServers": merged},
                    secret=True)
    _MCP_EFFECTIVE["key"] = key
    _MCP_EFFECTIVE["path"] = out
    return out


def _mcp_drop_session(server):
    try:
        _MCP_DAEMON.request({"verb": "drop",
                             "server": server}, timeout=5)
    except Exception:
        pass


# -- managed config (the user config in app data) --------

def mcp_user_config_path():
    return DATA_DIR / "mcp.json"


def mcp_entry_is_oauth(entry):
    return bool(entry.get("oauth")) or \
        entry.get("auth") == "oauth"


def mcp_validate_entry(name, entry):
    """A list of human-readable problems with one
    mcpServers entry (empty list = valid). Shared by the
    add/edit form and paste-import, so both reject the
    same shapes."""
    errs = []
    if not name or not all(
            c.isalnum() or c in "-_." for c in name):
        errs.append("server name must be letters, digits, "
                    "-, _ or .")
    if not isinstance(entry, dict):
        return errs + ["entry must be a JSON object"]
    command = entry.get("command")
    url = entry.get("url")
    if command and url:
        errs.append("give either a command (stdio) or a "
                    "url (http), not both")
    if not command and not url:
        errs.append("needs a command (stdio) or a url (http)")
    if command and not isinstance(command, str):
        errs.append("command must be a string")
    if url and not isinstance(url, str):
        errs.append("url must be a string")
    args = entry.get("args")
    if args is not None and (
            not isinstance(args, list)
            or not all(isinstance(a, str) for a in args)):
        errs.append("args must be a list of strings")
    for key in ("env", "headers"):
        val = entry.get(key)
        if val is not None and (
                not isinstance(val, dict) or not all(
                    isinstance(k, str) and
                    isinstance(v, str)
                    for k, v in val.items())):
            errs.append(key + " must be an object of "
                        "string values")
    return errs


def mcp_redacted_servers(servers, secrets):
    """Config entries as the client may see them: env and
    header VALUES never leave the server, only names."""
    out = []
    for name in sorted(servers):
        entry = servers[name]
        if not isinstance(entry, dict):
            continue
        transport, target = "stdio", ""
        if entry.get("url"):
            transport, target = "http", str(entry["url"])
        elif entry.get("command"):
            target = " ".join(
                [str(entry["command"])] +
                [str(a) for a in (entry.get("args") or [])])
        env = entry.get("env") or {}
        headers = {}
        raw_h = entry.get("headers")
        if isinstance(raw_h, dict):
            headers.update(raw_h)
        headers.update(mcp_secret_headers(name))
        out.append({
            "name": name, "transport": transport,
            "target": target,
            "env_names": sorted(env) if isinstance(
                env, dict) else [],
            "header_names": sorted(headers),
            "oauth": mcp_entry_is_oauth(entry),
            "label": "Remote server" if transport == "http"
                     else "Runs commands on this computer"})
    return out


def mcp_config_view():
    active, _ = mcp_raw_config()
    user_path = mcp_user_config_path()
    user = _mcp_read_json(user_path, {})
    user_servers = user.get("mcpServers")
    if not isinstance(user_servers, dict):
        user_servers = {}
    secrets = mcp_secrets_all()
    return {
        "active_config": str(active) if active else None,
        "active_is_user": bool(active) and
        str(active) == str(user_path),
        "user_config": str(user_path),
        "servers": mcp_redacted_servers(user_servers,
                                        secrets)}


def _mcp_split_headers(entry):
    """Copy of an entry with any headers removed; the
    headers themselves (returned separately) belong in
    the secrets store, never in a config file."""
    entry = dict(entry)
    headers = entry.pop("headers", None)
    if isinstance(headers, dict):
        return entry, {str(k): str(v)
                       for k, v in headers.items()}
    return entry, {}


def mcp_save_user_server(name, entry):
    errs = mcp_validate_entry(name, entry)
    if errs:
        raise ValueError("; ".join(errs))
    entry, headers = _mcp_split_headers(entry)
    user = _mcp_read_json(mcp_user_config_path(), {})
    servers = user.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    servers[name] = entry
    user["mcpServers"] = servers
    _mcp_write_json(mcp_user_config_path(), user)
    secrets = mcp_secrets_all()
    if headers:
        secrets[name] = {"headers": headers}
    else:
        secrets.pop(name, None)
    _mcp_write_json(mcp_secrets_path(), secrets,
                    secret=True)
    _mcp_drop_session(name)
    return mcp_config_view()


def mcp_delete_user_server(name):
    user = _mcp_read_json(mcp_user_config_path(), {})
    servers = user.get("mcpServers")
    if isinstance(servers, dict):
        servers.pop(name, None)
        user["mcpServers"] = servers
        _mcp_write_json(mcp_user_config_path(), user)
    secrets = mcp_secrets_all()
    if name in secrets:
        secrets.pop(name)
        _mcp_write_json(mcp_secrets_path(), secrets,
                        secret=True)
    oauth = mcp_oauth_all()
    if name in oauth:
        oauth.pop(name)
        _mcp_write_json(mcp_oauth_path(), oauth,
                        secret=True)
    _mcp_drop_session(name)
    return mcp_config_view()


def mcp_import_config(text):
    """Paste-import of an mcpServers-style config (the
    Claude / Cursor shape). Valid entries merge into the
    USER config; invalid ones are reported by name with
    their problems - nothing fails silently."""
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ValueError("that was not valid JSON: %s" % e)
    if not isinstance(data, dict):
        raise ValueError("the config must be a JSON object")
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        if all(isinstance(v, dict) for v in data.values()):
            servers = data  # a bare name -> entry mapping
        else:
            raise ValueError(
                'no "mcpServers" object in that config')
    imported, errors = [], {}
    for name, entry in servers.items():
        errs = mcp_validate_entry(str(name), entry)
        if errs:
            errors[str(name)] = "; ".join(errs)
            continue
        mcp_save_user_server(str(name), entry)
        imported.append(str(name))
    return {"imported": imported, "errors": errors,
            "config": mcp_config_view()}


# -- curated catalog --------------------------------------
# Only servers whose run commands are stated accurately:
# the official reference servers on npm (run with npx)
# and PyPI (run with uvx), plus GitHub's hosted server.
# "{workspace}" in an arg is replaced with the open
# workspace path when the catalog is served.
MCP_CATALOG = [
    {"id": "filesystem", "name": "Filesystem",
     "blurb": "Read and write files under one folder "
              "(the open workspace).",
     "runtime": "Node.js (npx)",
     "entry": {"command": "npx",
               "args": ["-y",
                        "@modelcontextprotocol/server-filesystem",
                        "{workspace}"]}},
    {"id": "memory", "name": "Memory",
     "blurb": "A persistent knowledge graph the agent "
              "can read and update.",
     "runtime": "Node.js (npx)",
     "entry": {"command": "npx",
               "args": ["-y",
                        "@modelcontextprotocol/server-memory"]}},
    {"id": "fetch", "name": "Fetch",
     "blurb": "Fetch web pages and convert them to "
              "markdown for the agent.",
     "runtime": "Python (uvx)",
     "entry": {"command": "uvx",
               "args": ["mcp-server-fetch"]}},
    {"id": "sqlite", "name": "SQLite",
     "blurb": "Query and update a SQLite database file "
              "in the workspace.",
     "runtime": "Python (uvx)",
     "entry": {"command": "uvx",
               "args": ["mcp-server-sqlite", "--db-path",
                        "{workspace}/mcp-catalog.db"]}},
    {"id": "github", "name": "GitHub (hosted)",
     "blurb": "GitHub's official remote MCP server. "
              "Needs a personal access token: after "
              "adding, set the Authorization header to "
              "\"Bearer \" plus your token.",
     "runtime": "none (remote)",
     "entry": {"url": "https://api.githubcopilot.com/mcp/"}},
]


def mcp_catalog():
    out = []
    for item in MCP_CATALOG:
        entry = json.loads(json.dumps(item["entry"]))
        if "args" in entry:
            entry["args"] = [
                a.replace("{workspace}", str(WORKSPACE))
                for a in entry["args"]]
        out.append({"id": item["id"], "name": item["name"],
                    "blurb": item["blurb"],
                    "runtime": item["runtime"],
                    "entry": entry,
                    "label": "Remote server"
                    if "url" in entry else
                    "Runs commands on this computer"})
    return {"catalog": out}


# -- OAuth 2.0 (authorization code + PKCE) ----------------
# The flow lives entirely in this server: discovery via
# the resource's well-known metadata, dynamic client
# registration when the provider offers it, a PKCE
# authorize redirect the user approves in their browser,
# and a loopback callback route on this very server.
# Tokens are stored in app data; refresh is automatic
# when the effective config is rebuilt. A server whose
# provider offers no registration endpoint cannot be
# connected this way and says so plainly.
_MCP_OAUTH_PENDING = {}


def _oauth_fetch_json(url, data=None, form=False,
                      timeout=15):
    body = None
    headers = {"Accept": "application/json"}
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = \
                "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body,
                                 headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def mcp_oauth_metadata(entry):
    url = str(entry.get("url") or "")
    parsed = urllib.parse.urlparse(url)
    if not parsed.netloc:
        raise ValueError("OAuth needs an http server url")
    origin = "%s://%s" % (parsed.scheme, parsed.netloc)
    resource = url
    issuer = origin
    try:
        prm = _oauth_fetch_json(
            origin + "/.well-known/oauth-protected-resource")
        if isinstance(prm, dict):
            resource = str(prm.get("resource") or url)
            auth_servers = prm.get("authorization_servers")
            if isinstance(auth_servers, list) and \
                    auth_servers:
                issuer = str(auth_servers[0]).rstrip("/")
    except Exception:
        pass  # fall back to the origin as its own issuer
    meta = None
    for suffix in ("/.well-known/oauth-authorization-server",
                   "/.well-known/openid-configuration"):
        try:
            got = _oauth_fetch_json(issuer + suffix)
            if isinstance(got, dict) and \
                    got.get("authorization_endpoint") and \
                    got.get("token_endpoint"):
                meta = got
                break
        except Exception:
            continue
    if meta is None:
        raise ValueError(
            "no OAuth metadata found at %s - this server "
            "may not support OAuth sign-in" % issuer)
    return {"issuer": issuer, "resource": resource,
            "authorization_endpoint":
                str(meta["authorization_endpoint"]),
            "token_endpoint": str(meta["token_endpoint"]),
            "registration_endpoint":
                str(meta.get("registration_endpoint") or "")}


def mcp_oauth_redirect_uri():
    return "http://127.0.0.1:%d/api/mcp/oauth/callback" \
        % PORT


def mcp_oauth_start(server):
    _, servers = mcp_raw_config()
    entry = servers.get(server)
    if not isinstance(entry, dict) or not entry.get("url"):
        raise ValueError(
            "server '%s' is not an http server in the "
            "config" % server)
    meta = mcp_oauth_metadata(entry)
    store = mcp_oauth_all()
    rec = store.get(server)
    if not isinstance(rec, dict):
        rec = {}
    client_id = rec.get("client_id")
    if not client_id:
        if not meta["registration_endpoint"]:
            raise ValueError(
                "this server does not offer dynamic client "
                "registration, so GhostIDE cannot sign in "
                "with OAuth. A static Authorization header "
                "still works.")
        reg = _oauth_fetch_json(
            meta["registration_endpoint"], data={
                "client_name": "GhostIDE",
                "redirect_uris": [mcp_oauth_redirect_uri()],
                "grant_types": ["authorization_code",
                                "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none"})
        client_id = reg.get("client_id")
        if not client_id:
            raise ValueError(
                "client registration returned no client_id")
        rec["client_id"] = client_id
        store[server] = rec
        _mcp_write_json(mcp_oauth_path(), store,
                        secret=True)
    state = _secrets.token_urlsafe(24)
    verifier = _secrets.token_urlsafe(48)
    challenge = _b64.urlsafe_b64encode(
        _hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    _MCP_OAUTH_PENDING[state] = {
        "server": server, "verifier": verifier,
        "token_endpoint": meta["token_endpoint"],
        "client_id": client_id, "resource": meta["resource"],
        "created": time.time()}
    params = {
        "response_type": "code", "client_id": client_id,
        "redirect_uri": mcp_oauth_redirect_uri(),
        "state": state, "code_challenge": challenge,
        "code_challenge_method": "S256",
        "resource": meta["resource"]}
    scope = entry.get("oauth_scope")
    if scope:
        params["scope"] = str(scope)
    return {"auth_url": meta["authorization_endpoint"]
            + "?" + urllib.parse.urlencode(params),
            "server": server}


def mcp_oauth_exchange(state, code):
    pending = _MCP_OAUTH_PENDING.pop(state, None)
    if pending is None:
        raise ValueError(
            "that sign-in link is unknown or expired - "
            "start the connection again from the MCP panel")
    if time.time() - pending["created"] > 600:
        raise ValueError(
            "that sign-in took too long - start again")
    tok = _oauth_fetch_json(
        pending["token_endpoint"], form=True, data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": mcp_oauth_redirect_uri(),
            "client_id": pending["client_id"],
            "code_verifier": pending["verifier"],
            "resource": pending["resource"]})
    access = tok.get("access_token")
    if not access:
        raise ValueError(
            "the token endpoint returned no access token")
    store = mcp_oauth_all()
    rec = store.get(pending["server"])
    if not isinstance(rec, dict):
        rec = {}
    rec.update({
        "client_id": pending["client_id"],
        "access_token": access,
        "refresh_token": tok.get("refresh_token")
        or rec.get("refresh_token"),
        "expires_at": time.time()
        + float(tok.get("expires_in") or 3600),
        "token_endpoint": pending["token_endpoint"],
        "resource": pending["resource"]})
    store[pending["server"]] = rec
    _mcp_write_json(mcp_oauth_path(), store, secret=True)
    _MCP_EFFECTIVE["key"] = None  # force a config rebuild
    _mcp_drop_session(pending["server"])
    return pending["server"]


def mcp_oauth_refresh(server, rec):
    tok = _oauth_fetch_json(
        str(rec.get("token_endpoint") or ""), form=True,
        data={"grant_type": "refresh_token",
              "refresh_token": rec.get("refresh_token"),
              "client_id": rec.get("client_id"),
              "resource": rec.get("resource") or ""})
    access = tok.get("access_token")
    if not access:
        raise ValueError("refresh returned no access token")
    rec = dict(rec)
    rec["access_token"] = access
    if tok.get("refresh_token"):
        rec["refresh_token"] = tok["refresh_token"]
    rec["expires_at"] = time.time() + float(
        tok.get("expires_in") or 3600)
    store = mcp_oauth_all()
    store[server] = rec
    _mcp_write_json(mcp_oauth_path(), store, secret=True)
    return access


def mcp_oauth_token_for(server, entry):
    """The stored access token for a server, refreshing
    when expired; None when there is no usable token."""
    rec = mcp_oauth_all().get(server)
    if not isinstance(rec, dict) or \
            not rec.get("access_token"):
        return None
    if float(rec.get("expires_at") or 0) > \
            time.time() + 60:
        return str(rec["access_token"])
    if rec.get("refresh_token") and \
            rec.get("token_endpoint"):
        try:
            return mcp_oauth_refresh(server, rec)
        except Exception:
            return None
    return None


def mcp_oauth_state(server):
    """"connected" / "needs-auth" for an oauth server,
    judged from the store alone (no network)."""
    rec = mcp_oauth_all().get(server)
    if not isinstance(rec, dict) or \
            not rec.get("access_token"):
        return "needs-auth"
    if float(rec.get("expires_at") or 0) > time.time():
        return "connected"
    return "connected" if rec.get("refresh_token") \
        else "needs-auth"


# -- status ------------------------------------------------

def mcp_status():
    """Per-server honesty for the panel: transport label,
    policy state, auth state, live session, tool count -
    or the error that stopped the count."""
    _, servers = mcp_raw_config()
    live = {}
    try:
        out = _MCP_DAEMON.request({"verb": "sessions"},
                                  timeout=10)
        for s in out.get("sessions") or []:
            live[s.get("server")] = s
    except Exception:
        pass
    rows = []
    described = {}
    try:
        for s in mcp_servers().get("servers") or []:
            described[s.get("name")] = s
    except Exception:
        pass
    for name in sorted(servers):
        entry = servers[name]
        if not isinstance(entry, dict):
            continue
        transport = "http" if entry.get("url") else "stdio"
        row = {
            "name": name, "transport": transport,
            "target": described.get(name, {}).get(
                "target", ""),
            "label": "Remote server" if transport == "http"
                     else "Runs commands on this computer",
            "header_names": described.get(name, {}).get(
                "header_names", []),
            "live": name in live,
            "calls": (live.get(name) or {}).get("calls", 0),
            "tools": None, "error": None}
        if not mcp_server_enabled(name):
            row["status"] = "disabled"
        elif mcp_entry_is_oauth(entry) and \
                mcp_oauth_state(name) == "needs-auth":
            row["status"] = "needs-auth"
        else:
            try:
                tools = mcp_tools(name)
                row["tools"] = len(tools.get("tools") or [])
                row["status"] = "connected"
            except ValueError as e:
                row["status"] = "error"
                row["error"] = str(e)[:300]
        rows.append(row)
    return {"servers": rows}


# ---------------- GhostApprove queue (E10) ----------------
# GhostApprove records decisions and never executes; the
# IDE is the producer that asked, so after a recorded
# approval the IDE itself carries out exactly the queued
# action. Decisions are hash-bound by the tool: the IDE
# reads the exact hash from the record at decide time.
def _approve_store_dir():
    return WORKSPACE / ".ghostide" / "approve-store"


def _approve_parse(text, rc):
    t = (text or "").strip()
    if rc != 0:
        raise ValueError(t[:300] or "GhostApprove failed")
    try:
        return json.loads(t)
    except ValueError:
        raise ValueError("GhostApprove returned unreadable "
                         "output: " + t[:200])


def approve_enqueue(kind, command="", path="", summary="",
                    mcp=None):
    if kind == "run":
        if not command:
            raise ValueError("a run request needs a command")
        action = "Run command: " + command
        payload = {"kind": "run", "command": command}
    elif kind == "mcp":
        # A4 audit fix: agent MCP calls are actions on the
        # outside world, so they queue like RUN/DELETE.
        mcp = mcp or {}
        server = str(mcp.get("server") or "")
        tool = str(mcp.get("tool") or "")
        arguments = mcp.get("arguments") or {}
        if not server or not tool:
            raise ValueError("an MCP request needs a server "
                             "and a tool")
        if not isinstance(arguments, dict):
            raise ValueError("MCP arguments must be an object")
        action = ("Call MCP " + server + "." + tool +
                  " with " + json.dumps(arguments)[:200])
        payload = {"kind": "mcp", "server": server,
                   "tool": tool, "arguments": arguments}
    elif kind == "delete":
        target = safe_path(path)
        if not target.is_file():
            raise ValueError("delete target is not a file in "
                             "the workspace: " + path)
        action = "Delete file: " + path
        payload = {"kind": "delete", "path": path}
    else:
        raise ValueError("unknown queue kind: " + kind)
    req = {
        "action": action,
        "summary": summary or "Raised by the GhostIDE agent.",
        "source": "ghostide-agent",
        "risk": "high",
        "payload": payload,
        "requested_by": "GhostIDE agent",
    }
    inbox = WORKSPACE / ".ghostide" / "approve-inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    fpath = inbox / ("req-%d.json" % int(time.time() * 1000))
    fpath.write_text(json.dumps(req), encoding="utf-8")
    try:
        rc, text = _eco_cli(
            "ghostapprove",
            ["ingest", str(fpath), "--store",
             str(_approve_store_dir()), "--json"], WORKSPACE)
    finally:
        try:
            fpath.unlink()
        except OSError:
            pass
    obj = _approve_parse(text, rc)
    return {"id": obj.get("id"), "hash": obj.get("hash"),
            "status": "pending"}


def approve_list():
    rc, text = _eco_cli(
        "ghostapprove",
        ["list", "--store", str(_approve_store_dir()),
         "--status", "pending", "--json"], WORKSPACE)
    items = _approve_parse(text, rc)
    results = []
    rp = WORKSPACE / ".ghostide" / "approve-results.jsonl"
    if rp.is_file():
        for line in rp.read_text(
                encoding="utf-8", errors="replace") \
                .splitlines()[-15:]:
            try:
                results.append(json.loads(line))
            except ValueError:
                pass
    return {"items": items if isinstance(items, list)
            else [], "results": results}


def approve_decide(req_id, decision):
    if decision not in ("approve", "deny"):
        raise ValueError("decision must be approve or deny")
    if not req_id:
        raise ValueError("no request id")
    rc, text = _eco_cli(
        "ghostapprove",
        ["show", req_id, "--store", str(_approve_store_dir()),
         "--json"], WORKSPACE)
    rec = _approve_parse(text, rc)
    if rec.get("status") != "pending":
        raise ValueError("that request is no longer pending")
    rc, text = _eco_cli(
        "ghostapprove",
        [decision, req_id, "--hash", str(rec.get("hash")),
         "--by", "ghostide-panel", "--store",
         str(_approve_store_dir()), "--json"], WORKSPACE)
    _approve_parse(text, rc)
    result = {"id": req_id, "decision": decision,
              "executed": False, "output": ""}
    if decision == "approve":
        payload = ((rec.get("content") or {})
                   .get("payload") or {})
        kind = payload.get("kind")
        if kind == "run":
            r = _term_run(str(payload.get("command") or ""))
            result["executed"] = True
            result["code"] = r["code"]
            result["output"] = ((r["stdout"] or "")
                                + (r["stderr"] or ""))[-2000:]
        elif kind == "delete":
            target = safe_path(str(payload.get("path") or ""))
            if target.is_file():
                target.unlink()
                result["executed"] = True
                result["output"] = ("Deleted "
                                    + str(payload.get("path")))
            else:
                result["output"] = ("The file no longer "
                                    "exists - nothing was "
                                    "deleted.")
        elif kind == "mcp":
            try:
                r = mcp_call(str(payload.get("server") or ""),
                             str(payload.get("tool") or ""),
                             payload.get("arguments") or {})
                result["executed"] = True
                result["output"] = (
                    ("MCP error: " if r.get("isError")
                     else "MCP result: ")
                    + str(r.get("text") or ""))[-2000:]
            except ValueError as e:
                result["output"] = ("The approved MCP call "
                                    "could not run: " + str(e))
        else:
            result["output"] = ("Unknown payload kind - "
                                "nothing was executed.")
    rp = WORKSPACE / ".ghostide" / "approve-results.jsonl"
    rp.parent.mkdir(parents=True, exist_ok=True)
    with rp.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(
            {"ts": int(time.time()), "id": req_id,
             "decision": decision,
             "executed": result["executed"],
             "output": result["output"][:500]}) + "\n")
    return result


def approve_audit():
    rc, text = _eco_cli(
        "ghostapprove",
        ["verify", "--store", str(_approve_store_dir())],
        WORKSPACE)
    if rc != 0:
        raise ValueError((text or "").strip()[:300])
    return {"output": (text or "").strip()[:4000]}


# ---------------- GhostWorktree (E15) ----------------
def git_worktrees():
    rc, out, err, _ms = git_out(["worktree", "list",
                                 "--porcelain"])
    if rc != 0:
        raise ValueError("git worktree list failed: "
                         + (err or "").strip()[:200])
    trees = []
    cur = None
    for line in (out or "").splitlines():
        if line.startswith("worktree "):
            cur = {"path": line[9:].strip(), "branch": "",
                   "head": ""}
            trees.append(cur)
        elif cur is not None and line.startswith("HEAD "):
            cur["head"] = line[5:].strip()[:12]
        elif cur is not None and line.startswith("branch "):
            cur["branch"] = line[7:].strip().replace(
                "refs/heads/", "")
        elif cur is not None and line.strip() == "detached":
            cur["branch"] = "(detached)"
    return {"worktrees": trees}


def git_worktree_add(name, branch=""):
    if not _re_mod.fullmatch(r"[A-Za-z0-9._-]+", name or "") \
            or name in (".", ".."):
        raise ValueError("worktree name may use letters, "
                         "digits, dot, dash and underscore")
    dest = WORKSPACE.parent / (WORKSPACE.name + "-" + name)
    if dest.exists():
        raise ValueError("that worktree path already "
                         "exists: " + str(dest))
    args = ["worktree", "add"]
    if branch:
        if not _re_mod.fullmatch(r"[A-Za-z0-9._/-]+", branch):
            raise ValueError("branch name has unsupported "
                             "characters")
        args += ["-b", branch]
    args.append(str(dest))
    rc, out, err, _ms = git_out(args)
    if rc != 0:
        raise ValueError("git worktree add failed: "
                         + (err or out or "").strip()[:300])
    return {"path": str(dest)}


def git_worktree_remove(path):
    trees = git_worktrees()["worktrees"]
    known = [t["path"] for t in trees]
    if path not in known:
        raise ValueError("that path is not a worktree of "
                         "this repo")
    if Path(path) == WORKSPACE:
        raise ValueError("the main workspace cannot be "
                         "removed")
    rc, out, err, _ms = git_out(["worktree", "remove", path])
    if rc != 0:
        raise ValueError("git worktree remove failed: "
                         + (err or out or "").strip()[:300])
    return {"ok": True}


# ---------------- REA bridge (Waves 1+3) ----------------
import datetime as _rea_dt

# GhostIDE does not ship REA (Ryan's internal-use rule stands);
# on the desktop it drives a locally installed REA CLI the way
# it drives a locally installed formatter: detect, run an
# allowlisted read-only command, save the full Evidence JSON
# under .ghostide/rea/, and hand the panel a compact summary.
# Provider engines (Ghidra, JADX, Rizin, ...) are REA's own
# installs; the status route surfaces `rea doctor` verbatim
# lines for the known providers so the panel can show what is
# actually available instead of guessing.
REA_COMMANDS = {
    "inspect-artifact", "inspect-byte-entropy",
    "inspect-binary-layout", "analyze-javascript-application",
    "inspect-android-package", "inspect-apk-signature",
    "inspect-sqlite-database", "inspect-python-pyc",
    "inspect-wasm-artifact", "inspect-macho",
    "inspect-pe-imports", "inspect-elf-notes",
    "inspect-go-binary", "inspect-rust-binary",
    "inspect-managed-artifact", "inspect-plist",
    "decompile",
}
REA_PROVIDERS = ["hopper", "ghidra", "ida-registration", "jadx",
                 "kuna-installation"]


def rea_path():
    env = os.environ.get("REA_PATH")
    if env and Path(env).is_file():
        return env
    found = shutil.which("rea")
    if found:
        return found
    for cand in ("/usr/bin/rea", "/usr/local/bin/rea",
                 str(Path.home() / ".local/bin/rea")):
        if Path(cand).is_file():
            return cand
    return None


def rea_env():
    """Environment for REA subprocesses. Starts from the
    server's own environment and fills in the Wave 3 engine
    installs under ~/workspace/re-engines/ when they exist
    and the variables are not already set, so the desktop
    server does not have to be launched from a shell that
    sourced re-engines/env.sh for the providers to light up."""
    env = dict(os.environ)
    re_root = Path.home() / "workspace" / "re-engines"
    ghidra = re_root / "ghidra_12.1.4_PUBLIC"
    if "GHIDRA_INSTALL_DIR" not in env and ghidra.is_dir():
        env["GHIDRA_INSTALL_DIR"] = str(ghidra)
    jadx_jar = re_root / "jadx" / "jadx-headless-mcp-0.7.1-all.jar"
    if "REA_JADX_MCP_JAR" not in env and jadx_jar.is_file():
        env["REA_JADX_MCP_JAR"] = str(jadx_jar)
    jdk = re_root / "jdk-21.0.13+9"
    if jdk.is_dir():
        if "JAVA_HOME" not in env:
            env["JAVA_HOME"] = str(jdk)
        extra = [str(jdk / "bin"), str(re_root / "rizin" / "bin"),
                 str(re_root / "bin"),
                 str(re_root / "frida-venv" / "bin")]
        have = env.get("PATH", "")
        env["PATH"] = ":".join(
            [p for p in extra if Path(p).is_dir()]
            + ([have] if have else []))
    return env


def rea_status():
    rp = rea_path()
    if not rp:
        return {"found": False,
                "hint": "REA is not installed on this machine. "
                        "GhostRE (built in) still works below. "
                        "To add REA itself: npm install -g "
                        "rea-agents, then reopen this panel."}
    version = ""
    try:
        r = subprocess.run([rp, "--version"], capture_output=True,
                           text=True, timeout=20, env=rea_env())
        version = (r.stdout or "").strip().splitlines()[0] \
            if r.stdout.strip() else ""
    except Exception:
        version = ""
    providers = {}
    healthy = None
    try:
        r = subprocess.run([rp, "doctor"], capture_output=True,
                           text=True, timeout=60, env=rea_env())
        text = (r.stdout or "") + (r.stderr or "")
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("healthy:"):
                healthy = s.split(":", 1)[1].strip() == "true"
        for name in REA_PROVIDERS:
            providers[name] = None
            # doctor prints "- name: <provider>" blocks, each
            # followed by an "ok: true/false" line.
            idx = text.find("name: " + name)
            if idx >= 0:
                seg = text[idx:idx + 400]
                for ln in seg.splitlines():
                    ls = ln.strip()
                    if ls.startswith("ok:"):
                        providers[name] = \
                            ls.split(":", 1)[1].strip() == "true"
                        break
    except Exception:
        pass
    return {"found": True, "path": rp, "version": version,
            "healthy": healthy, "providers": providers}


def rea_run(command, rel, ws):
    if command not in REA_COMMANDS:
        raise ValueError("that REA command is not in the "
                         "bridge allowlist (read-only analysis "
                         "only; live capture, debugging and "
                         "instrumentation stay out of the IDE)")
    rp = rea_path()
    if not rp:
        raise ValueError("REA is not installed on this machine")
    target = safe_path(rel)
    if target is None or not target.exists():
        raise ValueError("target not found in the workspace: "
                         + str(rel))
    out_dir = ws / ".ghostide" / "rea"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        r = subprocess.run(
            [rp, command, str(target), "--format", "json"],
            cwd=str(ws), capture_output=True, text=True,
            timeout=180, env=rea_env())
    except subprocess.TimeoutExpired:
        raise ValueError("REA ran past 180 seconds and was "
                         "stopped")
    raw = (r.stdout or "").strip()
    if not raw:
        raise ValueError("REA produced no output: "
                         + (r.stderr or "").strip()[:300])
    stamp = _rea_dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = target.name.replace("/", "_") or "target"
    ev_name = "%s-%s-%s.json" % (stamp, command, base)
    (out_dir / ev_name).write_text(raw, encoding="utf-8")
    summary = {}
    try:
        doc = json.loads(raw)
        subj = doc.get("subject") or {}
        prov = doc.get("provider") or {}
        summary = {
            "evidence_id": doc.get("evidence_id"),
            "operation": doc.get("operation"),
            "format": subj.get("format"),
            "name": subj.get("name"),
            "sha256": (subj.get("digest") or {}).get("sha256"),
            "provider": prov.get("name"),
            "error": doc.get("message") if doc.get("code") else None,
        }
    except Exception:
        summary = {"error": "REA output was not JSON"}
    return {"ok": True, "command": command, "path": rel,
            "evidenceFile": ".ghostide/rea/" + ev_name,
            "summary": summary,
            "output": raw[:12000]}


def ghostre_run(rel, ws):
    """Wave 2: run the Ghost-native GhostRE inspector (eco
    tool, stdlib Python) on one workspace target and return
    its JSON report text."""
    src = eco_src_dir("ghostre")
    if src is None:
        raise ValueError(
            "GhostRE source not found - place ghostre in "
            "~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    target = safe_path(rel)
    if target is None or not target.exists():
        raise ValueError("target not found in the workspace: "
                         + str(rel))
    env = dict(os.environ)
    env["PYTHONPATH"] = str(src)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        r = subprocess.run(
            [sys.executable, "-m", "ghostre", "inspect",
             str(target)],
            cwd=str(ws), env=env, capture_output=True,
            text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise ValueError("GhostRE ran past 120 seconds and was "
                         "stopped")
    text = (r.stdout or "").strip()
    if r.returncode != 0 or not text:
        raise ValueError("GhostRE could not inspect that "
                         "target: " + ((r.stderr or "")
                                        .strip()[:300] or
                                        "no output"))
    try:
        return json.dumps(json.loads(text), indent=1)[:60000]
    except Exception:
        return text[:60000]


def eco_search(query, ws, limit=10, max_tokens=2000):
    """Roadmap ECO E3: indexed search. (Re)builds the workspace
    FTS5 index with the GhostIndex tool itself, then runs the
    tool's own search and returns its JSON untouched, so the
    panel's excerpts are the CLI's excerpts. Exit 1 from the
    search is a normal "no matches" (its JSON still parses);
    exit 2 is "could not run"."""
    src = eco_src_dir("ghostindex")
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    query = (query or "").strip()
    if not query:
        raise ValueError("type something to search for")
    try:
        limit = max(1, min(int(limit or 10), 50))
    except (TypeError, ValueError):
        limit = 10
    try:
        max_tokens = max(200, min(int(max_tokens or 2000), 20000))
    except (TypeError, ValueError):
        max_tokens = 2000
    db = ws / ".ghostide" / "ghostindex.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["PYTHONPATH"] = str(src)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["GHOSTINDEX_DB"] = str(db)

    def run(args, ok_codes):
        try:
            r = subprocess.run(
                [sys.executable, "-m", "ghostindex"] + args,
                cwd=str(ws), env=env, capture_output=True,
                text=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise ValueError("the tool ran past 120 seconds and "
                             "was stopped")
        if r.returncode not in ok_codes:
            text = (r.stdout or "") + (r.stderr or "")
            raise ValueError("the tool could not run: "
                             + text.strip()[:300])
        return r

    run(["index", str(ws), "--db", str(db)], (0,))
    r = run(["search", query, "--db", str(db), "--root", str(ws),
             "--json", "--limit", str(limit),
             "--max-tokens", str(max_tokens), "--context", "3"],
            (0, 1))
    try:
        out = json.loads(r.stdout)
    except ValueError:
        raise ValueError("the tool's search output could not "
                         "be read")
    out["ok"] = True
    return out


def _eco_tool_env(src):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(src)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _eco_tool_run(tool_id, args, ws, env, ok_codes):
    try:
        return subprocess.run(
            [sys.executable, "-m", tool_id] + args,
            cwd=str(ws), env=env, capture_output=True,
            text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise ValueError("the tool ran past 120 seconds and "
                         "was stopped")


def eco_prime(ws):
    """Roadmap ECO E4: the "Prime this project" chat action.
    Builds a starter bundle for the workspace with the
    GhostPrimer tool itself, verifies it with the tool's
    own check, and returns the check verdict plus PRIMER.md
    so the frontend can open a new chat with the bundle as
    its first context. Exit codes from check: 0 pass,
    1 fail (a verdict, still returned), 2 could not check
    (also a verdict in its JSON report); build exits 2
    when it could not build at all."""
    src = eco_src_dir("ghostprimer")
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    out_dir = ws / ".ghostide" / "primer"
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    env = _eco_tool_env(src)
    r = _eco_tool_run("ghostprimer",
                      ["build", str(ws), "-o", str(out_dir)],
                      ws, env, (0,))
    if r.returncode != 0:
        text = (r.stdout or "") + (r.stderr or "")
        raise ValueError("the tool could not run: "
                         + text.strip()[:300])
    rc = _eco_tool_run("ghostprimer", ["check", str(out_dir)],
                       ws, env, (0, 1, 2))
    try:
        report = json.loads(rc.stdout)
    except ValueError:
        raise ValueError("the tool's check output could not "
                         "be read")
    primer_md = (out_dir / "PRIMER.md").read_text(
        errors="replace")
    return {"ok": True, "check": report,
            "check_code": rc.returncode, "primer": primer_md,
            "bundle": ".ghostide/primer"}


def eco_handoff(ws):
    """Roadmap ECO E4: the "Draft handoff" chat action.
    Builds a handoff pack for the workspace with the
    GhostHandoff tool itself and returns HANDOFF.md for
    display. The tool is propose-only and read-only on the
    project (never commits, pushes, sends, edits, or runs
    project code); its pack lands in .ghostide/handoff and
    goes nowhere else - the user reads the draft here.
    --force lets a fresh draft replace the previous one in
    that same output dir. Exit 2 = could not build."""
    src = eco_src_dir("ghosthandoff")
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    out_dir = ws / ".ghostide" / "handoff"
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    env = _eco_tool_env(src)
    r = _eco_tool_run("ghosthandoff",
                      ["pack", str(ws), "-o", str(out_dir),
                       "--force"],
                      ws, env, (0,))
    if r.returncode != 0:
        text = (r.stdout or "") + (r.stderr or "")
        raise ValueError("the tool could not run: "
                         + text.strip()[:300])
    md = (out_dir / "HANDOFF.md").read_text(errors="replace")
    return {"ok": True, "handoff": md,
            "pack": ".ghostide/handoff"}


def eco_atlas(ws):
    """Roadmap ECO E5: the Atlas view of the repo map. Runs
    the GhostAtlas tool itself (`scan`, which prints the
    atlas data as JSON and writes no artifacts) and returns
    its JSON untouched, so the map the IDE draws is the
    tool's map. Atlas is built on GhostSlice data, so the
    GhostSlice package rides on PYTHONPATH next to it. Exit
    0 = ok, 1 = runtime failure, 2 = usage error; anything
    nonzero is "could not run" here."""
    src = eco_src_dir("ghostatlas")
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    env = dict(os.environ)
    paths = [str(src)]
    slice_src = eco_src_dir("ghostslice")
    if slice_src is not None:
        paths.append(str(slice_src))
    env["PYTHONPATH"] = os.pathsep.join(paths)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    r = _eco_tool_run("ghostatlas", ["scan", str(ws)],
                      ws, env, (0,))
    if r.returncode != 0:
        text = (r.stdout or "") + (r.stderr or "")
        raise ValueError("the tool could not run: "
                         + text.strip()[:300])
    try:
        out = json.loads(r.stdout)
    except ValueError:
        raise ValueError("the tool's scan output could not "
                         "be read")
    out["ok"] = True
    return out


def eco_recall(ws, task="", budget=6000, want_context=False):
    """Roadmap ECO E5: chat Recall of the project's memory.
    Runs the GhostRecall tool itself, never a
    reimplementation. Three shapes:
    - task given: `recall --json` - the tool's ranked
      selection (TF-IDF, pinned rules first), returned
      untouched: items, order, scores and the tool's own
      estimated token costs are the CLI's.
    - no task: `scan --json` - every memory item by
      estimated token cost, wrapped as {"items": [...]}.
    - want_context: `bundle --task <task> --fit <budget>`
      into .ghostide/recall, and PROMPT.md (the tool's own
      merged export of the selected memory) comes back as
      the context text, so what rides into chat is exactly
      what the tool exported under the budget. Token counts
      are the tool's estimates everywhere.
    The bundle run also appends the tool's own history
    ledger line inside the project (.ghostrecall-history
    .jsonl) - that is the tool's standing behavior, on the
    CLI exactly as here."""
    src = eco_src_dir("ghostrecall")
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    task = (task or "").strip()
    try:
        budget = max(200, min(int(budget or 6000), 50000))
    except (TypeError, ValueError):
        budget = 6000
    env = _eco_tool_env(src)
    if want_context:
        out_dir = ws / ".ghostide" / "recall"
        out_dir.parent.mkdir(parents=True, exist_ok=True)
        r = _eco_tool_run("ghostrecall",
                          ["bundle", str(ws), "--task", task,
                           "--fit", str(budget), "-o",
                           str(out_dir)],
                          ws, env, (0,))
        if r.returncode != 0:
            text = (r.stdout or "") + (r.stderr or "")
            raise ValueError("the tool could not run: "
                             + text.strip()[:300])
        prompt = out_dir / "PROMPT.md"
        if not prompt.is_file():
            raise ValueError("the bundle was built but its "
                             "PROMPT.md could not be read")
        totals = None
        mf = out_dir / "manifest.json"
        if mf.is_file():
            try:
                totals = json.loads(
                    mf.read_text(errors="replace")).get("totals")
            except ValueError:
                totals = None
        return {"ok": True, "mode": "context",
                "context": prompt.read_text(errors="replace"),
                "totals": totals, "bundle": ".ghostide/recall"}
    if task:
        r = _eco_tool_run("ghostrecall",
                          ["recall", str(ws), "--task", task,
                           "--json"],
                          ws, env, (0,))
        if r.returncode != 0:
            text = (r.stdout or "") + (r.stderr or "")
            raise ValueError("the tool could not run: "
                             + text.strip()[:300])
        try:
            out = json.loads(r.stdout)
        except ValueError:
            raise ValueError("the tool's recall output could "
                             "not be read")
        out["ok"] = True
        out["mode"] = "recall"
        out["task"] = task
        return out
    r = _eco_tool_run("ghostrecall",
                      ["scan", str(ws), "--json"], ws, env, (0,))
    if r.returncode != 0:
        text = (r.stdout or "") + (r.stderr or "")
        raise ValueError("the tool could not run: "
                         + text.strip()[:300])
    try:
        items = json.loads(r.stdout)
    except ValueError:
        raise ValueError("the tool's scan output could not "
                         "be read")
    return {"ok": True, "mode": "scan", "items": items}


ECO_CONVERT_TARGETS = ("agents", "cursor", "copilot", "generic")
ECO_SLICE_MODES = ("signatures", "full", "interfaces",
                   "structure", "headings", "strip-tests")


def _eco_slice_bundle(ws, mode, budget, reuse=False):
    """Materialise the current slice as a GhostSlice bundle at
    <ws>/.ghostide/slice, using GhostSlice's own export (the
    established route, same as make_context). The export runs
    into a temp dir first and the finished bundle is moved
    into .ghostide/, so the bundle never scans itself.
    .ghostide/ is the IDE's own state dir (index db, primer,
    handoff, recall, convert outputs); a "*" .gitignore inside
    it keeps GhostSlice (which respects .gitignore) from
    folding those artifacts into later slices. Returns
    (bundle_dir, slice_info). With reuse=True an existing
    bundle is converted as-is (the harness uses this to prove
    the convert step leaves the bundle untouched)."""
    bundle_dir = ws / ".ghostide" / "slice"
    if reuse and (bundle_dir / "manifest.json").is_file():
        manifest = json.loads(
            (bundle_dir / "manifest.json").read_text(
                errors="replace"))
        return bundle_dir, {
            "mode": mode, "budget": budget, "reused": True,
            "files": len(manifest.get("files", [])),
            "tokens": manifest.get("total_sliced_tokens", 0),
            "originalTokens":
                manifest.get("total_original_tokens", 0),
            "fitted": (manifest.get("fit") or {}).get(
                "fitted", True)}
    src = eco_src_dir("ghostslice")
    if src is None:
        raise ValueError("GhostSlice not found (set "
                         "GHOSTSLICE_SRC or GHOSTIDE_ECO_HOME)")
    state_dir = ws / ".ghostide"
    state_dir.mkdir(parents=True, exist_ok=True)
    gi = state_dir / ".gitignore"
    if not gi.exists():
        gi.write_text("*\n")
    tmp = Path(tempfile.mkdtemp(prefix="ghostide-slice-"))
    env = _eco_tool_env(src)
    try:
        r = subprocess.run(
            [sys.executable, "-m", "ghostslice", "export",
             str(ws), "-o", str(tmp), "--mode", mode,
             "--fit", str(budget)],
            cwd=str(ws), env=env, capture_output=True,
            text=True, timeout=180)
    except subprocess.TimeoutExpired:
        shutil.rmtree(tmp, ignore_errors=True)
        raise ValueError("GhostSlice ran past 180 seconds and "
                         "was stopped")
    manifest_p = tmp / "manifest.json"
    if not manifest_p.is_file():
        text = (r.stdout or "") + (r.stderr or "")
        shutil.rmtree(tmp, ignore_errors=True)
        raise ValueError("GhostSlice could not build a slice "
                         "bundle: " + text.strip()[:300])
    manifest = json.loads(manifest_p.read_text(errors="replace"))
    if not manifest.get("files"):
        shutil.rmtree(tmp, ignore_errors=True)
        raise ValueError("the current slice is empty - there "
                         "is nothing to convert")
    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    shutil.copytree(tmp, bundle_dir)
    shutil.rmtree(tmp, ignore_errors=True)
    return bundle_dir, {
        "mode": mode, "budget": budget, "reused": False,
        "files": len(manifest.get("files", [])),
        "tokens": manifest.get("total_sliced_tokens", 0),
        "originalTokens": manifest.get("total_original_tokens", 0),
        "fitted": (manifest.get("fit") or {}).get(
            "fitted", True)}


def _eco_losses_names(losses_md):
    return [ln[3:].strip() for ln in losses_md.splitlines()
            if ln.startswith("## ")]


def eco_convert(ws, target="agents", mode="signatures",
                budget=6000, reuse_bundle=False):
    """Roadmap ECO E6: export the current slice to another
    agent format with the GhostConvert tool itself. The slice
    is materialised as a GhostSlice bundle (see
    _eco_slice_bundle), then the tool converts it
    (`convert <bundle> --to <target> -o
    .ghostide/convert/<target> --force`) and the output is
    checked with the tool's own `verify`. Returns the
    produced artifacts plus LOSSES.md per format, so the
    losses are named in the UI, not hidden in a file. The
    source bundle is read-only for the tool; exit 2 from
    convert is a plain "could not run" error, exit 1 from
    verify is a mismatch error."""
    target = (target or "agents").strip().lower()
    if target != "all" and target not in ECO_CONVERT_TARGETS:
        raise ValueError("unknown export target: " + target)
    mode = mode if mode in ECO_SLICE_MODES else "signatures"
    try:
        budget = max(500, min(int(budget or 6000), 200000))
    except (TypeError, ValueError):
        budget = 6000
    src = eco_src_dir("ghostconvert")
    if src is None:
        raise ValueError(
            "tool source not found - place the ecosystem tools "
            "in ~/ghost-ecosystem or set GHOSTIDE_ECO_HOME")
    bundle_dir, slice_info = _eco_slice_bundle(
        ws, mode, budget, reuse=reuse_bundle)
    out_base = ws / ".ghostide" / "convert" / target
    out_base.parent.mkdir(parents=True, exist_ok=True)
    env = _eco_tool_env(src)
    r = _eco_tool_run("ghostconvert",
                      ["convert", str(bundle_dir), "--to", target,
                       "-o", str(out_base), "--force"],
                      ws, env, (0,))
    if r.returncode != 0:
        text = (r.stdout or "") + (r.stderr or "")
        raise ValueError("the tool could not run: "
                         + text.strip()[:300])
    rv = _eco_tool_run("ghostconvert",
                       ["verify", str(bundle_dir), str(out_base),
                        "--to", target],
                       ws, env, (0,))
    verify = {"code": rv.returncode,
              "output": ((rv.stdout or "")
                         + (rv.stderr or "")).strip()}
    if rv.returncode != 0:
        raise ValueError("the converted output did not verify: "
                         + verify["output"][:300])
    targets = (list(ECO_CONVERT_TARGETS) if target == "all"
               else [target])
    outputs = []
    for t in targets:
        tdir = out_base / t if target == "all" else out_base
        artifacts = []
        losses_md = ""
        for p in sorted(tdir.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(tdir).as_posix()
            content = p.read_text(errors="replace")
            if rel == "LOSSES.md":
                losses_md = content
            artifacts.append({"path": rel, "content": content})
        outputs.append({
            "target": t,
            "dir": tdir.relative_to(ws).as_posix(),
            "artifacts": artifacts,
            "losses": losses_md,
            "losses_names": _eco_losses_names(losses_md)})
    return {"ok": True, "target": target, "slice": slice_info,
            "bundle": ".ghostide/slice", "verify": verify,
            "outputs": outputs}


def _restore_journal_append(root, obj):
    """Append one event to the restore journal and
    fsync it BEFORE the filesystem step it
    describes (v2.33)."""
    with open(root / "journal.jsonl", "a",
              encoding="utf-8") as f:
        f.write(json.dumps(obj) + "\n")
        f.flush()
        os.fsync(f.fileno())


def _restore_reconcile():
    """Finish rolling back an interrupted restore
    (v2.33). A restore that never reached its
    "done" event did not happen: every file it
    touched returns to its pre-restore state,
    decided from what is actually on disk, so the
    pass is idempotent and safe to re-run after a
    kill at any point, including during this pass
    itself. Runs at server startup and at the top
    of every restore, replacing the old blind wipe
    of .ghostide-restore, which could destroy the
    only copy of a file a killed restore had moved
    into rollback/."""
    root = WORKSPACE / ".ghostide-restore"
    journal = root / "journal.jsonl"
    if not journal.is_file():
        return
    import shutil
    roll = root / "rollback"
    try:
        events = []
        for ln in journal.read_text(
                encoding="utf-8").splitlines():
            try:
                ev = json.loads(ln)
            except Exception:
                continue
            if isinstance(ev, dict):
                events.append(ev)
        if any(e.get("op") in ("done", "rolled-back")
               for e in events):
            return
        begin = next((e for e in events
                      if e.get("op") == "begin"), None)
        if begin is not None:
            manifest = [str(x) for x in
                        begin.get("manifest", [])]
            preexisting = set(str(x) for x in
                              begin.get(
                                  "preexisting", []))
            applied = set(str(e.get("path", ""))
                          for e in events
                          if e.get("op") == "applied")
            for clean in reversed(manifest):
                parts = clean.split("/")
                dst = WORKSPACE.joinpath(*parts)
                rb = roll.joinpath(*parts)
                try:
                    if rb.is_file():
                        if dst.is_file():
                            dst.unlink()
                        dst.parent.mkdir(
                            parents=True,
                            exist_ok=True)
                        shutil.move(str(rb), str(dst))
                    elif clean in applied \
                            and clean not in preexisting \
                            and dst.is_file():
                        dst.unlink()
                except Exception:
                    pass
            dirs = [str(x) for x in
                    begin.get("dirs", [])]
            for d in sorted(dirs,
                            key=lambda s: -s.count("/")):
                f = WORKSPACE.joinpath(*d.split("/"))
                try:
                    if f.is_dir() \
                            and not any(f.iterdir()):
                        f.rmdir()
                except Exception:
                    pass
        elif roll.is_dir():
            # Torn begin line: the rollback copies
            # are the ground truth. Move each one
            # home over whatever is in the way.
            for rb in sorted(roll.rglob("*")):
                if not rb.is_file():
                    continue
                dst = WORKSPACE / rb.relative_to(roll)
                try:
                    if dst.is_file():
                        dst.unlink()
                    dst.parent.mkdir(parents=True,
                                     exist_ok=True)
                    shutil.move(str(rb), str(dst))
                except Exception:
                    pass
    finally:
        shutil.rmtree(root, ignore_errors=True)


class Handler(SimpleHTTPRequestHandler):
    # v2.35: a client that trickles or stalls a
    # request gets 30 s per blocking socket call,
    # not forever (this server is LAN-exposed in
    # LAN mode). Long responses stay legal: the
    # timeout bounds each read/write stall, not
    # the whole transfer.
    timeout = 30

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- helpers ----------
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        # v2.35: refuse ambiguous framing instead
        # of guessing - a second Content-Length or
        # any Transfer-Encoding is a hard error
        # (bodies here are length-framed only).
        cls = self.headers.get_all("Content-Length") or []
        if len(cls) > 1:
            raise ValueError("duplicate Content-Length")
        if self.headers.get("Transfer-Encoding"):
            raise ValueError(
                "chunked transfer not supported")
        try:
            n = int(cls[0]) if cls else 0
        except ValueError:
            raise ValueError("bad Content-Length")
        if n < 0 or n > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        raw_body = self.rfile.read(n)
        if len(raw_body) < n:
            # v2.35: a short read at EOF means the
            # client promised bytes it never sent;
            # never route the partial body.
            raise ValueError("request body truncated")
        return json.loads(raw_body or b"{}")

    def _lsp_post(self, action):
        """D4: one place for the /api/lsp/* POST routes,
        so the error shape stays consistent: an honest
        status payload for installing / unavailable /
        crashed, 403 for untrusted, 400 for bad input."""
        try:
            data = self.read_json()
            mgr = get_lsp()
            rel = str(data.get("path") or "")
            if action in ("open", "change", "close", "save",
                          "hover", "definition", "completion",
                          "symbols"):
                if not rel:
                    raise ValueError("path is required")
                safe_path(rel)  # must stay in the workspace
            if action == "open":
                return self.send_json(mgr.open_document(
                    rel, str(data.get("content") or "")))
            if action == "change":
                return self.send_json(mgr.change_document(
                    rel, str(data.get("content") or "")))
            if action == "close":
                return self.send_json(mgr.close_document(rel))
            if action == "save":
                return self.send_json(mgr.save_document(rel))
            if action == "hover":
                return self.send_json({"result": mgr.hover(
                    rel, data.get("line", 0),
                    data.get("character", 0))})
            if action == "definition":
                raw = mgr.definition(
                    rel, data.get("line", 0),
                    data.get("character", 0))
                return self.send_json(
                    {"locations": _lsp_locations(raw)})
            if action == "completion":
                return self.send_json({"result": mgr.completion(
                    rel, data.get("line", 0),
                    data.get("character", 0))})
            if action == "symbols":
                return self.send_json({"result":
                                       mgr.document_symbols(rel)})
            if action == "restart":
                key = str(data.get("language") or "")
                if key not in _lsp_mod.SERVER_NAMES:
                    raise ValueError("unknown language: " + key)
                return self.send_json(mgr.restart(key))
            if action == "install":
                key = str(data.get("language") or "")
                if key not in _lsp_mod.SERVER_NAMES:
                    raise ValueError("unknown language: " + key)
                return self.send_json(mgr.install(key))
            raise ValueError("unknown LSP action: " + action)
        except _lsp_mod.LspTrustError as e:
            return self.send_json(
                {"error": str(e), "code": e.code}, status=403)
        except _lsp_mod.LspError as e:
            status = 503 if e.code in (
                "lsp-unavailable", "lsp-installing",
                "lsp-crashed") else 400
            return self.send_json(
                {"error": str(e), "code": e.code,
                 "status": get_lsp().status()}, status=status)
        except ValueError as e:
            return self.send_json({"error": str(e)}, status=400)

    def proxy(self, path, payload, stream=False):
        """Forward a JSON POST to llama.cpp and relay the response."""
        conn = http.client.HTTPConnection(
            urllib.parse.urlparse(LLAMA_BASE).hostname,
            urllib.parse.urlparse(LLAMA_BASE).port or 8080, timeout=900)
        conn.request("POST", path, json.dumps(payload),
                     {"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.send_response(resp.status)
        self.send_header("Content-Type",
                         resp.getheader("Content-Type") or "application/json")
        if stream:
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            while True:
                chunk = resp.read(1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        else:
            body = resp.read()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        conn.close()

    def _mcp_oauth_callback(self, parsed):
        """D8: the loopback landing for an OAuth authorize
        redirect. The state value is the credential here:
        it was minted by /api/mcp/oauth/start on this
        server and is single-use, so a stray browser hit
        cannot connect anything."""
        qs = urllib.parse.parse_qs(parsed.query)
        code = (qs.get("code") or [""])[0]
        state = (qs.get("state") or [""])[0]
        err = (qs.get("error") or [""])[0]
        if err:
            title, msg = "Sign-in was not completed", \
                "The provider reported: " + err
        elif not code or not state:
            title, msg = "Sign-in was not completed", \
                "The callback arrived without a code."
        else:
            try:
                server = mcp_oauth_exchange(state, code)
                title = "Connected"
                msg = ("The MCP server '" + server +
                       "' is connected. You can close "
                       "this tab and return to GhostIDE.")
            except ValueError as e:
                title, msg = "Sign-in failed", str(e)
        def esc(s):
            return (str(s).replace("&", "&amp;")
                    .replace("<", "&lt;").replace(">", "&gt;"))
        body = ("<!doctype html><meta charset=utf-8>"
                "<title>GhostIDE MCP - " + esc(title) +
                "</title><body style=\"font-family:"
                "system-ui;background:#111;color:#eee;"
                "padding:2rem\"><h1>" + esc(title) +
                "</h1><p>" + esc(msg) + "</p></body>").encode()
        self.send_response(200)
        self.send_header("Content-Type",
                         "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return None

    # ---------- routes ----------
    def _pair_gate(self, path):
        if not path.startswith("/api/"):
            return True
        if path == "/api/pair/join":
            return True
        if self.client_address[0] in ("127.0.0.1", "::1"):
            return True
        import time as _time
        tok = self.headers.get("X-Pair-Token") or ""
        return pair_token_valid(tok, _time.time())

    def _pair_role_denied(self, path):
        # R12: viewer guests may read and heartbeat,
        # nothing else that mutates.
        if self.client_address[0] in ("127.0.0.1",
                                      "::1"):
            return False
        if path == "/api/pair/heartbeat":
            return False
        tok = self.headers.get("X-Pair-Token") or ""
        import time as _time
        if not pair_token_valid(tok, _time.time()):
            return False
        return PAIR_TOKENS[tok][0] == "viewer"

    def _pair_policy(self, method):
        if self.client_address[0] not in ("127.0.0.1",
                                          "::1"):
            return self.send_json(
                {"error": "pairing policy is set "
                          "on the host"}, status=403)
        if method == "POST":
            data = self.read_json()
            PAIR_POLICY["viewOnly"] = bool(
                data.get("viewOnly"))
        return self.send_json(
            {"viewOnly": PAIR_POLICY["viewOnly"]})

    def _pair_revoke(self):
        # v2.32: the host ejects every guest at
        # once; their next request hits the gate
        # and they re-join with the code.
        if self.client_address[0] not in ("127.0.0.1",
                                          "::1"):
            return self.send_json(
                {"error": "guests are revoked "
                          "on the host"}, status=403)
        PAIR_TOKENS.clear()
        return self.send_json({"ok": True})

    def _pair_code(self):
        if self.client_address[0] not in ("127.0.0.1",
                                          "::1"):
            return self.send_json(
                {"error": "pairing code is only shown "
                          "on the host"}, status=403)
        return self.send_json({"code": PAIR_CODE})

    def _pair_certfp(self):
        # v2.38: the host identity a guest verifies
        # before typing the code. Loopback-only, like
        # the code itself; the fingerprint is public
        # once you are on the host, useless to a
        # network caller who cannot see the screen.
        if self.client_address[0] not in ("127.0.0.1",
                                          "::1"):
            return self.send_json(
                {"error": "host identity is only shown "
                          "on the host"}, status=403)
        return self.send_json(
            {"tls": bool(TLS_STATE["active"]),
             "fingerprint": TLS_STATE["fingerprint"]})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if not self._pair_gate(parsed.path):
                return self.send_json(
                    {"error": "pairing required"}, status=401)
            if parsed.path in TRUST_EXEC_ROUTES \
                    and not workspace_trusted():
                return _trust_denied(self)
            if parsed.path == "/api/pair/code":
                return self._pair_code()
            if parsed.path == "/api/pair/certfp":
                return self._pair_certfp()
            if parsed.path == "/api/pair/policy":
                return self._pair_policy("GET")
            if parsed.path == "/api/health":
                return self.send_json(
                    {"model": "up" if llama_health() else "down",
                     "llama": llama_status(),
                     "modelName": MODEL_NAME, "version": APP_VERSION,
                     "pairRequired": True,
                     "backupFormats": [1, 2],
                     "lsp": get_lsp().status_summary(),
                     "portable": PORTABLE,
                     "trusted": workspace_trusted(),
                     "workspace": str(WORKSPACE)})
            if parsed.path == "/api/eco/tools":
                return self.send_json({"tools": eco_tools_state()})
            if parsed.path == "/api/eco/info":
                # I18: bundle readout for Settings - on
                # desktop the source of truth is the gate's
                # state file (the phone reads its manifest).
                info = {"generation": "source checkouts",
                        "tools": 0, "bytes": 0}
                state_f = (ROOT / "tools"
                           / "eco-bundle-state.json")
                if state_f.is_file():
                    try:
                        st = json.loads(state_f.read_text(
                            encoding="utf-8"))
                        tools = st.get("tools") or {}
                        # A9: count LIBRARY + BUNDLED like
                        # the phone's manifest does (the
                        # library ships in the bundle too).
                        info["tools"] = len(
                            (st.get("bundled") or [])
                            + (st.get("library") or [])) \
                            or len(tools)
                        info["bytes"] = sum(
                            int(v.get("src_bytes") or 0)
                            for v in tools.values())
                    except (ValueError, OSError):
                        pass
                return self.send_json(info)
            if parsed.path == "/api/rea/status":
                return self.send_json(rea_status())
            if parsed.path == "/api/mcp/servers":
                try:
                    return self.send_json(mcp_servers())
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/policy":
                return self.send_json(mcp_policy_view())
            if parsed.path == "/api/mcp/config":
                return self.send_json(mcp_config_view())
            if parsed.path == "/api/mcp/catalog":
                return self.send_json(mcp_catalog())
            if parsed.path == "/api/mcp/status":
                try:
                    return self.send_json(mcp_status())
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/oauth/callback":
                return self._mcp_oauth_callback(parsed)
            if parsed.path == "/api/approve/list":
                try:
                    return self.send_json(approve_list())
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/replay/list":
                return self.send_json(replay_list(WORKSPACE))
            if parsed.path == "/api/eco/replay/get":
                qs = urllib.parse.parse_qs(parsed.query)
                try:
                    return self.send_json(replay_get(
                        WORKSPACE,
                        (qs.get("id") or [""])[0]))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/approve/audit":
                try:
                    return self.send_json(approve_audit())
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/git/worktrees":
                try:
                    return self.send_json(git_worktrees())
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/files":
                out = []
                for p in sorted(WORKSPACE.rglob("*")):
                    if any(part.startswith(".") for part in
                           p.relative_to(WORKSPACE).parts):
                        continue
                    entry = {
                        "path": str(p.relative_to(WORKSPACE)),
                        "type": "dir" if p.is_dir() else "file"}
                    if entry["type"] == "file":
                        # Roadmap G25: sizes power the asset
                        # browser's heaviest-first sort.
                        # E16 (v2.45): mtime powers the watch
                        # feed - changes made outside the IDE.
                        try:
                            _st = p.stat()
                            entry["size"] = _st.st_size
                            entry["mtime"] = int(
                                _st.st_mtime * 1000)
                        except OSError:
                            entry["size"] = 0
                            entry["mtime"] = 0
                    out.append(entry)
                return self.send_json({"files": out})
            if parsed.path == "/api/history":
                # Local History (Phase 11): snapshots of one file.
                import re as _re
                qs = urllib.parse.parse_qs(parsed.query)
                rel = qs["path"][0]
                safe_path(rel)
                rp = Path(rel)
                hdir = (WORKSPACE / ".ghostide-history" / rp.parent)
                entries = []
                if hdir.is_dir():
                    for s in sorted(hdir.glob(rp.name + ".*.snap"),
                                    reverse=True):
                        entries.append({
                            "ts": s.name[len(rp.name) + 1:-5],
                            "size": s.stat().st_size})
                return self.send_json({"entries": entries})
            if parsed.path == "/api/history/file":
                import re as _re
                qs = urllib.parse.parse_qs(parsed.query)
                rel = qs["path"][0]
                ts = qs["ts"][0]
                safe_path(rel)
                if not _re.fullmatch(r"[\d-]+", ts):
                    raise ValueError("bad snapshot id")
                rp = Path(rel)
                snap = (WORKSPACE / ".ghostide-history" / rp.parent
                        / (rp.name + "." + ts + ".snap"))
                if not snap.is_file():
                    raise ValueError("snapshot not found")
                return self.send_json({
                    "content": snap.read_text(errors="replace")})
            if parsed.path == "/api/git/blame":
                # GitLens-style: who last touched this line.
                qs = urllib.parse.parse_qs(parsed.query)
                rel = qs["path"][0]
                try:
                    line_no = int(qs.get("line", ["1"])[0])
                except Exception:
                    line_no = 1
                rc, out, err, _ = git_out(
                    ["blame", "--porcelain", "-L",
                     str(line_no) + "," + str(line_no), "--", rel])
                if rc != 0:
                    return self.send_json({"ok": False})
                author = ""
                when = 0
                summary = ""
                for ln in out.splitlines():
                    if ln.startswith("author "):
                        author = ln[7:]
                    elif ln.startswith("author-time "):
                        when = int(ln[12:] or 0)
                    elif ln.startswith("summary "):
                        summary = ln[8:]
                return self.send_json({
                    "ok": True, "author": author, "time": when,
                    "summary": summary})
            if parsed.path == "/api/check-all":
                # Project-wide Problems (desktop checkers).
                # Roadmap G32: the logic lives in _check_all
                # so the verify pipeline runs the SAME code.
                return self.send_json(_check_all())
            if parsed.path == "/api/tests/discover":
                return self.send_json({"files": discover_tests()})
            if parsed.path == "/api/symbols":
                idx = _symbol_index()
                return self.send_json({
                    "symbols": idx["symbols"],
                    "files": idx["files"]})
            if parsed.path == "/api/symbols/search":
                qs = urllib.parse.parse_qs(parsed.query)
                name = qs.get("name", [""])[0]
                idx = _symbol_index()
                hits = [s for s in idx["symbols"]
                        if s["name"] == name]
                return self.send_json({"symbols": hits})
            if parsed.path == "/api/references":
                qs = urllib.parse.parse_qs(parsed.query)
                name = qs.get("name", [""])[0]
                idx = _symbol_index()
                all_refs = idx["refs"].get(name, [])
                return self.send_json({
                    "references": all_refs[:300],
                    "total": len(all_refs),
                    "truncated": len(all_refs) > 300})
            if parsed.path == "/api/classroom/state":
                qs = urllib.parse.parse_qs(parsed.query)
                code = qs.get("code", [""])[0]
                if not _classroom["code"] or \
                        code != _classroom["code"]:
                    return self.send_json(
                        {"error": "no classroom with that code"},
                        404)
                return self.send_json({
                    "state": _classroom["state"],
                    "annotations":
                        _classroom["annotations"][-20:]})
            if parsed.path == "/api/classroom/annotations":
                qs = urllib.parse.parse_qs(parsed.query)
                if qs.get("host", [""])[0] != \
                        (_classroom["host"] or "\x00"):
                    return self.send_json(
                        {"error": "not the classroom host"}, 403)
                return self.send_json(
                    {"annotations": _classroom["annotations"]})
            if parsed.path == "/api/classroom/info":
                return self.send_json(_classroom_info())
            if parsed.path == "/api/context/stats":
                # Roadmap G27: the context lab. The estimator
                # is a faithful port of GhostSlice's tokens.py
                # (method v2, per-language calibrated), so the
                # lab's numbers match `ghostslice scan` on the
                # same tree. Walk rules mirror its scanner:
                # fixed skip dirs, binary exts out, lockfiles
                # counted and flagged, text exts +
                # extensionless files in, 5 MB per-file cap
                # (bytes reported, tokens null past the cap).
                return self.send_json(_context_stats())
            if parsed.path == "/api/refdocs/search":
                # Roadmap G28: search the bundled offline
                # reference (refdocs.json, built by
                # tools/gen_refdocs.py).
                qs = urllib.parse.parse_qs(parsed.query)
                q = qs.get("q", [""])[0]
                return self.send_json(
                    {"results": _refdoc_search(q)})
            if parsed.path == "/api/refdocs/get":
                qs = urllib.parse.parse_qs(parsed.query)
                want = qs.get("id", [""])[0]
                for e in _refdocs():
                    if e["id"] == want:
                        return self.send_json({"entry": e})
                return self.send_json(
                    {"error": "No such reference entry."})
            if parsed.path == "/api/repomap":
                qs = urllib.parse.parse_qs(parsed.query)
                try:
                    budget = int(qs.get("budget", ["6000"])[0])
                except Exception:
                    budget = 6000
                budget = max(1000, min(20000, budget))
                return self.send_json({
                    "map": _repo_map(budget)})
            if parsed.path == "/api/file":
                rel = urllib.parse.parse_qs(parsed.query)["path"][0]
                p = safe_path(rel)
                return self.send_json(
                    {"path": rel, "content": p.read_text(errors="replace")})
            if parsed.path == "/api/workspace":
                return self.send_json({
                    "workspace": str(WORKSPACE),
                    "trusted": workspace_trusted(),
                    "portable": PORTABLE})
            if parsed.path == "/api/trust":
                # D7: the open workspace's trust state.
                return self.send_json({
                    "workspace": str(WORKSPACE),
                    "trusted": workspace_trusted(),
                    "decision": TRUST_STORE.decision(WORKSPACE)})
            if parsed.path == "/api/agent-runs":
                # D2: list run records, or fetch one with
                # ?id=<run id>. Records are data; reading
                # them executes nothing.
                qs = urllib.parse.parse_qs(parsed.query)
                rid = (qs.get("id") or [""])[0]
                if rid:
                    p = _agent_run_path(rid)
                    if not p.is_file():
                        return self.send_json(
                            {"error": "no such run record"},
                            status=404)
                    return self.send_json(
                        {"record": json.loads(p.read_text())})
                return self.send_json(
                    {"runs": _list_agent_runs()})
            if parsed.path == "/api/tasks":
                # S1: list task record summaries, or fetch
                # one with ?id=<task id>. Records are data;
                # reading them executes nothing.
                qs = urllib.parse.parse_qs(parsed.query)
                tid = (qs.get("id") or [""])[0]
                if tid:
                    try:
                        p = _task_path(tid)
                    except ValueError as e:
                        return self.send_json(
                            {"error": str(e)}, status=400)
                    if not p.is_file():
                        return self.send_json(
                            {"error": "no such task record"},
                            status=404)
                    try:
                        rec = _validate_task(
                            json.loads(p.read_text()), 0)
                    except ValueError as e:
                        return self.send_json(
                            {"error": str(e)}, status=400)
                    return self.send_json({"record": rec})
                return self.send_json(
                    {"tasks": _list_tasks()})
            if parsed.path == "/api/instructions":
                # D7: which instruction files are in force
                # for this workspace (AGENTS.md, with the
                # .ghostide/AGENTS.md override).
                files = _trust_mod.load_instructions(WORKSPACE)
                return self.send_json({
                    "workspace": str(WORKSPACE),
                    "files": [{"rel": f["rel"],
                               "chars": f["chars"]}
                              for f in files]})
            if parsed.path == "/api/lsp/status":
                # D4: per-language server state. Read-only:
                # asking never spawns or installs anything.
                return self.send_json(get_lsp().status())
            if parsed.path == "/api/lsp/diagnostics":
                # D4: the diagnostics the language servers
                # have published, per workspace-relative
                # path (one file with ?path=, else all).
                qs = urllib.parse.parse_qs(parsed.query)
                rel = (qs.get("path") or [None])[0]
                return self.send_json({
                    "files": get_lsp().diagnostics(rel)})
            if parsed.path == "/api/update/status":
                # D3: packaged-app update state (check,
                # staged download, pending apply/rollback).
                return self.send_json(get_updater().status())
            if parsed.path == "/api/update/check":
                try:
                    req = urllib.request.Request(
                        UPDATE_URL,
                        headers={"User-Agent":
                                 "GhostIDE/" + APP_VERSION})
                    with urllib.request.urlopen(req,
                                                timeout=6) as r:
                        info = json.loads(
                            r.read().decode("utf-8"))
                    # Desktop Cycle 1: VERSION.json is
                    # per-platform now. The desktop train
                    # ("desktop".version, falling back to
                    # "version") is what this check follows;
                    # "latest" stays the phone's train and
                    # is not read here.
                    latest = str((info.get("desktop") or {})
                                 .get("version")
                                 or info.get("version", ""))

                    def _tup(v):
                        out = []
                        for x in v.split("."):
                            try:
                                out.append(int(x))
                            except Exception:
                                out.append(0)
                        return tuple(out)
                    return self.send_json({
                        "ok": True, "current": APP_VERSION,
                        "latest": latest,
                        "updateAvailable": bool(latest)
                        and _tup(latest) > _tup(APP_VERSION),
                        "notes": info.get("notes", ""),
                        "url": info.get("url", "")})
                except Exception:
                    return self.send_json({
                        "ok": False, "current": APP_VERSION,
                        "error": "could not reach the update "
                                 "server"})
            if parsed.path == "/api/model/download":
                entry = MODEL_CATALOG["7b"]
                dest = MODELS_DIR / entry["file"]
                return self.send_json({
                    **DL_STATE,
                    "downloaded": dest.is_file(),
                    "path": str(dest),
                    "bytes": entry["bytes"],
                    "modelsDir": str(MODELS_DIR)})
            if parsed.path == "/api/llama/download":
                entry = LLAMA_CATALOG.get(
                    _llama_platform_key() or "") or {}
                return self.send_json({
                    **LLAMA_DL_STATE,
                    "present": llama_present(),
                    "path": str(_llama_dir()),
                    "bytes": entry.get("bytes", 0),
                    "release": LLAMA_RELEASE})
            if parsed.path == "/api/embed/status":
                # Desktop Cycle 3, D5: neural index status -
                # model presence, engine state, index stats
                # and build progress (see embed_status).
                return self.send_json(embed_status())
            if parsed.path == "/api/embed/download":
                return self.send_json({
                    **EMBED_DL_STATE,
                    "downloaded": _embed_model_present(),
                    "path": str(_embed_model_path()),
                    "bytes": EMBED_MODEL["bytes"],
                    "modelsDir": str(MODELS_DIR)})
            if parsed.path == "/api/model/info":
                mp = Path(MODEL)
                return self.send_json({
                    "modelName": MODEL_NAME, "modelPath": MODEL,
                    "exists": mp.is_file(),
                    "bytes": mp.stat().st_size if mp.is_file() else 0})
            if parsed.path == "/api/models/store":
                # Desktop Cycle 3, D6: the model store
                # listing (catalog + embedding + imported
                # cards, machine fit, disk, download
                # states). Read-only; spawns nothing, so
                # it stays open like the other model GETs.
                return self.send_json(models_store())
            if parsed.path == "/api/git/status":
                rc, out, err, _ = git_out(
                    ["status", "--porcelain=v1", "--branch"])
                if rc != 0:
                    return self.send_json({"repo": False,
                                           "error": err.strip()[:200]})
                lines = out.splitlines()
                branch = ""
                ahead = 0
                behind = 0
                changes = []
                for ln in lines:
                    if ln.startswith("## "):
                        # Cycle 4 I1: the branch header
                        # already carries [ahead N, behind M]
                        # when an upstream is configured.
                        branch = ln[3:].split("...")[0].strip()
                        m_a = _re_mod.search(r"ahead (\d+)", ln)
                        m_b = _re_mod.search(r"behind (\d+)", ln)
                        if m_a:
                            ahead = int(m_a.group(1))
                        if m_b:
                            behind = int(m_b.group(1))
                    elif len(ln) > 3:
                        changes.append({"index": ln[0], "worktree": ln[1],
                                        "path": ln[3:].strip()})
                scope_line = ""
                pack_md = (WORKSPACE / ".ghostide" / "scope-pack"
                           / "REVIEW.md")
                if pack_md.is_file():
                    try:
                        for ln in pack_md.read_text(
                                encoding="utf-8",
                                errors="replace").splitlines():
                            if ln.strip():
                                scope_line = ln.strip().lstrip(
                                    "# ").strip()[:160]
                                break
                    except OSError:
                        scope_line = ""
                # Cycle 7 I8: the stash depth rides the
                # status the panel already polls.
                stash_n = 0
                try:
                    rc_s, out_s, _, _ = git_out(["stash", "list"])
                    if rc_s == 0:
                        stash_n = len([ln for ln
                                         in out_s.splitlines()
                                         if ln.strip()])
                except Exception:
                    stash_n = 0
                # D9 (Desktop Cycle 3): unmerged paths
                # and any in-progress merge / rebase /
                # cherry-pick ride the same status the
                # panel already polls.
                conflicts = [c["path"] for c in changes
                             if _is_conflict_xy(c["index"],
                                                c["worktree"])]
                return self.send_json({"repo": True, "branch": branch,
                                       "ahead": ahead, "behind": behind,
                                       "changes": changes,
                                       "stash": stash_n,
                                       "conflicts": conflicts,
                                       "mergeState": git_merge_state(),
                                       "scope_line": scope_line})
            if parsed.path == "/api/git/remote":
                rc, out, err, _ = git_out(["remote"])
                if rc != 0:
                    return self.send_json({"repo": False,
                                           "error": err.strip()[:200]})
                remotes = []
                for name in out.splitlines():
                    name = name.strip()
                    if not name:
                        continue
                    rc2, u, _, _ = git_out(
                        ["remote", "get-url", name])
                    remotes.append({"name": name,
                                    "url": u.strip() if rc2 == 0 else ""})
                return self.send_json({"repo": True,
                                       "remotes": remotes})
            if parsed.path == "/api/git/diff":
                rel = urllib.parse.parse_qs(parsed.query)["path"][0]
                safe_path(rel)
                rc, out, err, _ = git_out(["diff", "HEAD", "--", rel])
                if rc != 0:
                    raise ValueError(err.strip()[:300] or "git diff failed")
                return self.send_json({"path": rel, "diff": out})
            if parsed.path == "/api/git/hunks":
                # D9: one file's diff as structured
                # hunks for hunk staging. area=worktree
                # is the unstaged diff, area=index the
                # staged one.
                qs = urllib.parse.parse_qs(parsed.query)
                rel = (qs.get("path") or [""])[0]
                area = (qs.get("area") or ["worktree"])[0]
                if area not in ("worktree", "index"):
                    raise ValueError("bad area")
                return self.send_json(git_hunks(rel, area))
            if parsed.path == "/api/git/conflict":
                # D9: base / ours / theirs + the working
                # file for the three-pane conflict editor.
                qs = urllib.parse.parse_qs(parsed.query)
                rel = (qs.get("path") or [""])[0]
                return self.send_json(git_conflict(rel))
            if parsed.path == "/api/git/log":
                rc, out, err, _ = git_out(["log", "--oneline", "-20"])
                if rc != 0:
                    return self.send_json({"commits": []})
                commits = []
                for line in out.splitlines():
                    if not line.strip():
                        continue
                    parts = line.split(" ", 1)
                    commits.append({
                        "hash": parts[0],
                        "subject": parts[1] if len(parts) > 1 else ""})
                return self.send_json({"commits": commits})
            if parsed.path == "/api/git/show":
                # Cycle 5 I16: one commit, stat + patch.
                # The hash is pinned to hex so it can
                # never become a flag or a path.
                qs = urllib.parse.parse_qs(parsed.query)
                chash = (qs.get("hash") or [""])[0]
                if not _re_mod.fullmatch(r"[0-9a-f]{7,40}",
                                         chash):
                    return self.send_json(
                        {"error": "bad commit hash"},
                        status=400)
                rc, out, err, _ = git_out(
                    ["show", "--stat", "--patch",
                     "--no-color", chash])
                if rc != 0:
                    return self.send_json(
                        {"error": (err or "git show failed")
                            .strip()[:200]}, status=400)
                return self.send_json(
                    {"output": (out or "")[:20000]})
            if parsed.path == "/api/git/branches":
                # Cycle 7 I1: the branch list - the
                # panel switcher and the agent read it.
                rc, out, err, _ = git_out(
                    ["branch",
                     "--format=%(refname:short)\t%(HEAD)"])
                if rc != 0:
                    return self.send_json({"branches": []})
                branches = []
                for line in out.splitlines():
                    if not line.strip():
                        continue
                    nm, _, head = line.partition("\t")
                    branches.append({
                        "name": nm,
                        "current": head.strip() == "*"})
                return self.send_json({"branches": branches})
            if parsed.path == "/api/git/stash":
                # Cycle 7 I6: the stash list.
                rc, out, err, _ = git_out(
                    ["stash", "list", "--format=%gd%x09%s"])
                if rc != 0:
                    return self.send_json({"entries": []})
                entries = []
                for line in out.splitlines():
                    if not line.strip():
                        continue
                    ref, _, msg = line.partition("\t")
                    m_i = _re_mod.search(r"\{(\d+)\}", ref)
                    entries.append({
                        "index": int(m_i.group(1)) if m_i else 0,
                        "ref": ref, "message": msg})
                return self.send_json({"entries": entries})
            if parsed.path == "/api/git/tags":
                # Cycle 8 I11: the tag list, with the
                # short object each tag points at.
                rc, out, err, _ = git_out(
                    ["tag", "--list",
                     "--format=%(refname:short)"
                     "%09%(objectname:short)"])
                if rc != 0:
                    return self.send_json({"tags": []})
                tags = []
                for line in out.splitlines():
                    if not line.strip():
                        continue
                    nm, _, tgt = line.partition("\t")
                    tags.append({"name": nm, "target": tgt})
                return self.send_json({"tags": tags})
            if parsed.path == "/api/git/diff-all":
                # Whole-change diff for the AI commit message tool.
                rc, out, err, _ = git_out(["diff", "HEAD", "--no-color"])
                if rc != 0:
                    rc, out, err, _ = git_out(
                        ["diff", "--cached", "--no-color"])
                if rc != 0:
                    return self.send_json({"repo": False})
                # Roadmap G26: the pre-commit review reads
                # this too, so the cap is generous now.
                return self.send_json({"diff": out[:60000]})
            if parsed.path == "/api/export-zip":
                # Download the whole workspace as one zip (backup /
                # move a project). Dot paths skipped, 50 MB cap.
                import io
                import zipfile
                buf = io.BytesIO()
                total = 0
                with zipfile.ZipFile(buf, "w",
                                     zipfile.ZIP_DEFLATED) as z:
                    for p in sorted(WORKSPACE.rglob("*")):
                        rel = p.relative_to(WORKSPACE)
                        if any(part.startswith(".")
                               for part in rel.parts):
                            continue
                        if not p.is_file():
                            continue
                        try:
                            sz = p.stat().st_size
                        except Exception:
                            continue
                        if total + sz > 50 * 1024 * 1024:
                            continue
                        z.write(p, str(rel))
                        total += sz
                body = buf.getvalue()
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header(
                    "Content-Disposition",
                    'attachment; filename="ghostide-workspace.zip"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == "/api/pair/peers":
                return self.send_json({"peers": pair_snapshot()})
            if parsed.path == "/api/pair/devices":
                # Cycle 3 I2: paired guest tokens as
                # metadata only - role + issue + expiry.
                # Token values never leave the server.
                now = time.time()
                devices = [{
                    "role": rec[0],
                    "issued": int(rec[1]),
                    "expires": int(rec[1] + PAIR_TOKEN_TTL),
                } for rec in PAIR_TOKENS.values()
                    if now - rec[1] <= PAIR_TOKEN_TTL]
                return self.send_json({"devices": devices})
            if parsed.path == "/api/todos":
                # TODO/FIXME scanner (Tools pack): markers across the
                # workspace, clickable in the UI to jump to the line.
                import re as _re
                marker = _re.compile(r"\b(TODO|FIXME|XXX|HACK)\b[:\s]*(.*)")
                out = []
                for rel, p in iter_text_files():
                    try:
                        lines = p.read_text(
                            encoding="utf-8", errors="strict").splitlines()
                    except Exception:
                        continue
                    for i, line in enumerate(lines, 1):
                        m = marker.search(line)
                        if m:
                            out.append({"path": str(rel), "line": i,
                                        "kind": m.group(1),
                                        "text": line.strip()[:200]})
                        if len(out) >= 300:
                            break
                    if len(out) >= 300:
                        break
                return self.send_json({"todos": out})
            if parsed.path == "/api/stats":
                # Project stats (Tools pack): files, lines, by type.
                files = 0
                total_bytes = 0
                lines_total = 0
                by_ext = {}
                for p in WORKSPACE.rglob("*"):
                    rel = p.relative_to(WORKSPACE)
                    if any(part.startswith(".") for part in rel.parts):
                        continue
                    if not p.is_file():
                        continue
                    files += 1
                    try:
                        total_bytes += p.stat().st_size
                    except Exception:
                        pass
                    ext = p.suffix.lower() or "(none)"
                    slot = by_ext.setdefault(
                        ext, {"files": 0, "lines": 0})
                    slot["files"] += 1
                    if p.stat().st_size <= 2 * 1024 * 1024:
                        try:
                            n = p.read_bytes().count(b"\n")
                            slot["lines"] += n
                            lines_total += n
                        except Exception:
                            pass
                return self.send_json({
                    "files": files, "bytes": total_bytes,
                    "lines": lines_total, "byExt": by_ext})
            if parsed.path == "/api/raw":
                # Serve a workspace file as-is (image previews).
                rel = urllib.parse.parse_qs(parsed.query)["path"][0]
                p = safe_path(rel)
                if not p.is_file():
                    raise FileNotFoundError(rel)
                ctype = {
                    ".png": "image/png", ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg", ".gif": "image/gif",
                    ".svg": "image/svg+xml", ".webp": "image/webp",
                    ".bmp": "image/bmp", ".ico": "image/x-icon",
                }.get(p.suffix.lower(), "application/octet-stream")
                body = p.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == "/api/sync/bundle":
                # LAN sync (Phase 3.3): the whole workspace as JSON for
                # the phone app to pull. Text files only, size-capped.
                files = []
                skipped = 0
                for rel, p in iter_text_files():
                    try:
                        files.append({"path": str(rel),
                                      "content": p.read_text()})
                    except Exception:
                        skipped += 1
                return self.send_json({"files": files,
                                       "skipped": skipped,
                                       "workspace": str(WORKSPACE)})
            if parsed.path.startswith("/api/"):
                # A15/A18: unknown API routes answer the
                # JSON error contract, not the static
                # handler's HTML 404 page.
                return self.send_json(
                    {"error": "no such route"}, status=404)
            return super().do_GET()
        except Exception as e:
            return self.send_json({"error": str(e)}, status=400)

    def do_POST(self):
        global WORKSPACE, MODEL, MODEL_NAME
        parsed = urllib.parse.urlparse(self.path)
        try:
            if not self._pair_gate(parsed.path):
                return self.send_json(
                    {"error": "pairing required"}, status=401)
            if self._pair_role_denied(parsed.path):
                return self.send_json(
                    {"error": "view-only guest"},
                    status=403)
            if parsed.path in TRUST_EXEC_ROUTES \
                    and not workspace_trusted():
                return _trust_denied(self)
            if parsed.path == "/api/pair/policy":
                return self._pair_policy("POST")
            if parsed.path == "/api/pair/revoke":
                return self._pair_revoke()
            if parsed.path == "/api/pair/join":
                import time as _time
                ip = self.client_address[0]
                if pair_join_locked(ip, _time.time()):
                    return self.send_json(
                        {"error": "too many attempts, "
                                  "try again later"},
                        status=429)
                data = self.read_json()
                if str(data.get("code", "")).strip() \
                        != PAIR_CODE:
                    pair_join_record(ip, False, _time.time())
                    return self.send_json(
                        {"error": "wrong pairing code"},
                        status=401)
                pair_join_record(ip, True, _time.time())
                token = _secrets.token_hex(16)
                role = ("viewer" if PAIR_POLICY["viewOnly"]
                        else "editor")
                PAIR_TOKENS[token] = (role,
                                      _time.time())
                return self.send_json(
                    {"ok": True, "token": token,
                     "role": role})
            if parsed.path == "/api/model/download":
                data = self.read_json()
                mid = str(data.get("id", "7b"))
                if mid not in MODEL_CATALOG:
                    raise ValueError("unknown model: " + mid)
                if DL_STATE["state"] in ("downloading",
                                         "verifying"):
                    return self.send_json({**DL_STATE})
                import threading
                threading.Thread(
                    target=_dl_worker, args=(mid,),
                    daemon=True).start()
                return self.send_json({**DL_STATE,
                                       "state": "downloading"})
            if parsed.path == "/api/llama/download":
                if llama_present():
                    return self.send_json(
                        {**LLAMA_DL_STATE, "present": True})
                if LLAMA_DL_STATE["state"] in ("downloading",
                                               "verifying"):
                    return self.send_json({**LLAMA_DL_STATE})
                import threading
                threading.Thread(
                    target=_llama_dl_worker,
                    daemon=True).start()
                return self.send_json({**LLAMA_DL_STATE,
                                       "state": "downloading"})
            if parsed.path == "/api/embed/download":
                # Desktop Cycle 3, D5: fetch the embedding
                # model (on demand only, never silent; the
                # GET form above reports progress).
                if _embed_model_present():
                    return self.send_json(
                        {**EMBED_DL_STATE,
                         "downloaded": True})
                if EMBED_DL_STATE["state"] in (
                        "downloading", "verifying"):
                    return self.send_json(
                        {**EMBED_DL_STATE})
                import threading
                threading.Thread(
                    target=_embed_dl_worker,
                    daemon=True).start()
                return self.send_json(
                    {**EMBED_DL_STATE,
                     "state": "downloading"})
            if parsed.path == "/api/models/download":
                # D6: the store's download (and resume)
                # action for any catalog chat model or
                # the embedding model, on the existing
                # verified workers.
                data = self.read_json()
                return self.send_json(
                    _start_store_download(
                        str(data.get("id", ""))))
            if parsed.path == "/api/models/pause":
                data = self.read_json()
                return self.send_json(
                    _pause_download(
                        str(data.get("id", ""))))
            if parsed.path == "/api/models/cancel":
                data = self.read_json()
                return self.send_json(
                    _cancel_download(
                        str(data.get("id", ""))))
            if parsed.path == "/api/models/delete":
                # D6: host-only (removes files from the
                # host's model library).
                if not _models_host_only(self):
                    return
                data = self.read_json()
                return self.send_json(
                    _delete_model(
                        str(data.get("id", "")),
                        stop=bool(data.get("stop"))))
            if parsed.path == "/api/models/import":
                # D6: host-only (reads a file path on
                # the host, or fetches a URL into the
                # host's model library).
                if not _models_host_only(self):
                    return
                data = self.read_json()
                if data.get("url"):
                    return self.send_json(
                        _start_url_import(
                            str(data.get("url")),
                            data.get("name")))
                return self.send_json(
                    _import_local(
                        str(data.get("path", "")),
                        data.get("name")))
            if parsed.path == "/api/models/active":
                data = self.read_json()
                return self.send_json(
                    _set_active_model(
                        str(data.get("id", ""))))
            if parsed.path == "/api/model/start":
                return self.send_json(start_model())
            if parsed.path == "/api/agent-runs":
                # D2: store one run record (data only; see
                # the note at _save_agent_run). Oversize
                # bodies are refused before parsing.
                cls = self.headers.get_all("Content-Length") \
                    or []
                raw_len = 0
                if len(cls) == 1:
                    try:
                        raw_len = int(cls[0])
                    except Exception:
                        raw_len = 0
                if raw_len > AGENT_RUN_MAX_BYTES:
                    return self.send_json(
                        {"error": "run record too large "
                                  "(limit %d bytes)"
                                  % AGENT_RUN_MAX_BYTES},
                        status=413)
                data = self.read_json()
                path = _save_agent_run(data, raw_len)
                return self.send_json({"ok": True, "path": path})
            if parsed.path == "/api/tasks" \
                    or parsed.path == "/api/tasks/update":
                # S1: create (or, on /update, replace) one
                # task record - data only; see the note at
                # _validate_task. Oversize bodies are
                # refused before parsing, like run records.
                cls = self.headers.get_all("Content-Length") \
                    or []
                raw_len = 0
                if len(cls) == 1:
                    try:
                        raw_len = int(cls[0])
                    except Exception:
                        raw_len = 0
                if raw_len > TASK_MAX_BYTES:
                    return self.send_json(
                        {"error": "task record too large "
                                  "(limit %d bytes)"
                                  % TASK_MAX_BYTES},
                        status=413)
                data = self.read_json()
                try:
                    path = _save_task(
                        data, raw_len,
                        must_exist=parsed.path.endswith(
                            "/update"))
                except FileNotFoundError:
                    return self.send_json(
                        {"error": "no such task record"},
                        status=404)
                except FileExistsError as e:
                    return self.send_json(
                        {"error": str(e)}, status=409)
                except ValueError as e:
                    return self.send_json(
                        {"error": str(e)}, status=400)
                return self.send_json(
                    {"ok": True, "path": path, "record": data})
            if parsed.path == "/api/file":
                data = self.read_json()
                p = safe_path(data["path"])
                p.parent.mkdir(parents=True, exist_ok=True)
                snapshot_history(p, data.get("content", ""))
                # Cycle 3 I11: atomic write - temp file in
                # the same folder, then os.replace, so a
                # crash mid-save can never leave a torn
                # file (the snapshot stays the recovery
                # for everything else). Closes the A14
                # residual noted since Cycle 1.
                tmp = p.parent / (".%s.tmp-%d"
                                  % (p.name, os.getpid()))
                try:
                    tmp.write_text(data.get("content", ""))
                    os.replace(tmp, p)
                finally:
                    try:
                        tmp.unlink()
                    except OSError:
                        pass
                return self.send_json({"ok": True, "path": data["path"]})
            if parsed.path == "/api/dir":
                data = self.read_json()
                p = safe_path(data["path"])
                if p == WORKSPACE:
                    raise ValueError("workspace root already exists")
                p.mkdir(parents=True, exist_ok=True)
                return self.send_json({"ok": True, "path": data["path"]})
            if parsed.path == "/api/file/rename":
                data = self.read_json()
                src = safe_path(data["from"])
                dst = safe_path(data["to"])
                if not src.exists():
                    raise ValueError("no such file: " + data["from"])
                if dst.exists():
                    raise ValueError("already exists: " + data["to"])
                dst.parent.mkdir(parents=True, exist_ok=True)
                src.rename(dst)
                return self.send_json({"ok": True, "path": data["to"]})
            if parsed.path == "/api/backup/create":
                data = self.read_json()
                pw = str(data.get("passphrase", ""))
                if len(pw) < 8:
                    raise ValueError(
                        "passphrase needs at least 8 characters")
                import io
                import zipfile
                buf = io.BytesIO()
                total = 0
                count = 0
                with zipfile.ZipFile(buf, "w",
                                     zipfile.ZIP_DEFLATED) as z:
                    for p in sorted(WORKSPACE.rglob("*")):
                        rel = p.relative_to(WORKSPACE)
                        if any(part.startswith(".")
                               for part in rel.parts):
                            continue
                        if rel.parts and rel.parts[0] == "backups":
                            continue
                        if p.suffix == ".ghostbak":
                            continue
                        if not p.is_file():
                            continue
                        total += p.stat().st_size
                        count += 1
                        if total > 50 * 1024 * 1024:
                            raise ValueError(
                                "workspace is over the 50 MB "
                                "backup cap")
                        z.write(p, str(rel))
                env = backup_encrypt(pw, buf.getvalue(),
                                     count, total)
                # v2.34: refuse up front when the disk
                # cannot hold the envelope, instead of
                # dying mid-write with a truncated
                # .ghostbak left behind.
                import shutil as _sh_create
                if not _space_ok(
                        _sh_create.disk_usage(WORKSPACE).free,
                        len(env.encode("utf-8"))):
                    raise ValueError(
                        "not enough free space to write "
                        "the backup file")
                out_dir = WORKSPACE / "backups"
                out_dir.mkdir(exist_ok=True)
                name = ("ghostide-backup-"
                        + time.strftime("%Y%m%d-%H%M%S")
                        + ".ghostbak")
                (out_dir / name).write_text(env)
                return self.send_json({
                    "ok": True, "path": "backups/" + name,
                    "files": count, "bytes": total,
                    "size": len(env)})
            if parsed.path == "/api/backup/inspect":
                data = self.read_json()
                pw = str(data.get("passphrase", ""))
                p = safe_path(str(data.get("path", "")))
                if not p.is_file():
                    raise ValueError("backup file not found")
                env = json.loads(p.read_text())
                raw = backup_decrypt(pw, p.read_text())
                import io
                import zipfile
                paths = []
                sizes = []
                total = 0
                with zipfile.ZipFile(io.BytesIO(raw)) as z:
                    seen = set()
                    for info in z.infolist():
                        clean = _zipguard_clean(
                            info.filename)
                        if clean is None:
                            continue
                        if clean in seen:
                            raise ValueError(
                                "backup has a duplicate "
                                "entry: " + clean)
                        seen.add(clean)
                        # v2.34: directory entries
                        # count against the entry cap
                        # too, and sizes are counted
                        # from the actual stream, never
                        # the header (a header can lie;
                        # the preview must not
                        # understate a restore).
                        if len(seen) > _ZIP_MAX_ENTRIES:
                            raise ValueError(
                                "backup has too many "
                                "entries")
                        if info.is_dir():
                            continue
                        n = 0
                        with z.open(info) as src:
                            while True:
                                chunk = src.read(65536)
                                if not chunk:
                                    break
                                n += len(chunk)
                                if n > _ZIP_MAX_ENTRY:
                                    raise ValueError(
                                        "backup entry too "
                                        "large: " + clean)
                        paths.append(clean)
                        sizes.append(n)
                        total += n
                        if total > _ZIP_MAX_TOTAL:
                            raise ValueError(
                                "backup expands past the "
                                "512 MB restore cap")
                return self.send_json({
                    "ok": True,
                    "version": env.get("v", 0),
                    "appVersion": env.get("appVersion", ""),
                    "files": len(paths),
                    "bytes": total,
                    "created": env.get("created", "")})
            if parsed.path == "/api/backup/restore":
                data = self.read_json()
                pw = str(data.get("passphrase", ""))
                p = safe_path(str(data.get("path", "")))
                if not p.is_file():
                    raise ValueError("backup file not found")
                raw = backup_decrypt(pw, p.read_text())
                import io
                import shutil
                import zipfile
                # v2.34: count the archive first (real
                # streamed bytes, directory entries
                # included) and refuse before a single
                # staging byte is written when the
                # disk cannot hold the restore.
                scan_total = 0
                scan_seen = set()
                with zipfile.ZipFile(io.BytesIO(raw)) as z:
                    for info in z.infolist():
                        clean = _zipguard_clean(
                            info.filename)
                        if clean is None:
                            continue
                        if clean in scan_seen:
                            raise ValueError(
                                "backup has a duplicate "
                                "entry: " + clean)
                        scan_seen.add(clean)
                        if len(scan_seen) > _ZIP_MAX_ENTRIES:
                            raise ValueError(
                                "backup has too many "
                                "entries")
                        if info.is_dir():
                            continue
                        n = 0
                        with z.open(info) as src:
                            while True:
                                chunk = src.read(65536)
                                if not chunk:
                                    break
                                n += len(chunk)
                                if n > _ZIP_MAX_ENTRY:
                                    raise ValueError(
                                        "backup entry too "
                                        "large: " + clean)
                        scan_total += n
                        if scan_total > _ZIP_MAX_TOTAL:
                            raise ValueError(
                                "backup expands past "
                                "the 512 MB restore cap")
                if not _space_ok(
                        shutil.disk_usage(WORKSPACE).free,
                        scan_total):
                    raise ValueError(
                        "not enough free space to restore "
                        "this backup")
                root = WORKSPACE / ".ghostide-restore"
                stage = root / "stage"
                roll = root / "rollback"
                # v2.33: finish any interrupted
                # restore before this one starts.
                _restore_reconcile()
                shutil.rmtree(root, ignore_errors=True)
                stage.mkdir(parents=True)
                paths = []
                total = 0
                try:
                    with zipfile.ZipFile(io.BytesIO(raw)) as z:
                        seen = set()
                        for info in z.infolist():
                            clean = _zipguard_clean(
                                info.filename)
                            if clean is None:
                                continue
                            if clean in seen:
                                raise ValueError(
                                    "backup has a duplicate "
                                    "entry: " + clean)
                            seen.add(clean)
                            # v2.34: seen holds every
                            # entry (dirs included), so
                            # the cap counts directories
                            # too, like the scan pass.
                            if len(seen) > _ZIP_MAX_ENTRIES:
                                raise ValueError(
                                    "backup has too many "
                                    "entries")
                            out_f = stage.joinpath(
                                *clean.split("/"))
                            if info.is_dir():
                                out_f.mkdir(parents=True,
                                            exist_ok=True)
                                continue
                            out_f.parent.mkdir(parents=True,
                                               exist_ok=True)
                            n = 0
                            with z.open(info) as src, \
                                    open(out_f, "wb") as dst:
                                while True:
                                    chunk = src.read(65536)
                                    if not chunk:
                                        break
                                    dst.write(chunk)
                                    n += len(chunk)
                                    if n > _ZIP_MAX_ENTRY:
                                        raise ValueError(
                                            "backup entry too "
                                            "large: " + clean)
                            paths.append(clean)
                            total += n
                            if total > _ZIP_MAX_TOTAL:
                                raise ValueError(
                                    "backup expands past "
                                    "the 512 MB restore cap")
                    # v2.33: journal the apply BEFORE
                    # it starts (manifest, which files
                    # already exist, which parent dirs
                    # the apply will create).
                    _ws_res = WORKSPACE.resolve()
                    _pre = []
                    _dirs = set()
                    for clean in paths:
                        _dst = WORKSPACE.joinpath(
                            *clean.split("/"))
                        if _dst.is_file():
                            _pre.append(clean)
                        _parts = clean.split("/")
                        for _i in range(
                                len(_parts) - 1):
                            _prefix = "/".join(
                                _parts[:_i + 1])
                            if not WORKSPACE.joinpath(
                                    *_prefix.split("/")
                                    ).is_dir():
                                _dirs.add(_prefix)
                    _restore_journal_append(root, {
                        "op": "begin",
                        "manifest": list(paths),
                        "preexisting": _pre,
                        "dirs": sorted(_dirs)})
                    applied = []
                    try:
                        for clean in paths:
                            src = stage.joinpath(
                                *clean.split("/"))
                            dst = WORKSPACE.joinpath(
                                *clean.split("/"))
                            rb = roll.joinpath(
                                *clean.split("/"))
                            # v2.33 (scout F7): the
                            # apply target itself is
                            # containment-checked, so
                            # a pre-existing symlink
                            # dir cannot carry a
                            # restored file outside
                            # the workspace.
                            _dst_res = dst.resolve()
                            if not (_dst_res == _ws_res
                                    or _ws_res
                                    in _dst_res.parents):
                                raise ValueError(
                                    "restore target "
                                    "escapes workspace: "
                                    + clean)
                            dst.parent.mkdir(parents=True,
                                             exist_ok=True)
                            if dst.is_file():
                                rb.parent.mkdir(parents=True,
                                                exist_ok=True)
                                _restore_journal_append(
                                    root,
                                    {"op": "moved-out",
                                     "path": clean})
                                shutil.move(str(dst), str(rb))
                            _restore_journal_append(
                                root,
                                {"op": "applied",
                                 "path": clean})
                            shutil.move(str(src), str(dst))
                            applied.append(clean)
                    except Exception as e:
                        for clean in reversed(applied):
                            dst = WORKSPACE.joinpath(
                                *clean.split("/"))
                            rb = roll.joinpath(
                                *clean.split("/"))
                            try:
                                if dst.is_file():
                                    dst.unlink()
                                if rb.is_file():
                                    dst.parent.mkdir(
                                        parents=True,
                                        exist_ok=True)
                                    shutil.move(str(rb),
                                                str(dst))
                            except Exception:
                                pass
                        try:
                            _restore_journal_append(
                                root,
                                {"op": "rolled-back"})
                        except Exception:
                            pass
                        raise ValueError(
                            "restore failed and was "
                            "rolled back: %s" % e)
                    _restore_journal_append(
                        root, {"op": "done"})
                finally:
                    shutil.rmtree(root, ignore_errors=True)
                return self.send_json({
                    "ok": True, "files": len(paths),
                    "bytes": total, "staged": True})
            if parsed.path == "/api/pair/heartbeat":
                data = self.read_json()
                pid = str(data.get("id", ""))[:64]
                if pid:
                    PAIR_PEERS[pid] = {
                        "id": pid,
                        "name": str(data.get("name", "device"))[:40],
                        "file": str(data.get("file", ""))[:300],
                        "dirty": bool(data.get("dirty")),
                        "seen": time.time(),
                    }
                return self.send_json({"peers": pair_snapshot()})
            if parsed.path == "/api/file/delete":
                data = self.read_json()
                p = safe_path(data["path"])
                if p == WORKSPACE:
                    raise ValueError("cannot delete the workspace root")
                if not p.exists():
                    raise ValueError("no such file: " + data["path"])
                if p.is_dir():
                    shutil.rmtree(p)
                else:
                    p.unlink()
                return self.send_json({"ok": True, "path": data["path"]})
            if parsed.path == "/api/workspace":
                data = self.read_json()
                p = Path(data["path"]).expanduser().resolve()
                if not p.is_dir():
                    raise ValueError("not a folder: " + data["path"])
                WORKSPACE = p
                _term_kill()
                _repl_kill()
                # D4: language servers belong to the old
                # workspace (rootUri, open documents); a
                # switch restarts them against the new one
                # on next use.
                if _LSP is not None:
                    _LSP.shutdown_all()
                return self.send_json({
                    "ok": True, "workspace": str(p),
                    "trusted": workspace_trusted()})
            if parsed.path == "/api/trust":
                # D7: trust is decided on the host, never
                # by a pair guest.
                if self.client_address[0] not in ("127.0.0.1",
                                                  "::1"):
                    return self.send_json(
                        {"error": "trust is decided "
                                  "on the host"}, status=403)
                data = self.read_json()
                TRUST_STORE.set(WORKSPACE,
                                bool(data.get("trusted")),
                                source="user")
                return self.send_json({
                    "ok": True, "workspace": str(WORKSPACE),
                    "trusted": workspace_trusted()})
            # D4: language server bridge. These routes
            # are already behind TRUST_EXEC_ROUTES above;
            # the manager also re-checks trust itself
            # before starting any process.
            if parsed.path == "/api/lsp/open":
                return self._lsp_post("open")
            if parsed.path == "/api/lsp/change":
                return self._lsp_post("change")
            if parsed.path == "/api/lsp/close":
                return self._lsp_post("close")
            if parsed.path == "/api/lsp/save":
                return self._lsp_post("save")
            if parsed.path == "/api/lsp/hover":
                return self._lsp_post("hover")
            if parsed.path == "/api/lsp/definition":
                return self._lsp_post("definition")
            if parsed.path == "/api/lsp/completion":
                return self._lsp_post("completion")
            if parsed.path == "/api/lsp/symbols":
                return self._lsp_post("symbols")
            if parsed.path == "/api/lsp/restart":
                return self._lsp_post("restart")
            if parsed.path == "/api/lsp/install":
                return self._lsp_post("install")
            if parsed.path == "/api/update/download":
                # D3: download + verify + stage in the
                # background; the UI polls /api/update/status.
                if not FROZEN:
                    return self.send_json(
                        {"error": "source runs are "
                                  "report-only; updates apply "
                                  "to the packaged app"},
                        status=400)
                get_updater().download_async()
                return self.send_json(get_updater().status())
            if parsed.path == "/api/update/apply":
                try:
                    return self.send_json(
                        get_updater().mark_apply_pending())
                except Exception as e:
                    return self.send_json(
                        {"error": str(e)}, status=400)
            if parsed.path == "/api/update/rollback":
                try:
                    return self.send_json(
                        get_updater().mark_rollback_pending())
                except Exception as e:
                    return self.send_json(
                        {"error": str(e)}, status=400)
            if parsed.path == "/api/update/settings":
                data = self.read_json()
                st = get_updater().set_settings(
                    bool(data.get("checkOnLaunch", True)))
                return self.send_json({"ok": True,
                                       "settings": st})
            if parsed.path == "/api/context":
                data = self.read_json()
                if data.get("mode") == "smart":
                    return self.send_json(make_smart_context(
                        data.get("seed"),
                        data.get("budget", CTX_BUDGET_DEFAULT)))
                return self.send_json(make_context(
                    data.get("mode", "signatures"),
                    data.get("budget", CTX_BUDGET_DEFAULT)))
            if parsed.path == "/api/run":
                data = self.read_json()
                p = safe_path(data["path"])
                if not p.is_file():
                    raise ValueError("no such file: " + data["path"])
                runners = {".py": py_cmd(), ".js": ["node"],
                           ".sh": ["bash"], ".mjs": ["node"]}
                ext = p.suffix.lower()
                if ext == ".sql":
                    # Roadmap G21: SQL runs on an in-memory
                    # database; query results print as rows.
                    cmd = [py_cmd()[0], "-c", SQL_RUNNER]
                elif ext == ".go":
                    if not shutil.which("go"):
                        raise ValueError(
                            "Go is not installed on this machine, "
                            "so .go files cannot run here yet.")
                    cmd = ["go", "run"]
                elif ext == ".rs":
                    if not shutil.which("rustc"):
                        raise ValueError(
                            "Rust is not installed on this "
                            "machine, so .rs files cannot run "
                            "here yet. Install rustc to enable "
                            "Rust runs.")
                    import tempfile
                    tmpd = tempfile.mkdtemp(prefix="ghostide-rs-")
                    binp = os.path.join(tmpd, "prog")
                    rc2, o2, e2, _ms2 = run_cmd(
                        ["rustc", "--edition", "2021", "-o", binp,
                         str(p)], WORKSPACE, timeout=60)
                    if rc2 != 0:
                        shutil.rmtree(tmpd, ignore_errors=True)
                        return self.send_json({
                            "ok": True, "code": rc2,
                            "stdout": o2[-32768:],
                            "stderr": e2[-8192:], "ms": 0,
                            "cmd": "rustc " + data["path"]})
                    rc, out, err, ms = run_cmd(
                        [binp], WORKSPACE, timeout=20)
                    shutil.rmtree(tmpd, ignore_errors=True)
                    return self.send_json({
                        "ok": True, "code": rc,
                        "stdout": out[-32768:],
                        "stderr": err[-8192:], "ms": ms,
                        "cmd": "rustc + run " + data["path"]})
                else:
                    cmd = runners.get(ext)
                if cmd is None:
                    raise ValueError(
                        "no runner for %s files (runners: .py .js "
                        ".sh .go .sql .rs)" % (p.suffix or "(none)"))
                rc, out, err, ms = run_cmd(cmd + [str(p)], WORKSPACE,
                                           timeout=20)
                return self.send_json({
                    "ok": True, "code": rc, "stdout": out[-32768:],
                    "stderr": err[-8192:], "ms": ms,
                    "cmd": " ".join(cmd + [data["path"]])})
            if parsed.path == "/api/git/init":
                # Roadmap G11: create the repo (the panel's Init
                # button). Plain `git init` works on every git.
                rc, out, err, _ = git_out(["init"])
                if rc != 0:
                    raise ValueError(err.strip()[:300]
                                     or "git init failed")
                return self.send_json({"ok": True,
                                       "output": out.strip()})
            if parsed.path == "/api/git/tag":
                # Cycle 8 I11: create / delete a tag.
                # Names ride the branch pin (same ref
                # charset); a target hash is hex-pinned
                # like the commit viewer's.
                data = self.read_json()
                action = data.get("action") or ""
                name = (data.get("name") or "").strip()
                if not _branch_name_ok(name):
                    raise ValueError("bad tag name")
                if action == "create":
                    args = ["tag", name]
                    th = (data.get("hash") or "").strip()
                    if th:
                        if not _re_mod.fullmatch(
                                r"[0-9a-f]{7,40}", th):
                            raise ValueError("bad commit hash")
                        args.append(th)
                elif action == "delete":
                    args = ["tag", "-d", name]
                else:
                    raise ValueError("unknown tag action")
                rc, out, err, _ = git_out(args)
                if rc != 0:
                    raise ValueError(
                        (err or out).strip()[:300]
                        or "git tag failed")
                return self.send_json({"ok": True})
            if parsed.path == "/api/git/amend":
                # Cycle 8 I13: fold staged changes into
                # HEAD, optionally rewording it. Git
                # refuses on a repo with no commits;
                # that refusal surfaces as-is.
                data = self.read_json()
                msg = (data.get("message") or "").strip()
                args = ["commit", "--amend"]
                if msg:
                    args += ["-m", msg[:200]]
                else:
                    args.append("--no-edit")
                rc, out, err, _ = git_out(args)
                if rc != 0:
                    raise ValueError(
                        (err or out).strip()[:300]
                        or "git amend failed")
                return self.send_json({"ok": True})
            if parsed.path == "/api/git/stash":
                # Cycle 7 I6: push / apply / pop / drop.
                # The index is pinned to a small int and
                # rebuilt into the ref here - a raw ref
                # string from the client never reaches
                # the command line.
                data = self.read_json()
                action = data.get("action") or ""
                if action == "push":
                    msg = (data.get("message") or
                           "GhostIDE stash").strip()[:120]
                    args = ["stash", "push", "-m", msg or
                            "GhostIDE stash"]
                    if data.get("untracked"):
                        args.append("-u")
                elif action in ("apply", "pop", "drop"):
                    idx = data.get("index")
                    if (isinstance(idx, bool)
                            or not isinstance(idx, int)
                            or idx < 0 or idx > 99):
                        raise ValueError("bad stash index")
                    args = ["stash", action,
                            "stash@{%d}" % idx]
                else:
                    raise ValueError("unknown stash action")
                rc, out, err, _ = git_out(args)
                if rc != 0:
                    raise ValueError(
                        (err or out).strip()[:300]
                        or "git stash failed")
                if action == "push" and \
                        "No local changes" in (out or ""):
                    # git exits 0 having stashed nothing
                    # (e.g. only untracked files differ);
                    # saying ok would be a lie.
                    raise ValueError(
                        "nothing to stash: no tracked "
                        "changes (tick 'include untracked' "
                        "for new files)")
                return self.send_json({"ok": True})
            if parsed.path == "/api/git/branch":
                # Cycle 7 I2: create / delete / switch.
                # The name is pinned (see _branch_name_ok);
                # git itself refuses a switch that would
                # clobber work, and its refusal surfaces.
                data = self.read_json()
                action = data.get("action") or ""
                name = (data.get("name") or "").strip()
                if not _branch_name_ok(name):
                    raise ValueError("bad branch name")
                if action == "create":
                    args = (["switch", "-c", name]
                            if data.get("switch")
                            else ["branch", name])
                elif action == "delete":
                    rc0, out0, _, _ = git_out(
                        ["branch", "--show-current"])
                    if out0.strip() == name:
                        raise ValueError(
                            "cannot delete the current branch")
                    args = ["branch", "-d", name]
                elif action == "switch":
                    args = ["switch", name]
                else:
                    raise ValueError("unknown branch action")
                rc, out, err, _ = git_out(args)
                if rc != 0:
                    raise ValueError(
                        (err or out).strip()[:300]
                        or "git branch failed")
                return self.send_json({"ok": True})
            if parsed.path == "/api/git/stage":
                data = self.read_json()
                if data["path"] != ".":
                    safe_path(data["path"])
                rc, out, err, _ = git_out(["add", "--", data["path"]])
                if rc != 0:
                    raise ValueError(err.strip()[:300] or "git add failed")
                return self.send_json({"ok": True})
            if parsed.path == "/api/git/hunks/apply":
                # D9: stage / unstage / discard the
                # selected hunks only. The expect block
                # is the stale-selection guard: the diff
                # is re-read and any drift refuses.
                data = self.read_json()
                return self.send_json(git_apply_hunks(
                    data.get("path") or "",
                    data.get("area") or "worktree",
                    data.get("action") or "",
                    data.get("hunks") or [],
                    data.get("expect") or {}))
            if parsed.path == "/api/git/conflict/resolve":
                # D9: save the conflict editor's result
                # and stage it. Committing or continuing
                # the operation stays the user's step.
                data = self.read_json()
                content = data.get("content")
                if not isinstance(content, str):
                    raise ValueError(
                        "resolved content missing")
                return self.send_json(git_conflict_resolve(
                    data.get("path") or "", content))
            if parsed.path == "/api/git/checkout":
                # Discard a file's uncommitted changes (VS Code's
                # per-file Revert). Staged or not, back to HEAD.
                data = self.read_json()
                safe_path(data["path"])
                rc, out, err, _ = git_out(
                    ["checkout", "HEAD", "--", data["path"]])
                if rc != 0:
                    raise ValueError(err.strip()[:300]
                                     or "git checkout failed")
                return self.send_json({"ok": True})
            if parsed.path == "/api/git/commit":
                data = self.read_json()
                msg = (data.get("message") or "").strip()
                if not msg:
                    raise ValueError("commit message is empty")
                rc, out, err, _ = git_out(["commit", "-m", msg])
                if rc != 0:
                    raise ValueError((err or out).strip()[:400] or
                                     "git commit failed")
                return self.send_json({"ok": True, "output": out.strip()})
            if parsed.path == "/api/git/remote-set":
                data = self.read_json()
                name = (data.get("name") or "origin").strip()
                url = (data.get("url") or "").strip()
                if not name or name.startswith("-"):
                    raise ValueError("bad remote name")
                if not url or url.startswith("-"):
                    raise ValueError("bad remote url")
                rc, out, err, _ = git_out(["remote"])
                if rc != 0:
                    raise ValueError(err.strip()[:300]
                                     or "not a git repo")
                if name in out.split():
                    rc, out, err, _ = git_out(
                        ["remote", "set-url", name, url])
                else:
                    rc, out, err, _ = git_out(
                        ["remote", "add", name, url])
                if rc != 0:
                    raise ValueError(err.strip()[:300]
                                     or "git remote failed")
                return self.send_json({"ok": True})
            if parsed.path == "/api/git/clone":
                data = self.read_json()
                url = (data.get("url") or "").strip()
                if not url or url.startswith("-"):
                    raise ValueError("bad clone url")
                target = (data.get("dir") or "").strip() \
                    or repo_name_from_url(url)
                if not target:
                    raise ValueError("cannot name the target folder")
                safe_path(target)
                dest = WORKSPACE / target
                if dest.exists() and any(dest.iterdir()):
                    raise ValueError(
                        "target folder exists and is not empty: "
                        + target)
                # Mobile Cycle 2 (M4): shallow by default
                # (depth 1, single branch), full history
                # only on the explicit opt-in - the same
                # arguments GitSupport.cloneArgs builds on
                # the phone for the same request body.
                clone_args = ["clone"]
                if not data.get("full"):
                    try:
                        depth = int(data.get("depth") or 0)
                    except (TypeError, ValueError):
                        depth = 0
                    clone_args += ["--depth",
                                   str(depth if depth > 0
                                       else 1),
                                   "--single-branch"]
                clone_args += [url, target]
                rc, out, err, _ = git_net(
                    clone_args,
                    token=(data.get("token") or "").strip(),
                    timeout=300)
                if rc != 0:
                    raise ValueError((err or out).strip()[:400]
                                     or "git clone failed")
                return self.send_json({"ok": True, "dir": target,
                                       "output": out.strip()[-300:]})
            if parsed.path == "/api/git/fetch":
                data = self.read_json()
                args = ["fetch"]
                remote = (data.get("remote") or "").strip()
                if remote:
                    if remote.startswith("-"):
                        raise ValueError("bad remote name")
                    args.append(remote)
                rc, out, err, _ = git_net(
                    args, token=(data.get("token") or "").strip())
                if rc != 0:
                    raise ValueError((err or out).strip()[:400]
                                     or "git fetch failed")
                return self.send_json(
                    {"ok": True, "output": (out + err).strip()[-300:]})
            if parsed.path == "/api/git/pull":
                data = self.read_json()
                rc, out, err, _ = git_net(
                    ["pull"], token=(data.get("token") or "").strip())
                if rc != 0:
                    raise ValueError((err or out).strip()[:400]
                                     or "git pull failed")
                return self.send_json(
                    {"ok": True, "output": (out + err).strip()[-300:]})
            if parsed.path == "/api/git/push":
                data = self.read_json()
                token = (data.get("token") or "").strip()
                rc, _, _, _ = git_out(
                    ["rev-parse", "--abbrev-ref",
                     "--symbolic-full-name", "@{u}"])
                args = ["push"] if rc == 0 else \
                    ["push", "-u", "origin", "HEAD"]
                rc, out, err, _ = git_net(args, token=token)
                if rc != 0:
                    raise ValueError((err or out).strip()[:400]
                                     or "git push failed")
                return self.send_json(
                    {"ok": True, "output": (out + err).strip()[-300:]})
            if parsed.path == "/api/search":
                data = self.read_json()
                q = data.get("query", "")
                if not q:
                    raise ValueError("empty search")
                # Cycle 7 I11: case + regex options.
                # Defaults keep the historic behavior
                # (case-sensitive substring); a bad
                # regex is a clean error, never a crash,
                # and the pattern is length-capped.
                if len(q) > 200:
                    raise ValueError(
                        "search pattern too long (200 max)")
                ign = bool(data.get("ignoreCase"))
                pat = None
                if data.get("regex"):
                    try:
                        pat = _re_mod.compile(
                            q, _re_mod.IGNORECASE if ign else 0)
                    except Exception as e:
                        raise ValueError(
                            "bad regex: " + str(e)[:120])
                ql = q.lower()
                matches = []
                for rel, p in iter_text_files():
                    try:
                        text = p.read_text(errors="strict")
                    except Exception:
                        continue
                    for i, line in enumerate(text.splitlines(), 1):
                        if pat is not None:
                            hit = pat.search(line) is not None
                        elif ign:
                            hit = ql in line.lower()
                        else:
                            hit = q in line
                        if hit:
                            matches.append({"path": str(rel), "line": i,
                                            "text": line.strip()[:200]})
                            if len(matches) >= 200:
                                break
                    if len(matches) >= 200:
                        break
                return self.send_json({"matches": matches,
                                       "truncated": len(matches) >= 200})
            if parsed.path == "/api/eco/run":
                data = self.read_json()
                try:
                    out = eco_run(str(data.get("tool") or ""),
                                  WORKSPACE)
                    return self.send_json({"ok": True,
                                           "output": out})
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/toolrun":
                # Track B: one-shot report runners for the
                # bundled tools (see eco_toolrun).
                data = self.read_json()
                try:
                    out = eco_toolrun(str(data.get("tool") or ""),
                                      WORKSPACE,
                                      str(data.get("path") or ""))
                    return self.send_json({"ok": True,
                                           "output": out})
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/board":
                # E17: GhostConsole board model.
                try:
                    return self.send_json(eco_board(WORKSPACE))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/studio":
                # E18/E19: recipes / leads / quoteshot.
                data = self.read_json()
                try:
                    out = eco_studio(
                        str(data.get("tool") or ""),
                        str(data.get("verb") or ""),
                        str(data.get("arg") or ""),
                        str(data.get("arg2") or ""), WORKSPACE)
                    return self.send_json({"ok": True,
                                           "output": out})
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/replay/save":
                # E16: record an agent run's action trail.
                data = self.read_json()
                try:
                    return self.send_json(replay_save(
                        data.get("task"),
                        data.get("trail"), WORKSPACE,
                        data.get("elapsed_s")))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/replay/list":
                # Cycle 3 I18 fix: the panel POSTs (the
                # phone has always served POST); the
                # desktop only had the GET twin, so the
                # desktop Replay panel silently showed
                # zero runs since E16. POST now mirrors
                # GET; both stay available.
                return self.send_json(replay_list(WORKSPACE))
            if parsed.path == "/api/eco/replay/get":
                data = self.read_json()
                try:
                    return self.send_json(replay_get(
                        WORKSPACE, data.get("id") or ""))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/datapack":
                # I14: full GhostData pack for a data file.
                data = self.read_json()
                try:
                    out = eco_datapack(
                        str(data.get("path") or ""), WORKSPACE)
                    return self.send_json({"ok": True,
                                           "output": out})
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/datapacks":
                # Cycle 2 I13: the packs this workspace holds.
                gi = WORKSPACE / ".ghostide"
                packs = []
                if gi.is_dir():
                    for d in sorted(
                            gi.glob("data-pack-*"),
                            key=lambda p: p.stat().st_mtime,
                            reverse=True):
                        if d.is_dir():
                            packs.append({
                                "name": d.name,
                                "files": sum(
                                    1 for _ in d.rglob("*")
                                    if _.is_file()),
                                "mtime": int(
                                    d.stat().st_mtime)})
                return self.send_json({"packs": packs})
            if parsed.path == "/api/eco/datapack/delete":
                # Cycle 2 I13: remove one pack. The name is
                # pinned to the data-pack- namespace inside
                # .ghostide; nothing else can be named.
                data = self.read_json()
                name = str(data.get("name") or "")
                if not _re_mod.fullmatch(
                        r"data-pack-[A-Za-z0-9_.-]+", name) \
                        or ".." in name:
                    return self.send_json(
                        {"error": "not a pack name"}, 400)
                target = (WORKSPACE / ".ghostide"
                          / name)
                if not target.is_dir():
                    return self.send_json(
                        {"error": "no such pack"}, 400)
                import shutil as _sh
                _sh.rmtree(target)
                return self.send_json({"ok": True})
            if parsed.path == "/api/eco/datapack/view":
                # Cycle 3 I4: read a pack's prompt summary.
                # Same namespace pin as delete; reads stay
                # inside the pack directory.
                data = self.read_json()
                name = str(data.get("name") or "")
                if not _re_mod.fullmatch(
                        r"data-pack-[A-Za-z0-9_.-]+", name) \
                        or ".." in name:
                    return self.send_json(
                        {"error": "not a pack name"}, 400)
                pack = (WORKSPACE / ".ghostide" / name)
                if not pack.is_dir():
                    return self.send_json(
                        {"error": "no such pack"}, 400)
                doc = pack / "PROMPT.md"
                if not doc.is_file():
                    mds = sorted(pack.glob("*.md"))
                    doc = mds[0] if mds else None
                if doc is None:
                    return self.send_json(
                        {"error": "the pack has no readable "
                                  "summary"}, 400)
                return self.send_json({
                    "ok": True,
                    "output": doc.read_text(
                        encoding="utf-8",
                        errors="replace")[:40000]})
            if parsed.path == "/api/eco/slicelog":
                # E13: run output -> GhostLogs incident pack.
                data = self.read_json()
                try:
                    out = eco_slicelog(
                        str(data.get("text") or ""), WORKSPACE)
                    return self.send_json({"ok": True,
                                           "output": out})
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/rea/run":
                data = self.read_json()
                try:
                    out = rea_run(str(data.get("command") or ""),
                                  str(data.get("path") or ""),
                                  WORKSPACE)
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/git/review":
                # E8: GhostReview verdict over the diff.
                try:
                    return self.send_json(git_review(WORKSPACE))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/git/scope":
                # E9: GhostScope pack for the diff.
                try:
                    return self.send_json(git_scope(WORKSPACE))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/policy":
                if not _mcp_host_only(self):
                    return None
                data = self.read_json()
                try:
                    return self.send_json(mcp_policy_set(data))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/config/server":
                if not _mcp_host_only(self):
                    return None
                data = self.read_json()
                try:
                    out = mcp_save_user_server(
                        str(data.get("name") or ""),
                        data.get("entry") or {})
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/config/delete":
                if not _mcp_host_only(self):
                    return None
                data = self.read_json()
                try:
                    out = mcp_delete_user_server(
                        str(data.get("name") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/config/import":
                if not _mcp_host_only(self):
                    return None
                data = self.read_json()
                try:
                    out = mcp_import_config(
                        str(data.get("text") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/oauth/start":
                if not _mcp_host_only(self):
                    return None
                data = self.read_json()
                try:
                    out = mcp_oauth_start(
                        str(data.get("server") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/tools":
                data = self.read_json()
                try:
                    out = mcp_tools(str(data.get("server") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/call":
                data = self.read_json()
                try:
                    args = data.get("arguments")
                    if not isinstance(args, dict):
                        args = {}
                    out = mcp_call(str(data.get("server") or ""),
                                   str(data.get("tool") or ""),
                                   args)
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/resources":
                data = self.read_json()
                try:
                    out = mcp_resources(
                        str(data.get("server") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/resource":
                data = self.read_json()
                try:
                    out = mcp_resource(
                        str(data.get("server") or ""),
                        str(data.get("uri") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/restart":
                # Cycle 2 I15: drop every persistent
                # session; the next call respawns.
                # Cycle 3 I1: with a server name, drop
                # only that session via the daemon.
                data = self.read_json()
                server = str(data.get("server") or "")
                if server:
                    try:
                        _MCP_DAEMON.request(
                            {"verb": "drop",
                             "server": server})
                    except Exception:
                        pass  # no live session to drop
                    return self.send_json({"ok": True})
                _MCP_DAEMON._stop()
                globals()["_MCP_DAEMON_DOWN_UNTIL"] = 0.0
                return self.send_json({"ok": True})
            if parsed.path == "/api/mcp/sessions":
                # Cycle 2 I5: which servers the persistent
                # daemon holds open + calls served.
                try:
                    out = _MCP_DAEMON.request(
                        {"verb": "sessions"}, timeout=10)
                    return self.send_json(out)
                except Exception:
                    return self.send_json({"sessions": []})
            if parsed.path == "/api/mcp/prompts":
                data = self.read_json()
                try:
                    out = mcp_prompts(
                        str(data.get("server") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/mcp/prompt":
                data = self.read_json()
                try:
                    args = data.get("arguments")
                    if not isinstance(args, dict):
                        args = {}
                    out = mcp_prompt(
                        str(data.get("server") or ""),
                        str(data.get("name") or ""), args)
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/approve/enqueue":
                data = self.read_json()
                try:
                    out = approve_enqueue(
                        str(data.get("kind") or ""),
                        str(data.get("command") or ""),
                        str(data.get("path") or ""),
                        str(data.get("summary") or ""),
                        data.get("mcp"))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/approve/decide":
                data = self.read_json()
                try:
                    out = approve_decide(
                        str(data.get("id") or ""),
                        str(data.get("decision") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/git/worktree/add":
                data = self.read_json()
                try:
                    out = git_worktree_add(
                        str(data.get("name") or ""),
                        str(data.get("branch") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/git/worktree/remove":
                data = self.read_json()
                try:
                    out = git_worktree_remove(
                        str(data.get("path") or ""))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/ghostre/run":
                data = self.read_json()
                try:
                    out = ghostre_run(str(data.get("path") or ""),
                                      WORKSPACE)
                    return self.send_json({"ok": True,
                                           "output": out})
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/search":
                # Roadmap ECO E3: GhostIndex search in the
                # find panel (see eco_search).
                data = self.read_json()
                try:
                    out = eco_search(str(data.get("query") or ""),
                                     WORKSPACE,
                                     data.get("limit"),
                                     data.get("max_tokens"))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/prime":
                # Roadmap ECO E4: GhostPrimer chat action
                # (see eco_prime).
                self.read_json()
                try:
                    return self.send_json(eco_prime(WORKSPACE))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/handoff":
                # Roadmap ECO E4: GhostHandoff chat action
                # (see eco_handoff).
                self.read_json()
                try:
                    return self.send_json(eco_handoff(WORKSPACE))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/atlas":
                # Roadmap ECO E5: GhostAtlas repo-map view
                # (see eco_atlas).
                self.read_json()
                try:
                    return self.send_json(eco_atlas(WORKSPACE))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/recall":
                # Roadmap ECO E5: GhostRecall chat action
                # (see eco_recall).
                data = self.read_json()
                try:
                    out = eco_recall(
                        WORKSPACE,
                        str(data.get("task") or ""),
                        data.get("budget"),
                        bool(data.get("context")))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/eco/convert":
                # Roadmap ECO E6: GhostConvert export from
                # the Context lab (see eco_convert).
                data = self.read_json()
                try:
                    out = eco_convert(
                        WORKSPACE,
                        str(data.get("target") or "agents"),
                        str(data.get("mode") or "signatures"),
                        data.get("budget"),
                        bool(data.get("reuse_bundle")))
                    return self.send_json(out)
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            if parsed.path == "/api/classroom/start":
                # Roadmap G38: open the classroom.
                return self.send_json(_classroom_start())
            if parsed.path == "/api/classroom/publish":
                data = self.read_json()
                if not _classroom["host"] or \
                        data.get("host") != _classroom["host"]:
                    return self.send_json(
                        {"error": "not the classroom host"},
                        403)
                st = data.get("state") or {}
                st["ts"] = int(time.time() * 1000)
                _classroom["state"] = st
                return self.send_json({"ok": True})
            if parsed.path == "/api/classroom/stop":
                data = self.read_json()
                if data.get("host") == _classroom["host"]:
                    _classroom["code"] = None
                    _classroom["host"] = None
                    _classroom["state"] = None
                    _classroom["annotations"] = []
                return self.send_json({"ok": True})
            if parsed.path == "/api/classroom/annotate":
                data = self.read_json()
                if not _classroom["code"] or \
                        data.get("code") != _classroom["code"]:
                    return self.send_json(
                        {"error": "no classroom with that code"},
                        404)
                text = str(data.get("text") or "").strip()[:300]
                if not text:
                    raise ValueError("annotation text is empty")
                name = str(data.get("name") or "viewer")[:40]
                line = data.get("line")
                if not isinstance(line, int):
                    line = None
                _classroom["annotations"].append(
                    {"name": name, "line": line, "text": text,
                     "ts": int(time.time() * 1000)})
                _classroom["annotations"] = \
                    _classroom["annotations"][-50:]
                return self.send_json({"ok": True})
            if parsed.path == "/api/classroom/clear":
                data = self.read_json()
                if data.get("host") == _classroom["host"]:
                    _classroom["annotations"] = []
                return self.send_json({"ok": True})
            if parsed.path == "/api/verify/run":
                # Roadmap G32: the one-tap health pass.
                return self.send_json(_verify_run())
            if parsed.path == "/api/semsearch":
                # Roadmap G29: meaning search over the symbol
                # index. Chunks are functions/classes; ranking
                # combines identifier words, body terms, light
                # stemming, and a curated coding-concept table
                # (download ~ fetch/retrieve, retry ~ attempt/
                # backoff) so plain-English queries find code
                # that shares no words with the query. Honest
                # scope: this is lexical-semantic ranking, not
                # a neural embedding model.
                data = self.read_json()
                q = data.get("query", "")
                return self.send_json(
                    {"results": _sem_search(q)})
            if parsed.path == "/api/embed/search":
                # Desktop Cycle 3, D5: neural embedding
                # search over the workspace index (see
                # embed_search). Trust-gated: a search can
                # start the embedding server process.
                data = self.read_json()
                try:
                    return self.send_json(embed_search(
                        str(data.get("query") or ""),
                        data.get("limit")))
                except ValueError as e:
                    return self.send_json(
                        {"error": str(e)}, 400)
            if parsed.path == "/api/embed/build":
                # Desktop Cycle 3, D5: build or refresh the
                # neural index. Trust-gated: a build reads
                # the whole workspace and spawns the
                # embedding server. Progress is polled via
                # GET /api/embed/status.
                self.read_json()
                if EMBED_BUILD_STATE["state"] == "building":
                    return self.send_json(
                        dict(EMBED_BUILD_STATE))
                if not _embed_model_present():
                    return self.send_json(
                        {"error": "the embedding model is "
                                  "not downloaded yet - "
                                  "Settings has the "
                                  "download"}, 400)
                import threading
                threading.Thread(
                    target=_embed_build_worker,
                    daemon=True).start()
                return self.send_json(
                    {**EMBED_BUILD_STATE,
                     "state": "building"})
            if parsed.path == "/api/replace":
                data = self.read_json()
                q = data.get("query", "")
                rep = data.get("replacement", "")
                if not q:
                    raise ValueError("empty search")
                # Cycle 7 I14: dryRun counts without
                # writing, so Replace all can show its
                # blast radius before it fires.
                dry = bool(data.get("dryRun"))
                files_changed = 0
                total = 0
                for rel, p in iter_text_files():
                    try:
                        text = p.read_text(errors="strict")
                    except Exception:
                        continue
                    n = text.count(q)
                    if n:
                        if not dry:
                            p.write_text(text.replace(q, rep))
                        files_changed += 1
                        total += n
                return self.send_json({"filesChanged": files_changed,
                                       "replacements": total,
                                       "dryRun": dry})
            if parsed.path == "/api/debug/start":
                data = self.read_json()
                sid, ev = _dbg_start(data["path"],
                                     data.get("breakpoints", []))
                return self.send_json({"session": sid, "event": ev})
            if parsed.path == "/api/debug/cmd":
                data = self.read_json()
                ev = _dbg_cmd(data["session"], data["cmd"])
                return self.send_json({"event": ev})
            if parsed.path == "/api/debug/stop":
                data = self.read_json()
                _dbg_kill(data.get("session", ""))
                return self.send_json({"ok": True})
            if parsed.path == "/api/tests/run":
                data = self.read_json()
                want = data.get("path")
                # Cycle 8 I16: an optional single-test
                # name narrows the run to one test.
                only = data.get("name") or None
                if only and not want:
                    raise ValueError(
                        "a single-test run needs its file")
                targets = [f["path"] for f in discover_tests()
                           if not want or f["path"] == want]
                if want and not targets:
                    raise ValueError("not a test file: " + want)
                results = []
                t0 = time.time()
                for rel in targets:
                    results.extend(run_test_file(rel, only))
                passed = sum(1 for r in results
                             if r["status"] == "pass")
                return self.send_json({
                    "results": results, "passed": passed,
                    "failed": len(results) - passed,
                    "ms": int((time.time() - t0) * 1000)})
            if parsed.path == "/api/check-content":
                # Agent mode (G5): syntax-check content that has
                # not been written to disk yet.
                data = self.read_json()
                path = data.get("path", "")
                content = data.get("content", "")
                ext = Path(path).suffix.lower()
                result = {"ok": None,
                          "note": "no checker for " + (ext or "?")}
                if ext == ".py":
                    try:
                        _ast.parse(content)
                        result = {"ok": True}
                    except SyntaxError as e:
                        result = {"ok": False, "line": e.lineno,
                                  "message": "SyntaxError: "
                                             + (e.msg or "")}
                elif ext == ".json":
                    try:
                        json.loads(content)
                        result = {"ok": True}
                    except Exception as e:
                        result = {"ok": False, "message": str(e)}
                elif ext in (".js", ".mjs"):
                    tmpd = WORKSPACE / ".ghostide-tmp"
                    tmpd.mkdir(exist_ok=True)
                    tmpf = tmpd / ("check" + ext)
                    tmpf.write_text(content)
                    try:
                        rc, out, err, ms = run_cmd(
                            ["node", "--check", str(tmpf)],
                            cwd=str(WORKSPACE))
                        output = (out + err).strip()
                        if rc == 0:
                            result = {"ok": True}
                        else:
                            ln, msg = check_output_info(output)
                            result = {"ok": False, "line": ln,
                                      "message": msg}
                    finally:
                        tmpf.unlink(missing_ok=True)
                return self.send_json(result)
            if parsed.path == "/api/diff-text":
                # Unified diff of proposed content vs the file on
                # disk (agent review, G5). D2: an explicit
                # "base" overrides the disk side, so the run
                # review can diff a checkpoint original
                # against what is on disk now.
                data = self.read_json()
                p = safe_path(data["path"])
                if data.get("base") is not None:
                    old = data["base"]
                else:
                    old = p.read_text() if p.is_file() else ""
                new = data.get("content", "")
                diff = "\n".join(_difflib.unified_diff(
                    old.splitlines(), new.splitlines(),
                    fromfile="a/" + data["path"],
                    tofile="b/" + data["path"], lineterm=""))
                return self.send_json({"diff": diff})
            if parsed.path == "/api/refactor":
                # Roadmap G3: compute -> preview diff -> apply.
                data = self.read_json()
                ops = {
                    "extract-function": refactor_extract_function,
                    "extract-variable": refactor_extract_variable,
                    "inline": refactor_inline,
                    "move": refactor_move,
                }
                op = data.get("op", "")
                if op not in ops:
                    raise ValueError("unknown refactor: " + op)
                result = ops[op](data)
                changes = []
                for f in result["files"]:
                    fp = safe_path(f["path"])
                    old = fp.read_text() if fp.is_file() else ""
                    changes.append((f["path"], old, f["content"]))
                diff = _refactor_diff(changes)
                applied = False
                if data.get("apply"):
                    for f in result["files"]:
                        fp = safe_path(f["path"])
                        fp.parent.mkdir(parents=True, exist_ok=True)
                        snapshot_history(fp, f["content"])
                        fp.write_text(f["content"])
                    if result.get("move"):
                        src = safe_path(result["move"]["from"])
                        dst = safe_path(result["move"]["to"])
                        dst.parent.mkdir(parents=True,
                                         exist_ok=True)
                        src.rename(dst)
                    applied = True
                return self.send_json({
                    "diff": diff, "applied": applied,
                    "info": result.get("info", {}),
                    "files": [f["path"] for f in result["files"]],
                    "move": result.get("move")})
            if parsed.path == "/api/rename-symbol":
                # Phase 10: word-boundary rename of an identifier
                # across the workspace (files on disk; the UI
                # guards unsaved buffers before calling).
                import re as _re
                data = self.read_json()
                word = data.get("word", "")
                rep = data.get("replacement", "")
                if not _re.match(r"^[A-Za-z_$][A-Za-z0-9_$]*$",
                                 word or ""):
                    raise ValueError("not an identifier: " + word)
                if not _re.match(r"^[A-Za-z_$][A-Za-z0-9_$]*$",
                                 rep or ""):
                    raise ValueError("not an identifier: " + rep)
                pat = _re.compile(r"\b" + _re.escape(word) + r"\b")
                files_changed = 0
                total = 0
                for rel, p in iter_text_files():
                    try:
                        text = p.read_text(errors="strict")
                    except Exception:
                        continue
                    new, n = pat.subn(rep, text)
                    if n:
                        p.write_text(new)
                        files_changed += 1
                        total += n
                return self.send_json({
                    "filesChanged": files_changed,
                    "replacements": total})
            if parsed.path == "/api/format":
                data = self.read_json()
                p = safe_path(data["path"])
                ext = p.suffix.lower()
                tool = None
                if ext == ".py":
                    if shutil.which("black"):
                        tool = ["black", "-q", str(p)]
                    elif shutil.which("ruff"):
                        tool = ["ruff", "format", str(p)]
                elif ext in (".js", ".ts", ".json", ".md", ".css",
                             ".html"):
                    if shutil.which("prettier"):
                        tool = ["prettier", "--write", str(p)]
                if tool is None:
                    return self.send_json({
                        "formatted": False,
                        "reason": "no formatter installed for %s "
                                  "(looked for black/ruff/prettier)" % ext})
                rc, out, err, _ = run_cmd(tool, WORKSPACE)
                if rc != 0:
                    raise ValueError((err or out).strip()[:300] or
                                     "formatter failed")
                return self.send_json({"formatted": True,
                                       "tool": tool[0]})
            if parsed.path == "/api/terminal/reset":
                _term_kill()
                return self.send_json({"ok": True})
            if parsed.path == "/api/repl/reset":
                _repl_kill()
                return self.send_json({"ok": True})
            if parsed.path == "/api/repl":
                # Roadmap G10: persistent Python REPL session.
                data = self.read_json()
                out = _repl_send(data.get("input", ""))
                return self.send_json({"output": out})
            if parsed.path == "/api/terminal":
                # Roadmap G10: a persistent shell session in the
                # workspace (was one-shot in the Tools pack). Local
                # and UNSANDBOXED by design: your machine, your
                # commands. cwd/env/variables persist; a timeout
                # restarts the session (see _term_run).
                data = self.read_json()
                cmd = data.get("command", "").strip()
                if not cmd:
                    raise ValueError("empty command")
                t0 = time.time()
                r = _term_run(cmd)
                return self.send_json({
                    "ok": True, "code": r["code"],
                    "stdout": r["stdout"][-64000:],
                    "stderr": r["stderr"][-64000:],
                    "cwd": r["cwd"],
                    "ms": int((time.time() - t0) * 1000),
                    "cmd": cmd})
            if parsed.path == "/api/check":
                # Tools pack: syntax check with the system tools.
                # Python via ast.parse (no __pycache__ artifacts),
                # JS via node --check, JSON via the parser.
                data = self.read_json()
                p = safe_path(data["path"])
                if not p.is_file():
                    raise ValueError("file not found: " + data["path"])
                ext = p.suffix.lower()
                if ext == ".py":
                    argv = [py_cmd()[0], "-c",
                            "import ast,sys; "
                            "ast.parse(open(sys.argv[1], "
                            "encoding='utf-8').read())", str(p)]
                elif ext in (".js", ".mjs"):
                    argv = ["node", "--check", str(p)]
                elif ext == ".json":
                    argv = [py_cmd()[0], "-c",
                            "import json,sys; "
                            "json.load(open(sys.argv[1]))", str(p)]
                elif ext == ".sql":
                    argv = [py_cmd()[0], "-c", SQL_CHECKER, str(p)]
                elif ext == ".go":
                    # Roadmap G21: gofmt is the Go syntax gate.
                    if not shutil.which("gofmt"):
                        return self.send_json({
                            "ok": None, "output":
                            "Go is not installed on this machine, "
                            "so .go files cannot be checked here "
                            "yet. Install Go to enable gofmt "
                            "checks and Go runs."})
                    rc, out, err, ms = run_cmd(
                        ["gofmt", "-e", str(p)], cwd=str(WORKSPACE))
                    if rc == 0:
                        return self.send_json({
                            "ok": True,
                            "output": "Syntax OK (gofmt): "
                            + data["path"],
                            "ms": ms, "line": None, "message": ""})
                    output = (err or out).strip()
                    line_no, message = check_output_info(output)
                    return self.send_json({
                        "ok": False, "output": output, "ms": ms,
                        "line": line_no, "message": message})
                elif ext == ".rs":
                    if not shutil.which("rustc"):
                        return self.send_json({
                            "ok": None, "output":
                            "Rust is not installed on this machine, "
                            "so .rs files cannot be checked here "
                            "yet. Install rustc to enable Rust "
                            "checks and runs."})
                    argv = ["rustc", "--edition", "2021",
                            "--emit=metadata", "-o", os.devnull,
                            str(p)]
                else:
                    return self.send_json({
                        "ok": None, "output":
                        "No syntax checker for " + (ext or "this file")
                        + " files - py/js/json/sql supported; go "
                        "and rust check when their toolchains are "
                        "installed."})
                rc, out, err, ms = run_cmd(argv, cwd=str(WORKSPACE))
                output = (out + err).strip() or (
                    "Syntax OK: " + data["path"])
                # Phase 8/11: line + message for the Problems UI,
                # parsed by the shared helper.
                line_no = None
                message = ""
                if rc != 0:
                    line_no, message = check_output_info(output)
                return self.send_json({
                    "ok": rc == 0, "output": output, "ms": ms,
                    "line": line_no, "message": message})
            if parsed.path == "/api/http":
                # Roadmap G23: API client. The server sends the
                # request so local dev servers without CORS
                # headers work from the pane.
                data = self.read_json()
                method = (data.get("method") or "GET").upper()
                url = data.get("url") or ""
                if not (url.startswith("http://")
                        or url.startswith("https://")):
                    raise ValueError(
                        "URL must start with http:// or https://")
                headers = {str(k): str(v) for k, v in
                           (data.get("headers") or {}).items()}
                body = data.get("body") or None
                req = urllib.request.Request(
                    url, method=method,
                    data=body.encode("utf-8") if body else None,
                    headers=headers)
                import time as _time2
                t0 = _time2.time()
                try:
                    with urllib.request.urlopen(
                            req, timeout=15) as resp:
                        raw = resp.read(512 * 1024 + 1)
                        status = resp.status
                        resp_headers = [[k, v] for k, v in
                                        resp.headers.items()]
                except urllib.error.HTTPError as e:
                    raw = e.read(512 * 1024 + 1)
                    status = e.code
                    resp_headers = [[k, v] for k, v in
                                    e.headers.items()] \
                        if e.headers else []
                except Exception as e:
                    raise ValueError(
                        "request failed: " + str(e)[:300])
                truncated = len(raw) > 512 * 1024
                return self.send_json({
                    "ok": True, "status": status,
                    "headers": resp_headers,
                    "body": raw[:512 * 1024].decode(
                        "utf-8", "replace"),
                    "size": len(raw), "truncated": truncated,
                    "ms": int((_time2.time() - t0) * 1000)})
            if parsed.path == "/api/file64":
                # Roadmap G25: binary write (base64 body) for
                # generated assets like icon PNGs, which the
                # text file API would corrupt.
                data = self.read_json()
                p = safe_path(data["path"])
                import base64 as _b64
                raw = _b64.b64decode(data.get("base64") or "")
                if len(raw) > 8 * 1024 * 1024:
                    raise ValueError("file too large (8 MB cap)")
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(raw)
                return self.send_json({"ok": True,
                                       "path": data["path"],
                                       "size": len(raw)})
            if parsed.path == "/api/db/info":
                # Roadmap G22: SQLite studio. Read-only open;
                # tables with columns and row counts.
                data = self.read_json()
                p = safe_path(data["path"])
                if not p.is_file():
                    raise ValueError("file not found: " + data["path"])
                import sqlite3 as _sq
                con = _sq.connect("file:%s?mode=ro" % p, uri=True)
                try:
                    tables = []
                    names = [r[0] for r in con.execute(
                        "SELECT name FROM sqlite_master WHERE "
                        "type='table' AND name NOT LIKE "
                        "'sqlite_%' ORDER BY name")]
                    for name in names:
                        cols = [{"name": r[1], "type": r[2],
                                 "pk": bool(r[5])}
                                for r in con.execute(
                                    'PRAGMA table_info("%s")'
                                    % name.replace('"', '""'))]
                        count = con.execute(
                            'SELECT COUNT(*) FROM "%s"'
                            % name.replace('"', '""')).fetchone()[0]
                        tables.append({"name": name,
                                       "columns": cols,
                                       "count": count})
                    return self.send_json({"ok": True,
                                           "tables": tables})
                finally:
                    con.close()
            if parsed.path == "/api/db/query":
                # One statement per call. Read-only unless the
                # caller passes write:true — enforcement is by
                # the engine itself (mode=ro rejects writes).
                data = self.read_json()
                p = safe_path(data["path"])
                if not p.is_file():
                    raise ValueError("file not found: " + data["path"])
                sql = (data.get("sql") or "").strip()
                if not sql:
                    raise ValueError("empty query")
                write = bool(data.get("write"))
                import sqlite3 as _sq
                import time as _time
                uri = ("file:%s" % p) if write else (
                    "file:%s?mode=ro" % p)
                con = _sq.connect(uri, uri=True)
                t0 = _time.time()
                try:
                    cur = con.execute(sql)
                    if cur.description:
                        cols = [d[0] for d in cur.description]
                        rows = []
                        for row in cur.fetchmany(501):
                            rows.append([
                                None if v is None else (
                                    v if isinstance(
                                        v, (int, float))
                                    else str(v)[:500])
                                for v in row])
                        return self.send_json({
                            "ok": True, "columns": cols,
                            "rows": rows[:500],
                            "truncated": len(rows) > 500,
                            "ms": int((_time.time() - t0) * 1000)})
                    con.commit()
                    return self.send_json({
                        "ok": True, "columns": [], "rows": [],
                        "rowcount": cur.rowcount,
                        "ms": int((_time.time() - t0) * 1000)})
                finally:
                    con.close()
            if parsed.path == "/api/model/switch":
                # Desktop model manager (Phase 3.1): point the IDE at
                # another local GGUF (e.g. the 1.5B/3B for a lighter
                # session, or the 7B reference). The running model
                # process (if we started it) is stopped; Start model
                # relaunches with the new file.
                data = self.read_json()
                p = Path(data["path"]).expanduser().resolve()
                if not p.is_file():
                    raise ValueError("no such model file: " + data["path"])
                MODEL = str(p)
                MODEL_NAME = p.name.replace(".gguf", "")
                if _model_proc and _model_proc.poll() is None:
                    _model_proc.terminate()
                return self.send_json({
                    "ok": True, "modelName": MODEL_NAME,
                    "modelPath": MODEL, "bytes": p.stat().st_size})
            if parsed.path == "/api/sync/apply":
                # LAN sync push from the phone: write its workspace
                # files here (same escape guard as every write).
                data = self.read_json()
                n = 0
                for f in data.get("files", []):
                    p = safe_path(f["path"])
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(f.get("content", ""))
                    n += 1
                return self.send_json({"ok": True, "applied": n,
                                       "workspace": str(WORKSPACE)})
            if parsed.path == "/api/chat":
                data = self.read_json()
                data.setdefault("model", MODEL_NAME)
                # D7: the workspace's AGENTS.md rides in
                # the system context of every chat/agent
                # request, whichever flow built it.
                _instr = _trust_mod.instructions_block(WORKSPACE)
                if _instr:
                    _msgs = list(data.get("messages") or [])
                    if _msgs and _msgs[0].get("role") == "system":
                        _first = dict(_msgs[0])
                        _first["content"] = (
                            _first.get("content") or "") \
                            + "\n\n" + _instr
                        _msgs[0] = _first
                    else:
                        _msgs.insert(0, {"role": "system",
                                         "content": _instr})
                    data["messages"] = _msgs
                return self.proxy("/v1/chat/completions", data, stream=True)
            if parsed.path == "/api/infill":
                data = self.read_json()
                payload = {
                    "model": MODEL_NAME,
                    "input_prefix": data.get("prefix", ""),
                    "input_suffix": data.get("suffix", ""),
                    "max_tokens": data.get("max_tokens", 64),
                    "temperature": 0.1,
                    "cache_prompt": True,
                }
                return self.proxy("/infill", payload)
            return self.send_json({"error": "no such route"}, status=404)
        except Exception as e:
            try:
                return self.send_json({"error": str(e)}, status=400)
            except Exception:
                pass


def main():
    global WORKSPACE
    # D3: a staged update (or a rollback, or an
    # auto-rollback of an unconfirmed boot) swaps the app
    # folder before anything serves; when a swap happened,
    # re-exec so the swapped build is what runs. A failed
    # apply never blocks the current build from starting.
    try:
        _upd_action = get_updater().apply_at_launch()
    except Exception as _upd_e:
        _upd_action = None
        print("update apply failed, continuing with the "
              "current build: %s" % _upd_e)
    if _upd_action:
        print("update: %s - restarting into the swapped "
              "build" % _upd_action)
        if FROZEN:
            os.execv(sys.executable,
                     [sys.executable] + sys.argv[1:])
        os.execv(sys.executable,
                 [sys.executable] + sys.argv)
    # The seeded first workspace: ~/GhostIDE for the
    # packaged app, ghostide-data/workspace in portable
    # mode (either run style), the repo playground for a
    # plain source run (default_workspace returns None).
    _seed_ws = ghost_paths.default_workspace(
        ROOT, frozen=FROZEN)
    if _seed_ws is not None \
            and "GHOST_IDE_WORKSPACE" not in os.environ:
        home_ws = _seed_ws
        if not home_ws.exists():
            home_ws.mkdir(parents=True, exist_ok=True)
            seed = ROOT / "playground"
            if seed.is_dir():
                import shutil as _seed_sh
                for item in sorted(seed.rglob("*")):
                    if item.is_file():
                        dst = home_ws / item.relative_to(seed)
                        dst.parent.mkdir(parents=True,
                                         exist_ok=True)
                        _seed_sh.copy2(item, dst)
        WORKSPACE = home_ws
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    # D7: the folder the user launched in is trusted (it
    # was their choice); folders opened later prompt once.
    if TRUST_STORE.decision(WORKSPACE) is None:
        TRUST_STORE.set(WORKSPACE, True, source="startup")
    # D3: the packaged app checks for an update on launch
    # when the setting allows it; the result waits in the
    # updater state for the UI to show. Source runs stay
    # report-only (the Settings check button).
    if FROZEN and get_updater().settings()["checkOnLaunch"]:
        import threading as _upd_threading
        _upd_threading.Thread(
            target=lambda: get_updater().run_check(),
            daemon=True).start()
    # v2.33: an interrupted restore is rolled back
    # before the server serves anything.
    _restore_reconcile()
    import threading as _threading
    lan = HOST not in ("127.0.0.1", "localhost", "::1")
    servers = []
    if not lan:
        servers.append(ThreadingHTTPServer((HOST, PORT), Handler))
        print(f"GhostIDE at http://{HOST}:{PORT}  workspace={WORKSPACE}")
    else:
        # v2.38: LAN mode is dual-listener - the host's
        # own UI stays on loopback HTTP (never warns),
        # guests come in over HTTPS on the LAN address.
        servers.append(
            ThreadingHTTPServer(("127.0.0.1", PORT), Handler))
        print(f"GhostIDE at http://127.0.0.1:{PORT}  workspace={WORKSPACE}")
        cert = ensure_host_cert()
        if cert is not None:
            ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(str(cert[0]), str(cert[1]))
            addrs = set(_lan_ips()) - {"127.0.0.1"}
            if HOST != "0.0.0.0":
                addrs.add(HOST)
            for ip in sorted(addrs):
                secure = ThreadingHTTPServer((ip, PORT), Handler)
                secure.socket = ctx.wrap_socket(
                    secure.socket, server_side=True)
                servers.append(secure)
            TLS_STATE["active"] = True
            print("LAN mode (encrypted): guests open "
                  f"https://<this-computer's-IP>:{PORT} and "
                  "accept the one-time browser warning.")
            print("Host certificate fingerprint "
                  f"(SHA-256): {TLS_STATE['fingerprint']}")
            print("A guest checks this fingerprint on "
                  "this screen before entering the "
                  "pairing code; the code is the secret, "
                  "the fingerprint is the host's identity.")
        else:
            servers.append(
                ThreadingHTTPServer((HOST, PORT), Handler))
            print("WARNING: LAN mode is serving PLAIN "
                  "HTTP - no certificate could be "
                  "generated (the cryptography package "
                  "and the openssl command are both "
                  "unavailable), so traffic and pair "
                  "tokens are visible on the network. "
                  "Pair only on networks you trust, or "
                  "install one of those and restart.")
    print(f"Pairing code (this boot): {PAIR_CODE} - a new "
          "device enters it once to pair; this device "
          "needs none.")
    print(f"Model: {MODEL_NAME} via {LLAMA_BASE} "
          f"({'up' if llama_health() else 'down - use Start Model in the IDE'})")
    # D3: reaching the serve loop confirms the running
    # build booted; an update swap that never gets here
    # is rolled back by the next launch instead.
    try:
        get_updater().confirm_boot_ok()
    except Exception:
        pass
    for s in servers[:-1]:
        _threading.Thread(target=s.serve_forever,
                          daemon=True).start()
    try:
        servers[-1].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # D4: never leave language server processes
        # behind the IDE.
        if _LSP is not None:
            try:
                _LSP.shutdown_all()
            except Exception:
                pass


if __name__ == "__main__":
    main()
