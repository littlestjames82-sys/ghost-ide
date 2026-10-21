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
APP_VERSION = "1.77.0"
FROZEN = getattr(sys, "frozen", False)
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


def backup_encrypt(passphrase, zip_bytes, files, nbytes):
    import base64
    import hashlib
    import hmac
    import os
    salt = os.urandom(16)
    nonce = os.urandom(16)
    enc_key, mac_key = _bk_keys(passphrase, salt, BACKUP_ITER)
    ct = _bk_crypt(enc_key, nonce, zip_bytes)
    mac = hmac.new(mac_key, salt + nonce + ct,
                   hashlib.sha256).digest()
    env = {
        "app": "ghostide-backup", "v": 1,
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
    if env.get("app") != "ghostide-backup" or env.get("v") != 1:
        raise ValueError("not a GhostIDE backup file")
    salt = base64.b64decode(env["kdf"]["salt"])
    iters = int(env["kdf"]["iter"])
    nonce = base64.b64decode(env["nonce"])
    ct = base64.b64decode(env["data"])
    enc_key, mac_key = _bk_keys(passphrase, salt, iters)
    mac = hmac.new(mac_key, salt + nonce + ct,
                   hashlib.sha256).digest()
    if not hmac.compare_digest(
            mac, base64.b64decode(env["mac"])):
        raise ValueError(
            "wrong passphrase or damaged backup "
            "(integrity check failed)")
    return _bk_crypt(enc_key, nonce, ct)
MODEL_CATALOG = {
    "7b": {
        "file": "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        "url": "https://huggingface.co/Qwen/"
               "Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/"
               "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        "bytes": 4683073536,
        "sha256": "509287f78cb4d4cf6b3843734733b914b2c158e43"
                  "e22a7f4bf5e963800894d3c",
    },
}
MODELS_DIR = Path(os.environ.get(
    "GHOST_IDE_MODELS", Path.home() / ".ghostide" / "models"))


def _find_llama():
    env = os.environ.get("LLAMA_SERVER_BIN")
    if env:
        return env
    name = "llama-server.exe" if os.name == "nt" else "llama-server"
    for cand in (ROOT / "llama" / name,
                 ROOT.parent / "llama" / name):
        if cand.is_file():
            return str(cand)
    return str(Path.home() / "workspace/tools/llama.cpp"
               "/llama-b11429" / name)


LLAMA_BIN = _find_llama()


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
    for rel, p in iter_text_files():
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
            continue
        checked += 1
        if checked > 100:
            break
        rc, out, err, ms = run_cmd(argv, cwd=str(WORKSPACE))
        if rc != 0:
            output = (out + err).strip()
            ln, msg = check_output_info(output)
            results.append({"path": str(rel), "line": ln,
                            "message": msg})
    return {"problems": results, "checked": checked}


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


def run_test_file(rel):
    p = safe_path(rel)
    results = []
    if rel.endswith(".py"):
        rc, out, err, ms = run_cmd(
            [py_cmd()[0], "-c", _TEST_RUNNER, str(p)],
            cwd=str(WORKSPACE), timeout=60)
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
        rc, out, err, ms = run_cmd(["node", "--test", str(p)],
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



def _dl_worker(mid):
    """Background model download (Roadmap G18): streams to
    a .part file with resume, then an exact-size gate and
    SHA-256 verification before the file becomes the
    model - the same discipline as the phone downloader."""
    global MODEL, MODEL_NAME
    import hashlib
    entry = MODEL_CATALOG[mid]
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
    except Exception as e:
        DL_STATE.update({"state": "error", "error": str(e)})


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
                     "modelName": MODEL_NAME, "version": APP_VERSION,
                     "workspace": str(WORKSPACE)})
            if parsed.path == "/api/eco/tools":
                return self.send_json({"tools": eco_tools_state()})
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
                        try:
                            entry["size"] = p.stat().st_size
                        except OSError:
                            entry["size"] = 0
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
                return self.send_json({"workspace": str(WORKSPACE)})
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
                    latest = str(info.get("version", ""))

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
            if parsed.path == "/api/backup/restore":
                data = self.read_json()
                pw = str(data.get("passphrase", ""))
                p = safe_path(str(data.get("path", "")))
                if not p.is_file():
                    raise ValueError("backup file not found")
                raw = backup_decrypt(pw, p.read_text())
                import io
                import zipfile
                count = 0
                total = 0
                with zipfile.ZipFile(io.BytesIO(raw)) as z:
                    for info in z.infolist():
                        parts = [x for x in
                                 info.filename.replace(
                                     "\\", "/").split("/")
                                 if x not in ("", ".", "..")]
                        if not parts:
                            continue
                        if any(x.startswith(".")
                               for x in parts):
                            continue
                        if parts[0] == "backups":
                            continue
                        dst = WORKSPACE.joinpath(*parts)
                        dst.parent.mkdir(parents=True,
                                         exist_ok=True)
                        content = z.read(info)
                        dst.write_bytes(content)
                        count += 1
                        total += len(content)
                return self.send_json({
                    "ok": True, "files": count, "bytes": total})
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
                return self.send_json({"ok": True, "workspace": str(p)})
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
            if parsed.path == "/api/eco/run":
                data = self.read_json()
                try:
                    out = eco_run(str(data.get("tool") or ""),
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
                targets = [f["path"] for f in discover_tests()
                           if not want or f["path"] == want]
                if want and not targets:
                    raise ValueError("not a test file: " + want)
                results = []
                t0 = time.time()
                for rel in targets:
                    results.extend(run_test_file(rel))
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
                # disk (agent review, G5).
                data = self.read_json()
                p = safe_path(data["path"])
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
    if FROZEN and "GHOST_IDE_WORKSPACE" not in os.environ:
        home_ws = Path.home() / "GhostIDE"
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
