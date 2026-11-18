// Desktop Cycle 2, D2 (v3.13.0; version checks made agreement-based in D8): the agent trust
// layer. Static pins over the shipped sources, pure
// function proofs (extracted between the AGENT2 and
// RUNREVIEW markers), and a full HTTP end-to-end
// against a real server subprocess driving the exact
// calls the client makes: plan file written and
// re-read (user edits win), run checkpoint created,
// run record posted and listed, changes applied, the
// review diff computed from the checkpoint base, one
// hunk reversed on its own, one file undone on its
// own, and UNDO ALL resurrecting a deleted file and
// removing a created one.
import { readFileSync, mkdtempSync, mkdirSync,
  writeFileSync, copyFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const py = readFileSync(root + "server.py", "utf8");
const src = readFileSync(root + "web/src/main.js", "utf8");
const vjson = JSON.parse(readFileSync(root + "VERSION.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

/* ---------- static pins ---------- */
ck("D2 version: desktop train moved past 3.13.0, phone train re-synced at M1",
   vjson.desktop && vjson.desktop.version !== "3.10.1" &&
   py.includes('APP_VERSION = "' + vjson.desktop.version + '"') &&
   vjson.version === vjson.desktop.version &&
   vjson.latest === vjson.desktop.version &&
   vjson.android && vjson.android.version === vjson.desktop.version);
ck("D2 route census re-derived (166 + 2 run-record routes in D2, +10 MCP in D8, +12 LSP in D4, +5 embed in D5 = 183) (Mobile Cycle 3 S1: +3 desktop / +2 Java task-record routes)",
   (py.match(/parsed\.path ==/g) || []).length === 197);
ck("D2 server: run records validated, capped, stored as data",
   py.includes('"/api/agent-runs"') &&
   py.includes("AGENT_RUN_MAX_BYTES = 256 * 1024") &&
   py.includes('data.get("kind") != "ghostide-agent-run"') &&
   py.includes("def _save_agent_run") &&
   py.includes("def _list_agent_runs"));
ck("D2 server: diff-text honors an explicit base",
   py.includes('if data.get("base") is not None:'));
ck("D2 client: plan file written, Act re-reads the file",
   src.includes("planFilePath(new Date())") &&
   src.includes("buildPlanFile(task, planText, todos,") &&
   src.includes("planBodyFromFile(d.content)") &&
   src.includes("runAgent(task, { plan: effective, todos, planPath })"));
ck("D2 client: lazy run-checkpoint capture on write/edit/delete",
   (src.match(/await captureRunOriginal\(act\.path\)/g) || []).length === 3 &&
   src.includes("content.length > RUN_CKPT_MAX_CHARS") &&
   src.includes("payload.run = true"));
ck("D2 client: run record posted at the end of act and plan runs",
   (src.match(/postRunRecord\(\{ id: runId, mode: "act"/g) || []).length === 1 &&
   src.includes('postRunRecord({ id: planRunId, mode: "plan"') &&
   /* S1 (3.24.0) moved the literal: postRunRecord now binds
      const rec = buildRunRecord(fields) once and posts that
      same record to /api/agent-runs and derives the portable
      task record from it (one writer, no drift). The pin
      follows the measured truth. */
   src.includes("const rec = buildRunRecord(fields)") &&
   src.includes('postJson("/api/agent-runs", rec)'));
ck("D2 client: approvals are recorded (run, delete, mcp; queued too)",
   src.includes('runApprovals.push({ kind: "run",') &&
   src.includes('runApprovals.push({ kind: "delete",') &&
   src.includes('runApprovals.push({ kind: "mcp",'));
ck("D2 client: post-run review with keep/undo/hunks, reopenable",
   src.includes("async function openRunReview(ctx)") &&
   src.includes("UNDO ALL (") &&
   src.includes("Not covered by undo (too large") &&
   src.includes("Review run changes"));

/* ---------- pure functions ---------- */
const block2 = src.split("/*@@AGENT2@@*/")[1].split("/*@@AGENT2-END@@*/")[0];
const blockR = src.split("/*@@RUNREVIEW@@*/")[1].split("/*@@RUNREVIEW-END@@*/")[0];
const F = new Function("window", block2 + "\n" + blockR +
  "; return { buildDiskCheckpoint, normalizeAgentTodos," +
  " agentRunStamp, makeAgentRunId, runCheckpointPath," +
  " planFilePath, buildPlanFile, planBodyFromFile," +
  " splitRunOriginals, runChangeKind, parseUnifiedDiff," +
  " reverseUnifiedHunk, buildRunRecord };")({});

ck("run id + checkpoint + plan paths are shaped as specified",
   F.makeAgentRunId(new Date(2026, 10, 17, 1, 2, 3), "x7k2zz") ===
     "run-20261117-010203-x7k2zz" &&
   F.runCheckpointPath("run-20261117-010203-x7k2zz") ===
     ".ghostide/checkpoints/ckpt-run-20261117-010203-x7k2zz.json" &&
   F.planFilePath(new Date(2026, 10, 17, 1, 2, 3)) ===
     ".ghostide/plans/plan-20261117-010203.md");
const planFile = F.buildPlanFile("do the thing", "Step one, then two.",
  [{ text: "first", done: false }, { text: "second", done: true }],
  new Date(2026, 10, 17, 1, 2, 3));
ck("plan file carries task, steps and the plan body after ---",
   planFile.startsWith("# GhostIDE plan") &&
   planFile.includes("1. first") && planFile.includes("2. second") &&
   F.planBodyFromFile(planFile) === "Step one, then two.");
ck("plan body: a user-replaced file (no header) is used as-is",
   F.planBodyFromFile("my own plan\nwith lines") === "my own plan\nwith lines");
const split = F.splitRunOriginals(
  { "a.py": "old", "b.py": null, "c.py": "gone soon" }, ["c.py"]);
ck("run originals split into files vs deleted for the checkpoint",
   split.files["a.py"] === "old" && split.files["b.py"] === null &&
   split.deleted["c.py"] === "gone soon" &&
   F.runChangeKind("b.py", { "b.py": null }, []) === "created" &&
   F.runChangeKind("c.py", {}, ["c.py"]) === "deleted" &&
   F.runChangeKind("a.py", { "a.py": "old" }, []) === "modified");
const rec = F.buildRunRecord({ id: "run-1", mode: "act", task: "t",
  steps: [{ step: 1, type: "edit", target: "a.py" }],
  approvals: [{ kind: "run", target: "ls", verdict: "granted" }],
  filesChanged: [{ path: "a.py", kind: "modified" }],
  checkpoint: "ck", skipped: ["big.bin"] });
ck("run record builds with the fixed shape",
   rec.kind === "ghostide-agent-run" && rec.version === 1 &&
   rec.steps[0].type === "edit" && rec.skipped[0] === "big.bin");

/* diff / hunk pure proofs (diff text from the real
   system diff, same shape the server emits) */
import { execFileSync } from "node:child_process";
const td0 = mkdtempSync(tmpdir() + "/ghostide-d2-pure-");
const orig20 = Array.from({ length: 20 }, (_, i) =>
  "line " + (i + 1)).join("\n") + "\n";
const edited20 = orig20.replace("line 2", "CHANGED 2")
  .replace("line 19", "CHANGED 19");
writeFileSync(td0 + "/a.txt", orig20);
writeFileSync(td0 + "/b.txt", edited20);
let diffText = "";
try {
  execFileSync("diff", ["-u", "--label", "a/mod.py",
    "--label", "b/mod.py", td0 + "/a.txt", td0 + "/b.txt"],
    { encoding: "utf8" });
} catch (e) { diffText = e.stdout; }
const hunks = F.parseUnifiedDiff(diffText);
ck("two distant edits parse as two hunks",
   hunks.length === 2 && hunks[0].lines.some((l) => l.t === "+"));
const back1 = F.reverseUnifiedHunk(edited20, hunks[0]);
ck("reversing hunk 1 restores only its region",
   back1.ok && back1.content.includes("line 2") &&
   back1.content.includes("CHANGED 19") &&
   !back1.content.includes("CHANGED 2"));
const back2 = F.reverseUnifiedHunk(back1.content, hunks[1]);
ck("reversing hunk 2 after hunk 1 returns the exact original",
   back2.ok && back2.content === orig20);
const drifted = edited20.replace("CHANGED 19", "USER EDIT 19");
const refused = F.reverseUnifiedHunk(drifted, hunks[1]);
ck("a hunk whose text drifted is refused, not guessed",
   !refused.ok && /no longer matches/.test(refused.error));

/* ---------- HTTP end-to-end ---------- */
const td = mkdtempSync(tmpdir() + "/ghostide-d2-e2e-");
const app = td + "/app";
mkdirSync(app + "/web", { recursive: true });
mkdirSync(app + "/playground", { recursive: true });
for (const f of ["server.py", "ghost_paths.py", "updater.py",
    "workspace_trust.py", "lsp_manager.py", "embed_index.py", "debug_bridge.py",
    "VERSION.json"])
  copyFileSync(root + f, app + "/" + f);
writeFileSync(app + "/web/index.html", "<html></html>");
const ws = td + "/ws";
mkdirSync(ws, { recursive: true });
const MOD_ORIG = orig20;
writeFileSync(ws + "/mod.py", MOD_ORIG);
writeFileSync(ws + "/del.py", "to be deleted\n");
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.method === "POST"
      ? { choices: [{ message: { role: "assistant", content: "ok" } }] }
      : { status: "ok" }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const llamaPort = stub.address().port;
const port = 24000 + Math.floor(Math.random() * 2000);
const proc = spawn("python3", [app + "/server.py"], {
  cwd: app,
  env: { ...process.env, HOME: td + "/home",
    GHOST_IDE_PORT: String(port),
    GHOST_IDE_WORKSPACE: ws,
    LLAMA_BASE: "http://127.0.0.1:" + llamaPort,
    PYTHONDONTWRITEBYTECODE: "1" },
  stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
proc.stdout.on("data", (d) => serverLog += d);
proc.stderr.on("data", (d) => serverLog += d);
const base = "http://127.0.0.1:" + port;
async function call(method, path, body) {
  const r = await fetch(base + path, { method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
try {
  let up = false;
  for (let i = 0; i < 75 && !up; i++) {
    try {
      const h = await call("GET", "/api/health");
      up = h.status === 200;
    } catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!up) throw new Error("server did not come up:\n" + serverLog);
  const health = await call("GET", "/api/health");
  ck("E2E server reports the desktop version", health.data.version === vjson.desktop.version);

  /* 1. plan file: written, re-read, user edit wins */
  const planPath = F.planFilePath(new Date(2026, 10, 17, 1, 0, 0));
  let w = await call("POST", "/api/file", { path: planPath,
    content: F.buildPlanFile("fixture task", "original plan body",
      [{ text: "step one", done: false }], new Date()) });
  ck("E2E plan file written into the workspace", w.status === 200 &&
     existsSync(ws + "/" + planPath));
  let rd = await call("GET", "/api/file?path=" + encodeURIComponent(planPath));
  ck("E2E plan body re-read from the file",
     F.planBodyFromFile(rd.data.content) === "original plan body");
  await call("POST", "/api/file", { path: planPath,
    content: rd.data.content.replace("original plan body", "EDITED plan body") });
  rd = await call("GET", "/api/file?path=" + encodeURIComponent(planPath));
  ck("E2E a user edit to the plan file is what Act would execute",
     F.planBodyFromFile(rd.data.content) === "EDITED plan body");

  /* 2. run checkpoint: lazy capture + write-through */
  const runId = F.makeAgentRunId(new Date(2026, 10, 17, 1, 0, 30), "e2e42");
  const ckptPath = F.runCheckpointPath(runId);
  const originals = {};
  for (const p of ["mod.py", "del.py", "new.py"]) {
    const d = await call("GET", "/api/file?path=" + encodeURIComponent(p));
    originals[p] = d.data.error ? null : d.data.content;
  }
  const splitE = F.splitRunOriginals(originals, ["del.py"]);
  const payload = F.buildDiskCheckpoint("fixture task",
    splitE.files, splitE.deleted);
  payload.runId = runId; payload.run = true; payload.skipped = [];
  w = await call("POST", "/api/file", { path: ckptPath,
    content: JSON.stringify(payload) });
  ck("E2E run checkpoint created with pre-run originals",
     w.status === 200 && existsSync(ws + "/" + ckptPath) &&
     originals["mod.py"] === MOD_ORIG && originals["new.py"] === null &&
     splitE.deleted["del.py"] === "to be deleted\n");

  /* 3. run record posted, listed, fetched */
  const record = F.buildRunRecord({ id: runId, mode: "act",
    task: "fixture task", planPath,
    startedAt: "2026-11-17T01:00:30", endedAt: "2026-11-17T01:01:00",
    outcome: "done", summary: "fixture",
    steps: [{ step: 1, type: "edit", target: "mod.py" },
            { step: 2, type: "write", target: "new.py" },
            { step: 3, type: "delete", target: "del.py" }],
    approvals: [{ kind: "run", target: "ls", verdict: "granted" }],
    filesChanged: [{ path: "mod.py", kind: "modified" },
      { path: "new.py", kind: "created" },
      { path: "del.py", kind: "deleted" }],
    checkpoint: ckptPath, skipped: [] });
  const pr = await call("POST", "/api/agent-runs", record);
  const lst = await call("GET", "/api/agent-runs");
  const one = await call("GET", "/api/agent-runs?id=" + runId);
  ck("E2E run record posted, listed and fetched",
     pr.status === 200 && lst.data.runs.length === 1 &&
     lst.data.runs[0].id === runId &&
     one.data.record.checkpoint === ckptPath &&
     one.data.record.approvals[0].verdict === "granted");

  /* 4. apply the run's changes, like the review does */
  await call("POST", "/api/file", { path: "mod.py", content: edited20 });
  await call("POST", "/api/file", { path: "new.py", content: "brand new\n" });
  await call("POST", "/api/file/delete", { path: "del.py" });
  ck("E2E changes applied (edit, create, delete)",
     readFileSync(ws + "/mod.py", "utf8") === edited20 &&
     existsSync(ws + "/new.py") && !existsSync(ws + "/del.py"));

  /* 5. review diff from the checkpoint base, per-hunk undo */
  const df = await call("POST", "/api/diff-text",
    { path: "mod.py", base: MOD_ORIG, content: edited20 });
  const eHunks = F.parseUnifiedDiff(df.data.diff);
  ck("E2E review diff (checkpoint base) parses to two hunks",
     eHunks.length === 2);
  const h1 = F.reverseUnifiedHunk(edited20, eHunks[0]);
  await call("POST", "/api/file", { path: "mod.py", content: h1.content });
  const afterHunk = readFileSync(ws + "/mod.py", "utf8");
  ck("E2E per-hunk undo restores exactly that hunk's region",
     h1.ok && afterHunk.includes("line 2") &&
     afterHunk.includes("CHANGED 19"));

  /* 6. per-file UNDO restores exactly one file */
  await call("POST", "/api/file",
    { path: "mod.py", content: payload.files["mod.py"] });
  ck("E2E per-file UNDO restores mod.py; the rest is untouched",
     readFileSync(ws + "/mod.py", "utf8") === MOD_ORIG &&
     existsSync(ws + "/new.py") && !existsSync(ws + "/del.py"));

  /* 7. UNDO ALL: resurrect the deleted, remove the created */
  await call("POST", "/api/file",
    { path: "del.py", content: payload.deleted["del.py"] });
  await call("POST", "/api/file/delete", { path: "new.py" });
  ck("E2E UNDO ALL returns the workspace to its pre-run state",
     readFileSync(ws + "/del.py", "utf8") === "to be deleted\n" &&
     !existsSync(ws + "/new.py") &&
     readFileSync(ws + "/mod.py", "utf8") === MOD_ORIG);
} catch (e) {
  ck("E2E completed without exception: " + e.message, false);
} finally {
  proc.kill("SIGTERM");
  stub.close();
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
process.exit(failed ? 1 : 0);
