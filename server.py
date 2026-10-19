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
