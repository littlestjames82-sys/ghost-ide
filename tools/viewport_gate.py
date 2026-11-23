#!/usr/bin/env python3
"""Mobile Cycle 1 (M1) viewport-matrix gate.

Renders the BUILT bundle (web/app.js, served by the real
desktop server.py) in a real browser engine - Playwright
driving the cached Firefox - at a matrix of phone,
landscape and desktop viewports, opens the key panels in
each, and FAILS on the 3.10.1 bug class:

  - the document itself wider than the viewport,
  - any visible interactive control rendered partially
    outside the viewport (unless a scroll/clip ancestor
    contains it, i.e. it scrolls inside its own box),
  - any no-wrap flex row whose content exceeds its
    container (the Git commit row bug, generalised).

The DOM-stub cannot measure layout; this gate exists
because only a real engine can. Run it with a Python
that has Playwright installed (the studio's demo venv):

  ~/workspace/ghostide-demo/venv/bin/python \
    tools/viewport_gate.py [--selftest]

--selftest reintroduces the 3.10.1 bug (no-wrap commit
row, fixed-width input) via injected CSS and proves the
gate catches it; without that proof a green gate would
mean nothing.

Fixtures are real git workspaces built in a temp dir:
wsA has staged + unstaged changes (app.py carries two
unstaged hunks), wsB has a merge conflict in progress.
Servers are real server.py subprocesses, one per
workspace. Exit code is nonzero on any failure.

M3 addition: at phone widths the gate also focuses the
editor and proves the symbol row appears, inserts one
character through its pointerdown path, measures clean
with the row on screen, and hides again on blur. The
printed state count is the true number of measure()
calls (M1 printed a hardcoded 14 per viewport).

M5 addition: at phone widths the gate also shows the
APK update banner through the app's own hook with a
sample notice, measures it clean as app chrome, and
hides it again.

M4 addition: at phone widths the wsB conflict state
also proves the card resolver is the presentation
(cards shown, desktop panes hidden), resolves the
fixture's one block through the card's Use ours
button, and measures both the card and the
all-resolved states clean.

M6 addition: at phone widths the gate also forces the
bundle's phone context through the __ghostPhoneGuard
hook (the gate's engine has no GhostNative bridge),
proves the model store panel renders its phone
presentation (the native-store note, no cards), and
proves the Chat options phone step note shows and
names the 25-step burst default. Both states are
measured clean, and the force is always released.

M7 addition: at phone widths the gate also forces the
composer voice context through the __ghostVoicePrompt
hook (the gate's engine has no GhostVoice bridge),
proves the mic shows in the composer at a 40px
target, drives a session through the page callbacks
the native recogniser uses (listening state naming
the on-device kind, a partial streaming into the
prompt box), ends it in the denied state (partial
dropped, box restored, plain message measured
clean), and lands a second session's final
transcript in the box with the chat log untouched:
voice never sends.

S1 addition: at phone widths the gate also seeds two
task records through the real /api/tasks API, opens
the Tasks panel from the tools grid, proves both
records list, opens the first record's detail and
proves the record-only label is on it, measuring
both states clean.

M2 addition: at phone widths the gate also seeds a
third record left in the running status (with a
saved run context beside it, written through the
real /api/file) and a fourth left waiting for an
approval, reopens the Tasks panel, and proves both
derive to Interrupted in the detail - the running
one with its Resume button offered, the waiting one
named as waiting for an approval when it stopped -
measuring both states clean. (The M2 copy change
also moved the S1 detail assertion: an ended record
now reads "Record only. This run has ended, and the
record is its history.")
"""
import asyncio
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIREFOX = os.environ.get(
    "GHOSTIDE_FIREFOX",
    str(Path.home() / ".cache" / "ms-playwright" /
        "firefox-1543" / "firefox" / "firefox"))
VIEWPORTS = [(320, 568), (360, 740), (390, 844),
             (412, 915), (740, 360), (568, 320),
             (1440, 900)]
BASE_PORT = 5741

MEASURE_JS = r"""
() => {
  const vw = window.innerWidth;
  const TOL = 1;
  const fails = [];
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.className && typeof el.className === "string")
      s += "." + el.className.split(/\s+/).join(".");
    const t = (el.textContent || "").trim()
      .replace(/\s+/g, " ").slice(0, 32);
    return s + (t ? " '" + t + "'" : "");
  };
  /* An element scrolled/clipped inside an ancestor's own
     box, or inside an off-canvas drawer, is contained -
     not a page overflow. */
  const contained = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (["auto", "scroll", "hidden"].includes(cs.overflowX))
        return true;
      const pr = p.getBoundingClientRect();
      if (pr.right <= 0 || pr.left >= vw) return true;
      p = p.parentElement;
    }
    return false;
  };
  const de = document.documentElement;
  if (de.scrollWidth > vw + TOL)
    fails.push("document scrollWidth " + de.scrollWidth +
      " > viewport " + vw);
  let nCtrl = 0;
  const CTRL = "button, input, select, textarea, a[href]";
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden")
      continue;
    if (el.matches(CTRL)) {
      nCtrl++;
      if ((r.right > vw + TOL || r.left < -TOL) &&
          !contained(el))
        fails.push("control outside viewport: " + desc(el) +
          " rect " + Math.round(r.left) + ".." +
          Math.round(r.right) + " of " + vw);
    }
    if (cs.display === "flex" && cs.flexWrap === "nowrap" &&
        cs.overflowX === "visible" &&
        el.scrollWidth > el.clientWidth + TOL)
      fails.push("nowrap flex row spills: " + desc(el) +
        " " + el.scrollWidth + " > " + el.clientWidth);
  }
  return { fails, nCtrl };
}
"""

APP_PY = "\n".join([
    "def greet(name):",
    "    return 'hello ' + name",
    "",
    "",
    "def add(a, b):",
    "    return a + b",
    "",
    "",
    "def sub(a, b):",
    "    return a - b",
    "",
    "",
    "def mul(a, b):",
    "    return a * b",
    "",
    "",
    "def div(a, b):",
    "    return a / b",
    "",
    "",
    "def main():",
    "    print(greet('world'))",
    "    print(add(2, 3))",
    "",
    "",
    "if __name__ == '__main__':",
    "    main()",
    ""]) + "\n"


def git(ws, *args):
    subprocess.run(["git", "-C", str(ws)] + list(args),
                   check=True, capture_output=True, text=True)


def make_fixtures(base):
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1")
    os.environ["GIT_AUTHOR_NAME"] = "Gate"
    os.environ["GIT_AUTHOR_EMAIL"] = "gate@example.invalid"
    os.environ["GIT_COMMITTER_NAME"] = "Gate"
    os.environ["GIT_COMMITTER_EMAIL"] = "gate@example.invalid"
    wsA = base / "wsA"
    wsA.mkdir()
    git(wsA, "init", "-q", "-b", "main")
    (wsA / "app.py").write_text(APP_PY)
    (wsA / "notes.txt").write_text("first note\n")
    (wsA / "a_very_long_filename_for_a_module_that_does_things.py") \
        .write_text("VALUE = 1\n")
    (wsA / "README.md").write_text("# fixture\n")
    git(wsA, "add", "-A")
    git(wsA, "commit", "-qm", "base")
    # Two unstaged hunks in app.py (top + bottom), one
    # staged change in notes.txt.
    txt = (wsA / "app.py").read_text().replace(
        "return 'hello ' + name", "return 'hello, ' + name + '!'")
    txt = txt.replace("print(add(2, 3))", "print(add(2, 3) + 10)")
    (wsA / "app.py").write_text(txt)
    (wsA / "notes.txt").write_text("first note\nsecond note\n")
    git(wsA, "add", "notes.txt")
    git(wsA, "branch", "feature/long-branch-name-for-layout")

    wsB = base / "wsB"
    wsB.mkdir()
    git(wsB, "init", "-q", "-b", "main")
    (wsB / "conflict.py").write_text(
        "def who():\n    return 'base'\n")
    git(wsB, "add", "-A")
    git(wsB, "commit", "-qm", "base")
    git(wsB, "checkout", "-qb", "side")
    (wsB / "conflict.py").write_text(
        "def who():\n    return 'side branch'\n")
    git(wsB, "commit", "-qam", "side")
    git(wsB, "checkout", "-q", "main")
    (wsB / "conflict.py").write_text(
        "def who():\n    return 'main branch'\n")
    git(wsB, "commit", "-qam", "main")
    r = subprocess.run(["git", "-C", str(wsB), "merge", "side"],
                       capture_output=True, text=True)
    assert r.returncode != 0, "merge should conflict"
    return wsA, wsB


def start_server(port, ws):
    env = dict(os.environ)
    env["GHOST_IDE_PORT"] = str(port)
    env["GHOST_IDE_WORKSPACE"] = str(ws)
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py")],
        cwd=str(ROOT), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}/api/health"
    for _ in range(75):
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError(f"server on {port} did not come up")


_MEASURES = [0]


async def measure(page, label, results):
    _MEASURES[0] += 1
    out = await page.evaluate(MEASURE_JS)
    for f in out["fails"]:
        results.append(f"{label}: {f}")
    return out["nCtrl"]


async def click_id(page, el_id):
    await page.evaluate(
        "(id) => document.getElementById(id).click()", el_id)


async def js_click(locator):
    """Click via JS: row buttons inside the drawer live in
    a nested scroll/transform context where Playwright's
    hit-test retries forever; the handler path is the
    same one a real tap takes."""
    await locator.first.evaluate("el => el.click()")


async def states_wsA(page, w, results):
    phone = w <= 900
    tag = f"{w}px wsA"
    await page.wait_for_function("window.__ghostBooted === true")
    await page.wait_for_timeout(450)
    await measure(page, f"{tag} base", results)
    if phone:
        await js_click(page.locator("#viewFiles"))
        await page.wait_for_timeout(250)
    await measure(page, f"{tag} drawer-files", results)
    # Open app.py from the tree.
    await js_click(page.locator("#fileTree .file",
                                has_text="app.py"))
    await page.wait_for_timeout(450)
    if phone:
        # M3: the symbol row shows while the editor
        # holds focus, scrolls inside itself, inserts
        # through the editor's own dispatch path, and
        # hides again on blur - with zero page overflow
        # throughout (the measure below is the proof).
        await page.evaluate(
            "document.querySelector('#editor .cm-content')"
            ".focus()")
        await page.wait_for_timeout(300)
        vis = await page.evaluate(
            "() => { const r = document.getElementById("
            "'symbolRow'); return !!r && "
            "!r.classList.contains('hidden') && "
            "r.getBoundingClientRect().height > 0; }")
        if not vis:
            results.append(f"{tag} symbol-row: row did "
                           "not appear on editor focus")
        before_txt = await page.evaluate(
            "document.querySelector('#editor .cm-content')"
            ".textContent")
        await page.evaluate(
            "() => { const b = document.querySelector("
            "'#symbolRow [data-key=\"(\"]'); "
            "b.dispatchEvent(new PointerEvent("
            "'pointerdown', { bubbles: true })); }")
        await page.wait_for_timeout(200)
        after_txt = await page.evaluate(
            "document.querySelector('#editor .cm-content')"
            ".textContent")
        if not after_txt.startswith("(") or \
                len(after_txt) != len(before_txt) + 1:
            results.append(f"{tag} symbol-row: the ( key "
                           "did not insert exactly one "
                           "character at the cursor")
        await measure(page, f"{tag} symbol-row", results)
        await page.evaluate(
            "document.querySelector('#editor .cm-content')"
            ".blur()")
        await page.wait_for_timeout(250)
        hid = await page.evaluate(
            "() => document.getElementById('symbolRow')"
            ".classList.contains('hidden')")
        if not hid:
            results.append(f"{tag} symbol-row: row stayed "
                           "visible after editor blur")
        # M5: the APK update notice renders in the app
        # chrome (a fixed card), so it joins the matrix:
        # show it through the app's own hook with a
        # sample notice, measure clean, hide it again.
        await page.evaluate(
            "() => { const h = window.__ghostApkUpdate; "
            "if (h && h.showApkUpdateNotice) "
            "h.showApkUpdateNotice({version: '9.9.9', "
            "versionCode: 9999, apkUrl: "
            "'https://example.invalid/ghostide.apk'}); }")
        await page.wait_for_timeout(250)
        vis = await page.evaluate(
            "() => { const b = document.getElementById("
            "'updateBanner'); return !!b && "
            "!b.classList.contains('hidden') && "
            "b.getBoundingClientRect().height > 0; }")
        if not vis:
            results.append(f"{tag} update-banner: banner "
                           "did not show via the hook")
        await measure(page, f"{tag} update-banner", results)
        await page.evaluate(
            "() => { const h = window.__ghostApkUpdate; "
            "if (h && h.hideApkUpdateNotice) "
            "h.hideApkUpdateNotice(); }")
        await page.wait_for_timeout(150)
        # M6: force the phone context through the app's
        # own hook and prove the two phone presentations
        # of the guards: the model store panel shows its
        # native-store note (no cards, no fetch), and
        # the Chat options show the phone step note.
        await page.evaluate(
            "() => { const h = window.__ghostPhoneGuard; "
            "if (h && h.phoneGuardForced) "
            "h.phoneGuardForced(true); }")
        await js_click(page.locator("#toolsBtn"))
        await page.wait_for_selector("#toolsPanel:not(.hidden)")
        await js_click(page.locator("#toolModels"))
        await page.wait_for_selector("#todoPanel:not(.hidden)")
        await page.wait_for_timeout(400)
        note = await page.evaluate(
            "() => { const b = document.getElementById("
            "'todoResults'); return !!b && "
            "b.textContent.includes('native Models store') "
            "&& !b.querySelector('.modelcard'); }")
        if not note:
            results.append(f"{tag} store-phone-note: the "
                           "phone store note did not render")
        await measure(page, f"{tag} store-phone-note", results)
        await js_click(page.locator("#todoClose"))
        await page.evaluate(
            "() => { const h = window.__ghostPhoneGuard; "
            "if (h && h.applyAgentStepsPhoneNote) "
            "h.applyAgentStepsPhoneNote(); }")
        await page.wait_for_timeout(150)
    if phone:
        await js_click(page.locator("#viewGit"))
        await page.wait_for_timeout(300)
        await page.evaluate(
            "document.getElementById('gitPanel')"
            ".scrollIntoView()")
        await page.wait_for_timeout(300)
    await measure(page, f"{tag} git-panel", results)
    # Diff panel with D9 hunk rows for app.py.
    row = page.locator("#gitChanges .gitRow",
                       has_text="app.py").first
    await row.evaluate("el => el.scrollIntoView()")
    await js_click(row.get_by_role("button", name="Diff"))
    await page.wait_for_selector("#diffPanel:not(.hidden)")
    await page.wait_for_timeout(250)
    await measure(page, f"{tag} diff-hunks", results)
    await click_id(page, "diffClose")
    if phone:
        await js_click(page.locator("#viewCode"))
        await page.wait_for_timeout(300)
    # Run pane.
    await js_click(page.locator("#runBtn"))
    await page.wait_for_selector("#runPane:not(.hidden)")
    await page.wait_for_timeout(450)
    await measure(page, f"{tag} run-pane", results)
    await js_click(page.locator("#runClose"))
    # Find panel: plain results + Neural setup state.
    await click_id(page, "findBtn")
    await page.wait_for_selector("#findPanel:not(.hidden)")
    await page.fill("#findQuery", "def")
    await js_click(page.locator("#findGo"))
    await page.wait_for_timeout(250)
    await measure(page, f"{tag} find-results", results)
    await js_click(page.locator("#findNeural"))
    await page.wait_for_timeout(250)
    await measure(page, f"{tag} find-neural", results)
    await click_id(page, "findClose")
    # Settings.
    await js_click(page.locator("#settingsBtn"))
    await page.wait_for_selector("#settingsPanel:not(.hidden)")
    await page.wait_for_timeout(300)
    await measure(page, f"{tag} settings", results)
    await js_click(page.locator("#settingsClose"))
    # Tools panel, then the shared todoPanel shells.
    await js_click(page.locator("#toolsBtn"))
    await page.wait_for_selector("#toolsPanel:not(.hidden)")
    await measure(page, f"{tag} tools", results)
    for btn, title in (("toolMcp", "MCP"), ("toolModels", "Model"),
                       ("toolApprove", "Approve")):
        await js_click(page.locator("#" + btn))
        await page.wait_for_selector("#todoPanel:not(.hidden)")
        await page.wait_for_timeout(550)
        await measure(page, f"{tag} todo-{title}", results)
        await js_click(page.locator("#todoClose"))
        await js_click(page.locator("#toolsBtn"))
        await page.wait_for_selector("#toolsPanel:not(.hidden)")
    # API client panel (in-flow, run-head + flex rows).
    await js_click(page.locator("#toolApi"))
    await page.wait_for_selector("#apiPanel:not(.hidden)")
    await page.wait_for_timeout(300)
    await measure(page, f"{tag} api-panel", results)
    # Terminal pane.
    await js_click(page.locator("#toolsBtn"))
    await js_click(page.locator("#toolTerminal"))
    await page.wait_for_selector("#termPane:not(.hidden)")
    await page.wait_for_timeout(300)
    await measure(page, f"{tag} term-pane", results)
    await js_click(page.locator("#termClose"))
    # Checkpoints shell via chat options.
    if phone:
        await js_click(page.locator("#viewChat"))
        await page.wait_for_timeout(300)
    await page.evaluate(
        "document.getElementById('chatOptsBtn')"
        ".scrollIntoView()")
    await js_click(page.locator("#chatOptsBtn"))
    await page.wait_for_timeout(300)
    if phone:
        # M6 (continued): the phone step note, shown by
        # the forced phone context above, names the
        # 25-step burst default inside Chat options.
        shown = await page.evaluate(
            "() => { const n = document.getElementById("
            "'agentStepsPhoneNote'); return !!n && "
            "!n.classList.contains('hidden') && "
            "n.textContent.includes('25 steps'); }")
        if not shown:
            results.append(f"{tag} chat-opts-phone: the "
                           "phone step note did not show")
        await measure(page, f"{tag} chat-opts-phone", results)
        await page.evaluate(
            "() => { const h = window.__ghostPhoneGuard; "
            "if (h && h.phoneGuardForced) "
            "h.phoneGuardForced(false); "
            "if (h && h.applyAgentStepsPhoneNote) "
            "h.applyAgentStepsPhoneNote(); }")
        await page.wait_for_timeout(150)
        # M7: voice-to-prompt in the composer. The
        # gate's engine has no GhostVoice bridge, so
        # force the composer voice context through the
        # app's own hook and prove the mic shows in the
        # composer at a 40px target. Then drive two
        # sessions through the same page callbacks the
        # native recogniser uses: the first ends in the
        # denied state (its partial must be dropped and
        # the box restored), the second lands its final
        # transcript in the box with the chat log
        # untouched (review before send, always).
        await page.evaluate(
            "() => { const h = window.__ghostVoicePrompt; "
            "if (h && h.voicePromptForced) "
            "h.voicePromptForced(true); }")
        await page.wait_for_timeout(150)
        mic = await page.evaluate(
            "() => { const b = document.getElementById("
            "'chatMic'); if (!b) return false; "
            "const r = b.getBoundingClientRect(); "
            "return !b.classList.contains('hidden') && "
            "r.height >= 40 && r.width >= 40; }")
        if not mic:
            results.append(f"{tag} voice-composer: the "
                           "mic did not show at a 40px "
                           "target")
        await measure(page, f"{tag} voice-composer", results)
        log_before = await page.evaluate(
            "document.getElementById('chatLog')"
            ".childElementCount")
        await page.evaluate(
            "window.__ghostVoicePromptState && "
            "window.__ghostVoicePromptState("
            "'listening', 'device')")
        await page.evaluate(
            "window.__ghostVoicePromptPartial && "
            "window.__ghostVoicePromptPartial("
            "'fix the crash in')")
        await page.wait_for_timeout(150)
        live = await page.evaluate(
            "() => { const t = document.getElementById("
            "'chatText'); const s = document"
            ".getElementById('voiceStatus'); return "
            "t.value.includes('fix the crash in') && "
            "s.textContent.includes('On-device'); }")
        if not live:
            results.append(f"{tag} voice-listening: the "
                           "partial did not stream into "
                           "the box with the on-device "
                           "state showing")
        await measure(page, f"{tag} voice-listening", results)
        await page.evaluate(
            "window.__ghostVoicePromptState && "
            "window.__ghostVoicePromptState("
            "'denied', null)")
        await page.wait_for_timeout(150)
        denied = await page.evaluate(
            "() => { const s = document.getElementById("
            "'voiceStatus'); const t = document"
            ".getElementById('chatText'); return "
            "s.textContent.includes("
            "'Microphone permission is off') && "
            "t.value === ''; }")
        if not denied:
            results.append(f"{tag} voice-denied: the "
                           "denied state did not show "
                           "its message with the box "
                           "restored")
        await measure(page, f"{tag} voice-denied", results)
        await page.evaluate(
            "window.__ghostVoicePromptState && "
            "window.__ghostVoicePromptState("
            "'listening', 'service')")
        await page.evaluate(
            "window.__ghostVoicePromptPartial && "
            "window.__ghostVoicePromptPartial("
            "'fix the crash in')")
        await page.evaluate(
            "window.__ghostVoicePromptFinal && "
            "window.__ghostVoicePromptFinal("
            "'fix the crash in the parser.')")
        await page.wait_for_timeout(150)
        landed = await page.evaluate(
            "(n) => { const t = document.getElementById("
            "'chatText'); const l = document"
            ".getElementById('chatLog'); return "
            "t.value.includes('fix the crash in the "
            "parser.') && "
            "l.childElementCount === n; }", log_before)
        if not landed:
            results.append(f"{tag} voice-final: the "
                           "transcript did not land in "
                           "the box unsent")
        await page.evaluate(
            "() => { const h = window.__ghostVoicePrompt; "
            "if (h && h.voicePromptForced) "
            "h.voicePromptForced(false); }")
        await page.wait_for_timeout(150)
        # S1: task records. Seed two records through
        # the real API on this server (the workspace is
        # shared across viewports, so an "already
        # exists" answer from a later viewport is also
        # a successful seed), then open the Tasks panel
        # from the tools grid and prove the list and
        # the detail (with its record-only label).
        seeded = await page.evaluate(
            """async () => {
              const rec = (id, title, status, upd) => ({
                schema: "ghostide.task", schemaVersion: 1,
                id, kind: "agent-run", title,
                goal: "gate fixture goal",
                workspace: "gate", createdBy: "desktop",
                status, budget: { stepCap: 50 },
                approvals: { asked: 1, allowed: 1,
                  denied: 0 },
                checkpoint: null, planPath: null,
                steps: { count: 2,
                  lastLabel: "edit app.py" },
                createdAt: "2026-11-18T12:00:00",
                updatedAt: upd });
              const post = async (r) => {
                const resp = await fetch("/api/tasks", {
                  method: "POST",
                  headers: { "Content-Type":
                    "application/json" },
                  body: JSON.stringify(r) });
                return resp.json();
              };
              const ok = (j) => !!j && (!!j.ok ||
                String(j.error || "")
                  .includes("already exists"));
              const a = await post(rec(
                "task-20261118-120000-gate1",
                "Gate fixture task", "done",
                "2026-11-18T12:01:00"));
              const b = await post(rec(
                "task-20261118-120100-gate2",
                "Second gate task", "stopped",
                "2026-11-18T12:02:00"));
              return ok(a) && ok(b);
            }""")
        if not seeded:
            results.append(f"{tag} tasks-list: seeding "
                           "task records through the "
                           "API failed")
        await js_click(page.locator("#toolsBtn"))
        await page.wait_for_selector(
            "#toolsPanel:not(.hidden)")
        await js_click(page.locator("#toolTasks"))
        await page.wait_for_selector(
            "#tasksPanel:not(.hidden)")
        await page.wait_for_timeout(400)
        listed = await page.evaluate(
            "() => { const l = document.getElementById("
            "'tasksList'); return !!l && "
            "l.textContent.includes('Gate fixture task') "
            "&& l.textContent.includes("
            "'Second gate task'); }")
        if not listed:
            results.append(f"{tag} tasks-list: the "
                           "seeded records did not list")
        await measure(page, f"{tag} tasks-list", results)
        # Click the known ended record by name: since
        # M2 the shared workspace also holds the
        # interrupted fixtures (newer, so they sort
        # first), and the first row is no longer the
        # ended record this state proves.
        await js_click(page.locator(
            "#tasksList .taskRow",
            has_text="Second gate task"))
        await page.wait_for_timeout(400)
        detailed = await page.evaluate(
            "() => { const d = document.getElementById("
            "'taskDetail'); return !!d && "
            "!d.classList.contains('hidden') && "
            "d.textContent.includes('Record only') && "
            "d.textContent.includes("
            "'record is its history'); }")
        if not detailed:
            results.append(f"{tag} tasks-detail: the "
                           "detail did not show the "
                           "record-only label")
        await measure(page, f"{tag} tasks-detail",
                      results)
        # M2: two more records, one left running with
        # a saved run context beside it, one left
        # waiting for an approval. No run is live in
        # the gate, so both must derive to Interrupted
        # in the detail, the first with Resume offered.
        seeded2 = await page.evaluate(
            """async () => {
              const post = async (url, body) => {
                const resp = await fetch(url, {
                  method: "POST",
                  headers: { "Content-Type":
                    "application/json" },
                  body: JSON.stringify(body) });
                return resp.json();
              };
              const ok = (j) => !!j && (!!j.ok ||
                String(j.error || "")
                  .includes("already exists"));
              const base = {
                schema: "ghostide.task",
                schemaVersion: 1, kind: "agent-run",
                goal: "gate fixture goal",
                workspace: "gate", createdBy: "android",
                budget: { stepCap: 50 },
                approvals: { asked: 1, allowed: 1,
                  denied: 0 },
                checkpoint: null, planPath: null,
                steps: { count: 2,
                  lastLabel: "edit app.py" },
                createdAt: "2026-11-18T12:03:00" };
              const c = await post("/api/tasks",
                { ...base,
                  id: "task-20261118-120300-gate3",
                  title: "Gate interrupted task",
                  status: "running",
                  updatedAt: "2026-11-18T12:04:00",
                  payload: { runId: "run-gate3",
                    segments: 1,
                    contextPath: ".ghostide/"
                      + "checkpoints/runctx-"
                      + "task-20261118-120300-gate3"
                      + ".json",
                    arc: [{ status: "running",
                      at: "2026-11-18T12:03:00" }] } });
              const ctx = await post("/api/file", {
                path: ".ghostide/checkpoints/"
                  + "runctx-task-20261118-120300-"
                  + "gate3.json",
                content: JSON.stringify({
                  kind: "ghostide-run-context",
                  version: 1,
                  taskId: "task-20261118-120300-gate3",
                  runId: "run-gate3",
                  task: "gate fixture goal",
                  plan: "", todos: [],
                  staged: { "app.py":
                    "def greet(name):\\n"
                    + "    return 'hello ' + name\\n" },
                  deletions: [],
                  trail: [{ step: 1, type: "read",
                    target: "app.py" },
                    { step: 2, type: "edit",
                    target: "app.py" }],
                  approvals: [], stepCount: 2,
                  savedAt: "2026-11-18T12:04:00" }) });
              const w = await post("/api/tasks",
                { ...base,
                  id: "task-20261118-120500-gate4",
                  title: "Gate waiting task",
                  status: "waiting-approval",
                  updatedAt: "2026-11-18T12:05:00",
                  payload: { runId: "run-gate4",
                    segments: 1, contextPath: null,
                    arc: [{ status: "running",
                      at: "2026-11-18T12:04:30" },
                      { status: "waiting-approval",
                      at: "2026-11-18T12:05:00" }] } });
              return ok(c) && ok(w) && !ctx.error;
            }""")
        if not seeded2:
            results.append(f"{tag} tasks-interrupted: "
                           "seeding the M2 records "
                           "failed")
        await js_click(page.locator("#tasksClose"))
        await js_click(page.locator("#toolsBtn"))
        await page.wait_for_selector(
            "#toolsPanel:not(.hidden)")
        await js_click(page.locator("#toolTasks"))
        await page.wait_for_selector(
            "#tasksPanel:not(.hidden)")
        await page.wait_for_timeout(400)
        await js_click(page.locator(
            "#tasksList .taskRow",
            has_text="Gate interrupted task"))
        await page.wait_for_timeout(400)
        interrupted = await page.evaluate(
            "() => { const d = document.getElementById("
            "'taskDetail'); const b = document"
            ".getElementById('taskResumeBtn'); "
            "return !!d && "
            "!d.classList.contains('hidden') && "
            "d.textContent.includes('Interrupted') && "
            "!!b; }")
        if not interrupted:
            results.append(f"{tag} tasks-interrupted: "
                           "the detail did not show "
                           "Interrupted with Resume "
                           "offered")
        await measure(page, f"{tag} tasks-interrupted",
                      results)
        await js_click(page.locator(
            "#taskDetail button",
            has_text="Back to the list"))
        await page.wait_for_timeout(300)
        await js_click(page.locator(
            "#tasksList .taskRow",
            has_text="Gate waiting task"))
        await page.wait_for_timeout(400)
        waiting = await page.evaluate(
            "() => { const d = document.getElementById("
            "'taskDetail'); return !!d && "
            "!d.classList.contains('hidden') && "
            "d.textContent.includes('Interrupted') && "
            "d.textContent.includes("
            "'waiting for an approval'); }")
        if not waiting:
            results.append(f"{tag} tasks-waiting: the "
                           "detail did not show the "
                           "interrupted waiting state")
        await measure(page, f"{tag} tasks-waiting",
                      results)
        await js_click(page.locator("#tasksClose"))
        # M10: desktop supervision. Pairing is enabled
        # and a one-time code minted through the host's
        # own loopback calls (the gate page IS the
        # host), the client context is forced (the
        # gate has no GhostNative), and the panel is
        # driven through its real pair flow: form,
        # paired task list, and a task detail with the
        # follow-up composer.
        minted = await page.evaluate(
            """async () => {
              const post = async (url, body) => {
                const resp = await fetch(url, {
                  method: "POST",
                  headers: { "Content-Type":
                    "application/json" },
                  body: JSON.stringify(body) });
                return resp.json();
              };
              const en = await post(
                "/api/supervision/enable",
                { enabled: true });
              const cd = await post(
                "/api/supervision/code", {});
              return !!en.enabled && !!cd.code
                ? cd.code : null;
            }""")
        if not minted:
            results.append(f"{tag} supervision-pair: "
                           "enabling pairing or minting "
                           "the code failed")
        await page.evaluate(
            "window.__ghostSupervisionClient && "
            "window.__ghostSupervisionClient"
            ".supClientForced(true)")
        await js_click(page.locator("#toolsBtn"))
        await page.wait_for_selector(
            "#toolsPanel:not(.hidden)")
        await js_click(page.locator(
            "#toolSupervision"))
        await page.wait_for_selector(
            "#supervisionPanel:not(.hidden)")
        await page.wait_for_timeout(400)
        form = await page.evaluate(
            "() => { const c = document.getElementById("
            "'supPairCode'); const b = document"
            ".getElementById('supPairBtn'); const p = "
            "document.getElementById("
            "'supervisionPanel'); return !!c && !!b "
            "&& p.textContent.includes('plain HTTP'); "
            "}")
        if not form:
            results.append(f"{tag} supervision-pair: "
                           "the pairing form or the "
                           "transport line did not "
                           "render")
        await measure(page, f"{tag} supervision-pair",
                      results)
        await page.fill("#supPairCode", minted or "")
        await js_click(page.locator("#supPairBtn"))
        await page.wait_for_timeout(600)
        paired = await page.evaluate(
            "() => { const p = document.getElementById("
            "'supervisionPanel'); const m = document"
            ".getElementById('supMsg'); return !!p && "
            "m.textContent.includes('Paired') && "
            "p.textContent.includes("
            "'Gate fixture task') && p.textContent"
            ".includes('Approvals waiting'); }")
        if not paired:
            results.append(f"{tag} supervision-tasks: "
                           "the paired view did not "
                           "list the desktop's tasks")
        await measure(page, f"{tag} supervision-tasks",
                      results)
        await js_click(page.locator(
            "#supBody .taskRow",
            has_text="Gate fixture task"))
        await page.wait_for_timeout(600)
        detailed = await page.evaluate(
            "() => { const t = document.getElementById("
            "'supFollowupText'); const b = document"
            ".getElementById('supFollowupBtn'); "
            "const p = document.getElementById("
            "'supervisionPanel'); return !!t && !!b "
            "&& p.textContent.includes('Follow-ups'); "
            "}")
        if not detailed:
            results.append(f"{tag} supervision-detail: "
                           "the detail did not show "
                           "the follow-up composer")
        await measure(page,
                      f"{tag} supervision-detail",
                      results)
        await page.evaluate(
            "window.__ghostSupervisionClient && "
            "window.__ghostSupervisionClient"
            ".supClientForced(null)")
        await js_click(page.locator(
            "#supervisionClose"))
    await js_click(page.locator("#ckptBtn"))
    await page.wait_for_selector("#todoPanel:not(.hidden)")
    await page.wait_for_timeout(300)
    await measure(page, f"{tag} todo-checkpoints", results)
    await js_click(page.locator("#todoClose"))


async def states_wsB(page, w, results):
    phone = w <= 900
    tag = f"{w}px wsB"
    await page.wait_for_function("window.__ghostBooted === true")
    await page.wait_for_timeout(450)
    if phone:
        await js_click(page.locator("#viewGit"))
        await page.wait_for_timeout(300)
        await page.evaluate(
            "document.getElementById('gitPanel')"
            ".scrollIntoView()")
        await page.wait_for_timeout(300)
    row = page.locator("#gitChanges .gitRow",
                       has_text="conflict.py").first
    await row.evaluate("el => el.scrollIntoView()")
    await js_click(row.get_by_role("button", name="Resolve"))
    await page.wait_for_selector("#conflictPanel:not(.hidden)")
    await page.wait_for_timeout(250)
    await measure(page, f"{tag} conflict-editor", results)
    if phone:
        # M4: the card resolver is the phone presentation
        # of the same editor. Prove the cards are what
        # shows (panes hidden), resolve the fixture's one
        # block through the card itself, and measure both
        # states clean.
        shown = await page.evaluate(
            "() => { const c = document.getElementById("
            "'conflictCards'); const p = document"
            ".getElementById('conflictPanes'); "
            "const cs = getComputedStyle(c); "
            "const ps = getComputedStyle(p); "
            "return cs.display !== 'none' && "
            "ps.display === 'none' && "
            "c.textContent.includes('Conflict 1 of 1'); }")
        if not shown:
            results.append(f"{tag} conflict-cards: card "
                           "resolver not the presentation")
        await measure(page, f"{tag} conflict-cards", results)
        await page.evaluate(
            "() => { const bs = document.querySelectorAll("
            "'#conflictCards .conflictCardBtns button'); "
            "for (const b of bs) if (b.textContent === "
            "'Use ours') { b.click(); return; } }")
        await page.wait_for_timeout(250)
        done = await page.evaluate(
            "() => { const c = document.getElementById("
            "'conflictCards'); const n = document"
            ".getElementById('conflictCount'); "
            "return c.textContent.includes("
            "'All 1 conflicts resolved') && "
            "n.textContent.includes("
            "'Conflicts remaining: 0'); }")
        if not done:
            results.append(f"{tag} conflict-cards: Use "
                           "ours did not resolve the block")
        await measure(page, f"{tag} conflict-cards-done",
                      results)
    await js_click(page.locator("#conflictClose"))


async def run_gate(selftest=False):
    from playwright.async_api import async_playwright
    tmp = Path(tempfile.mkdtemp(prefix="viewport-gate-"))
    wsA, wsB = make_fixtures(tmp)
    servers = [start_server(BASE_PORT, wsA),
               start_server(BASE_PORT + 1, wsB)]
    results = []
    try:
        async with async_playwright() as p:
            browser = await p.firefox.launch(
                executable_path=FIREFOX)
            _ctx_timeout = 8000
            if selftest:
                page = await browser.new_page(
                    viewport={"width": 360, "height": 740})
                await page.goto(
                    f"http://127.0.0.1:{BASE_PORT}/")
                await page.wait_for_function(
                    "window.__ghostBooted === true")
                await page.wait_for_timeout(450)
                await js_click(page.locator("#viewFiles"))
                await page.wait_for_timeout(300)
                await js_click(page.locator("#viewGit"))
                await page.wait_for_timeout(300)
                clean = []
                await measure(page, "selftest clean", clean)
                await page.add_style_tag(content=(
                    ".git-commit { flex-wrap: nowrap "
                    "!important; }"
                    ".git-commit input { flex: 0 0 160px "
                    "!important; }"))
                await page.wait_for_timeout(200)
                buggy = []
                await measure(page, "selftest bug", buggy)
                print(f"SELFTEST clean tree: "
                      f"{len(clean)} failures")
                for f in buggy:
                    print("SELFTEST bug caught: " + f)
                if clean:
                    print("SELFTEST INCONCLUSIVE: clean tree "
                          "already fails")
                    return 1
                if not buggy:
                    print("SELFTEST FAILED: the gate is "
                          "blind to the 3.10.1 bug class")
                    return 1
                print("SELFTEST PASS: gate catches the "
                      "reintroduced 3.10.1 bug")
                return 0
            for (w, h) in VIEWPORTS:
                before = len(results)
                page = await browser.new_page(
                    viewport={"width": w, "height": h})
                page.set_default_timeout(8000)
                try:
                    await page.goto(
                        f"http://127.0.0.1:{BASE_PORT}/")
                    await states_wsA(page, w, results)
                    await page.goto(
                        f"http://127.0.0.1:{BASE_PORT + 1}/")
                    await states_wsB(page, w, results)
                except Exception as e:
                    results.append(
                        f"{w}px DRIVE ERROR: "
                        + str(e).splitlines()[0][:200])
                print(f"VIEWPORT {w}x{h}: "
                      f"{len(results) - before} failures")
                await page.close()
            await browser.close()
    finally:
        for s in servers:
            s.terminate()
    for f in results:
        print("FAIL " + f)
    print(f"VIEWPORT GATE: {len(VIEWPORTS)} viewports, "
          f"{_MEASURES[0]} states, {len(results)} failures")
    return 1 if results else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(
        run_gate(selftest="--selftest" in sys.argv)))
