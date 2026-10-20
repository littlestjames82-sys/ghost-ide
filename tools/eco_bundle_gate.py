#!/usr/bin/env python3
"""Roadmap ECO E2 bundle gate.

For every tool in the phone bundle: stage the exact .py tree
build.sh will zip (the "vendored copy") into a scratch copy of
the tool's own repo, then run the tool's own test suite against
that vendored copy. A tool joins the bundle only with a green
suite. Results land in tools/eco-bundle-state.json, which
build.sh turns into the eco-manifest.json inside eco.zip.

Bundle rules (audit, Oct 20 2026): pure stdlib, filesystem
only - no network, no subprocess/host binaries, not
long-running. Tools that shell out to git or execute commands
join via their own roadmap goals, which wire the phone's git
path. GhostSlice is bundled as the shared library several
tools import. Held out: ghostproxy (network by design),
ghostport (stays a CLI), ghostpacks (one known pre-existing
failing test, GhostSlice-side).
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HOME = Path.home() / "workspace"
BUNDLED = [
    "ghostindex", "ghostdeps", "ghostprimer", "ghostlift",
    "ghostshard", "ghostexposure", "ghostconvert",
    "ghostfixture", "ghostdocs", "ghostschema", "ghostlogs",
    "ghostdata", "ghostapprove", "ghostledger", "ghostrecipes",
    "ghostenv", "ghostmcpdoctor", "ghostleads", "quoteshot",
    "ghostreplay", "ghostconsole",
]
LIBRARY = ["ghostslice"]
SCRATCH = HOME / "test-fixtures" / "eco-vendored"
STATE = HOME / "ghost-ide" / "tools" / "eco-bundle-state.json"


def stage_vendored(tool, dest_src):
    """Copy exactly what build.sh zips: the whole package
    tree, including in-package data files (GhostSlice and
    GhostLedger ship prices.json the code loads; a .py-only
    copy fails 207 GhostSlice tests and breaks its CLI),
    minus egg-info metadata and caches."""
    src = HOME / tool / "src"
    count, total = 0, 0
    for f in sorted(src.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(src)
        if any(part.endswith(".egg-info") or part == "__pycache__"
               for part in rel.parts):
            continue
        if f.suffix in (".pyc", ".pyo"):
            continue
        out = dest_src / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(f, out)
        count += 1
        total += f.stat().st_size
    return count, total


def version_of(tool, src_dir):
    for init in src_dir.rglob("__init__.py"):
        m = re.search(r'__version__\s*=\s*"([^"]+)"',
                      init.read_text(errors="replace"))
        if m:
            return m.group(1)
    return "?"


LOCK = SCRATCH / ".gate.lock"


def main():
    # A duplicate concurrent execution (the runtime has
    # replayed backgrounded commands during restart storms)
    # would race the shared scratch dirs and corrupt both
    # runs' counts. Refuse to run alongside another gate.
    SCRATCH.mkdir(parents=True, exist_ok=True)
    if LOCK.exists():
        print("gate already running (lock present); exiting")
        return 2
    LOCK.write_text(str(os.getpid()))
    try:
        return _main_locked()
    finally:
        LOCK.unlink(missing_ok=True)


def _main_locked():
    only = sys.argv[1:] or None
    tools = [t for t in LIBRARY + BUNDLED if not only or t in only]
    # The library is always staged (slice-dependent tools
    # import it), even for chunked runs that only test a
    # subset; only the selected suites run.
    stage_set = list(dict.fromkeys(LIBRARY + tools))
    vendored = {}   # tool -> staged src dir (shared library path)
    results = {}
    stage_root = SCRATCH / "pkgs"
    if stage_root.exists():
        shutil.rmtree(stage_root)
    for tool in stage_set:
        dest = stage_root / tool
        files, size = stage_vendored(tool, dest)
        vendored[tool] = (dest, files, size)
    lib_paths = [str(vendored[t][0]) for t in LIBRARY
                 if t in vendored]
    failures = []
    for tool in tools:
        dest, files, size = vendored[tool]
        repo = SCRATCH / ("repo-" + tool)
        if repo.exists():
            shutil.rmtree(repo)
        src_root = HOME / tool

        def _ignore(dirpath, names):
            # Only the repo's TOP-LEVEL src is replaced by the
            # vendored copy. A blanket "src" pattern also drops
            # fixtures/**/src directories and fails suites on
            # missing files (the gate's first-run bug).
            out = {n for n in names if n in (
                ".git", "__pycache__", ".pytest_cache")}
            if Path(dirpath) == src_root and "src" in names:
                out.add("src")
            return out

        shutil.copytree(HOME / tool, repo, ignore=_ignore)
        # The vendored copy becomes the repo's src.
        shutil.copytree(dest, repo / "src")
        env = dict(os.environ)
        env["PYTHONPATH"] = ":".join(
            [str(repo / "src")] + lib_paths)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        r = subprocess.run(
            [sys.executable, "-m", "pytest", "tests", "-q",
             "--no-header", "-p", "no:cacheprovider"],
            cwd=repo, env=env, capture_output=True, text=True,
            timeout=600)
        tail = (r.stdout + r.stderr).strip().splitlines()
        summary = tail[-1] if tail else ""
        mp = re.search(r"(\d+) passed", summary)
        mf = re.search(r"(\d+) failed", summary)
        passed = int(mp.group(1)) if mp else 0
        failed = int(mf.group(1)) if mf else (0 if r.returncode == 0
                                             else -1)
        ver = version_of(tool, dest)
        results[tool] = {"version": ver, "files": files,
                         "src_bytes": size, "tests_passed": passed,
                         "tests_failed": failed}
        status = "GREEN" if failed == 0 and passed > 0 else "FAIL"
        if status == "FAIL":
            failures.append(tool)
        print(f"{tool}: {status} {passed} passed, {failed} failed "
              f"(v{ver}, {files} files, {size} B)")
        if status == "FAIL":
            print("  tail:", "\n  ".join(tail[-6:]))
    # Merge into any existing state so chunked runs (one
    # invocation per tool group, watched in the foreground)
    # accumulate instead of clobbering each other.
    merged = {}
    if STATE.exists():
        try:
            merged = json.loads(STATE.read_text()).get("tools", {})
        except Exception:
            merged = {}
    merged.update(results)
    STATE.write_text(json.dumps(
        {"tools": merged,
         "bundled": BUNDLED, "library": LIBRARY}, indent=1))
    print("state ->", STATE)
    if failures:
        print("GATE FAILED for:", ", ".join(failures))
        return 1
    print("GATE GREEN for all", len(tools), "packages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
