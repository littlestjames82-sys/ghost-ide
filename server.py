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
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
WORKSPACE = Path(os.environ.get(
    "GHOST_IDE_WORKSPACE", ROOT / "playground")).resolve()
PORT = int(os.environ.get("GHOST_IDE_PORT", "5173"))
HOST = os.environ.get("GHOST_IDE_HOST", "127.0.0.1")
LLAMA_BASE = os.environ.get("LLAMA_BASE", "http://127.0.0.1:8080")
LLAMA_BIN = os.environ.get(
    "LLAMA_SERVER_BIN",
    str(Path.home() / "workspace/tools/llama.cpp/llama-b11429/llama-server"))
MODEL = os.environ.get(
    "GHOST_IDE_MODEL",
    str(Path.home() / "workspace/downloads/"
        "qwen2.5-coder-7b-instruct-q4_k_m.gguf"))
MODEL_NAME = "qwen2.5-coder-7b"

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
    p = (WORKSPACE / rel).resolve()
    if p != WORKSPACE and WORKSPACE not in p.parents:
        raise ValueError("path escapes workspace")
    return p


# ---------------- Phase 2: desktop power tools ----------------
import shutil
import tempfile
import time

CTX_BUDGET_DEFAULT = 6000  # of the desktop model's 8192 ctx


def run_cmd(args, cwd, timeout=30):
    """Run a local command, returning (rc, stdout, stderr) truncated."""
    try:
        t0 = time.time()
        r = subprocess.run(args, cwd=str(cwd), capture_output=True,
                           text=True, timeout=timeout)
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
        [sys.executable, "-m", "ghostslice", "export", str(WORKSPACE),
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
             "files": len(texts)}
    _SYM_CACHE["fp"] = fp
    _SYM_CACHE["index"] = index
    return index


def git_out(args, timeout=30):
    if not shutil.which("git"):
        raise ValueError("git is not installed")
    return run_cmd(["git", "-C", str(WORKSPACE)] + args,
                   WORKSPACE, timeout)


class Handler(SimpleHTTPRequestHandler):
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
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

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

    # ---------- routes ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                return self.send_json(
                    {"model": "up" if llama_health() else "down",
                     "modelName": MODEL_NAME,
                     "workspace": str(WORKSPACE)})
            if parsed.path == "/api/files":
                out = []
                for p in sorted(WORKSPACE.rglob("*")):
                    if any(part.startswith(".") for part in
                           p.relative_to(WORKSPACE).parts):
                        continue
                    out.append({
                        "path": str(p.relative_to(WORKSPACE)),
                        "type": "dir" if p.is_dir() else "file"})
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
                results = []
                checked = 0
                for rel, p in iter_text_files():
                    ext = p.suffix.lower()
                    if ext == ".py":
                        argv = [sys.executable, "-c",
                                "import ast,sys; "
                                "ast.parse(open(sys.argv[1], "
                                "encoding='utf-8').read())", str(p)]
                    elif ext in (".js", ".mjs"):
                        argv = ["node", "--check", str(p)]
                    elif ext == ".json":
                        argv = [sys.executable, "-c",
                                "import json,sys; "
                                "json.load(open(sys.argv[1]))", str(p)]
                    else:
                        continue
                    checked += 1
                    if checked > 100:
                        break
                    rc, out, err, ms = run_cmd(
                        argv, cwd=str(WORKSPACE))
                    if rc != 0:
                        output = (out + err).strip()
                        ln, msg = check_output_info(output)
                        results.append({
                            "path": str(rel), "line": ln,
                            "message": msg})
                return self.send_json({
                    "problems": results, "checked": checked})
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
            if parsed.path == "/api/file":
                rel = urllib.parse.parse_qs(parsed.query)["path"][0]
                p = safe_path(rel)
                return self.send_json(
                    {"path": rel, "content": p.read_text(errors="replace")})
            if parsed.path == "/api/workspace":
                return self.send_json({"workspace": str(WORKSPACE)})
            if parsed.path == "/api/model/info":
                mp = Path(MODEL)
                return self.send_json({
                    "modelName": MODEL_NAME, "modelPath": MODEL,
                    "exists": mp.is_file(),
                    "bytes": mp.stat().st_size if mp.is_file() else 0})
            if parsed.path == "/api/git/status":
                rc, out, err, _ = git_out(
                    ["status", "--porcelain=v1", "--branch"])
                if rc != 0:
                    return self.send_json({"repo": False,
                                           "error": err.strip()[:200]})
                lines = out.splitlines()
                branch = ""
                changes = []
                for ln in lines:
                    if ln.startswith("## "):
                        branch = ln[3:].split("...")[0].strip()
                    elif len(ln) > 3:
                        changes.append({"index": ln[0], "worktree": ln[1],
                                        "path": ln[3:].strip()})
                return self.send_json({"repo": True, "branch": branch,
                                       "changes": changes})
            if parsed.path == "/api/git/diff":
                rel = urllib.parse.parse_qs(parsed.query)["path"][0]
                safe_path(rel)
                rc, out, err, _ = git_out(["diff", "HEAD", "--", rel])
                if rc != 0:
                    raise ValueError(err.strip()[:300] or "git diff failed")
                return self.send_json({"path": rel, "diff": out})
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
            if parsed.path == "/api/git/diff-all":
                # Whole-change diff for the AI commit message tool.
                rc, out, err, _ = git_out(["diff", "HEAD", "--no-color"])
                if rc != 0:
                    rc, out, err, _ = git_out(
                        ["diff", "--cached", "--no-color"])
                if rc != 0:
                    return self.send_json({"repo": False})
                return self.send_json({"diff": out[:8000]})
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
            return super().do_GET()
        except Exception as e:
            return self.send_json({"error": str(e)}, status=400)

    def do_POST(self):
        global WORKSPACE, MODEL, MODEL_NAME
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/model/start":
                return self.send_json(start_model())
            if parsed.path == "/api/file":
                data = self.read_json()
                p = safe_path(data["path"])
                p.parent.mkdir(parents=True, exist_ok=True)
                snapshot_history(p, data.get("content", ""))
                p.write_text(data.get("content", ""))
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
                return self.send_json({"ok": True, "workspace": str(p)})
            if parsed.path == "/api/context":
                data = self.read_json()
                return self.send_json(make_context(
                    data.get("mode", "signatures"),
                    data.get("budget", CTX_BUDGET_DEFAULT)))
            if parsed.path == "/api/run":
                data = self.read_json()
                p = safe_path(data["path"])
                if not p.is_file():
                    raise ValueError("no such file: " + data["path"])
                runners = {".py": [sys.executable], ".js": ["node"],
                           ".sh": ["bash"], ".mjs": ["node"]}
                cmd = runners.get(p.suffix.lower())
                if cmd is None:
                    raise ValueError(
                        "no runner for %s files (runners: .py .js .sh)"
                        % (p.suffix or "(none)"))
                rc, out, err, ms = run_cmd(cmd + [str(p)], WORKSPACE,
                                           timeout=20)
                return self.send_json({
                    "ok": True, "code": rc, "stdout": out[-32768:],
                    "stderr": err[-8192:], "ms": ms,
                    "cmd": " ".join(cmd + [data["path"]])})
            if parsed.path == "/api/git/stage":
                data = self.read_json()
                if data["path"] != ".":
                    safe_path(data["path"])
                rc, out, err, _ = git_out(["add", "--", data["path"]])
                if rc != 0:
                    raise ValueError(err.strip()[:300] or "git add failed")
                return self.send_json({"ok": True})
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
            if parsed.path == "/api/search":
                data = self.read_json()
                q = data.get("query", "")
                if not q:
                    raise ValueError("empty search")
                matches = []
                for rel, p in iter_text_files():
                    try:
                        text = p.read_text(errors="strict")
                    except Exception:
                        continue
                    for i, line in enumerate(text.splitlines(), 1):
                        if q in line:
                            matches.append({"path": str(rel), "line": i,
                                            "text": line.strip()[:200]})
                            if len(matches) >= 200:
                                break
                    if len(matches) >= 200:
                        break
                return self.send_json({"matches": matches,
                                       "truncated": len(matches) >= 200})
            if parsed.path == "/api/replace":
                data = self.read_json()
                q = data.get("query", "")
                rep = data.get("replacement", "")
                if not q:
                    raise ValueError("empty search")
                files_changed = 0
                total = 0
                for rel, p in iter_text_files():
                    try:
                        text = p.read_text(errors="strict")
                    except Exception:
                        continue
                    n = text.count(q)
                    if n:
                        p.write_text(text.replace(q, rep))
                        files_changed += 1
                        total += n
                return self.send_json({"filesChanged": files_changed,
                                       "replacements": total})
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
            if parsed.path == "/api/terminal":
                # Tools pack: a real shell in the workspace. Local and
                # UNSANDBOXED by design (same trust as the run panel):
                # your machine, your commands.
                data = self.read_json()
                cmd = data.get("command", "").strip()
                if not cmd:
                    raise ValueError("empty command")
                t0 = time.time()
                try:
                    p = subprocess.run(
                        cmd, shell=True, cwd=str(WORKSPACE),
                        capture_output=True, text=True, timeout=30)
                    rc, out, err = (p.returncode, p.stdout, p.stderr)
                except subprocess.TimeoutExpired as e:
                    rc = -1
                    out = (e.stdout or "") if isinstance(
                        e.stdout, str) else ""
                    err = "(timed out after 30 s)"
                return self.send_json({
                    "ok": True, "code": rc,
                    "stdout": out[-64000:], "stderr": err[-64000:],
                    "ms": int((time.time() - t0) * 1000), "cmd": cmd})
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
                    argv = [sys.executable, "-c",
                            "import ast,sys; "
                            "ast.parse(open(sys.argv[1], "
                            "encoding='utf-8').read())", str(p)]
                elif ext in (".js", ".mjs"):
                    argv = ["node", "--check", str(p)]
                elif ext == ".json":
                    argv = [sys.executable, "-c",
                            "import json,sys; "
                            "json.load(open(sys.argv[1]))", str(p)]
                else:
                    return self.send_json({
                        "ok": None, "output":
                        "No syntax checker for " + (ext or "this file")
                        + " files - py/js/json supported."})
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
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"GhostIDE at http://{HOST}:{PORT}  workspace={WORKSPACE}")
    if HOST not in ("127.0.0.1", "localhost"):
        print("LAN mode: other devices on this network can open it at "
              f"http://<this-computer's-IP>:{PORT} - no auth, "
              "trusted networks only.")
    print(f"Model: {MODEL_NAME} via {LLAMA_BASE} "
          f"({'up' if llama_health() else 'down - use Start Model in the IDE'})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
