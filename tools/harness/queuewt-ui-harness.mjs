// Queue + worktrees + watch proof (v2.45, E10/E15/E16):
// the Approve queue panel decides through /api/approve/*,
// the agent's queue policy routes RUN/DELETE there, the
// Git panel manages worktrees, and the watch feed diffs
// /api/files mtimes against the rendered baseline.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const srv = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@QUEUEWT@@*/"), b = src.indexOf("/*@@QUEUEWT-END@@*/");
ck("QUEUEWT block markers present", a >= 0 && b > a);
const block = src.slice(a, b);
ck("queue panel lists, decides and audits through the routes",
   block.includes('fetch("/api/approve/list")') &&
   block.includes('postJson("/api/approve/decide"') &&
   block.includes('fetch("/api/approve/audit")'));
ck("panel states the queue rule (nothing self-executes)",
   block.includes("Nothing here executes on its"));
ck("Tools menu has the queue entry",
   html.includes('id="toolApprove"') &&
   block.includes("toolApproveBtn.onclick"));
ck("policy select offers the queue policy",
   html.includes('value="queue"') &&
   html.includes("Queue commands + deletes for approval"));
ck("agent RUN routes to the queue under the queue policy",
   src.includes('policy === "queue"') &&
   src.includes('postJson("/api/approve/enqueue",') &&
   src.includes('kind: "run", command: act.command'));
ck("agent DELETE routes to the queue under the queue policy",
   src.includes('kind: "delete", path: act.path') &&
   src.includes("has NOT happened"));
ck("rules warn the model about queueing",
   src.includes("may go to an approval queue instead of happening"));
ck("worktree UI lists, opens and removes",
   block.includes('fetch("/api/git/worktrees")') &&
   block.includes("switchWorkspace(t.path)") &&
   block.includes('postJson("/api/git/worktree/remove"'));
ck("worktree add posts the name and re-renders",
   block.includes('postJson("/api/git/worktree/add"') &&
   html.includes('id="wtAdd"') && html.includes('id="wtList"'));
ck("refreshGit refreshes the worktree list",
   src.includes("renderWorktrees();"));
ck("watch feed diffs mtimes against the loadFiles baseline",
   block.includes("function watchObserve(files)") &&
   block.includes("setInterval(watchTick, 8000)") &&
   src.includes("watchObserve(d.files || [])") &&
   html.includes('id="watchFeed"'));
ck("desktop enqueue is hash-bound via the tool, IDE executes",
   srv.includes("def approve_enqueue(") &&
   srv.includes('"ingest", str(fpath), "--store"') &&
   srv.includes('rec.get("hash")') &&
   srv.includes('r = _term_run(str(payload.get("command") or ""))'));
ck("desktop refuses queue abuse (bad kind, missing file, main worktree)",
   srv.includes("unknown queue kind: ") &&
   srv.includes("delete target is not a file in ") &&
   srv.includes("the main workspace cannot be "));
ck("desktop files carry mtime for the watch feed",
   srv.includes('entry["mtime"] = int('));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
