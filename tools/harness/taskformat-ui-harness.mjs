// Mobile Cycle 3 (S1): portable task records, the
// ghostide.task format.
//
// Static pins: the TASKFORMAT block exists with the
// census unchanged, the run writer posts BOTH records
// (postRunRecord is the one writer of run-derived task
// records), the Tasks panel is in the page, the tools
// grid and the overlay list, the record-only honesty
// copy is present with no em dashes, both servers carry
// the task routes with the shared validation words, the
// Java mirror (TaskStore) and the schema document exist,
// and the viewport gate carries the two task states.
//
// Live pins: the RUNREVIEW + TASKFORMAT region is
// extracted from main.js and driven with fixtures - the
// builder maps a finished run onto the format (outcome
// to status table, approvals summary, step summary,
// checkpoint link), the client validation mirror refuses
// by name (above all the newer-schema refusal), the
// shared fixture validates through the mirror, and the
// import copy remaps identity while leaving every
// canonical field untouched.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const apkRoot = home + "/workspace/ghostide-apk-build/";
const src = readFileSync(root + "web/src/main.js", "utf8");
const app = readFileSync(root + "web/app.js", "utf8");
const html = readFileSync(root + "web/index.html", "utf8");
const css = readFileSync(root + "web/style.css", "utf8");
const gate = readFileSync(root + "tools/viewport_gate.py",
  "utf8");
const serverPy = readFileSync(root + "server.py", "utf8");
const doc = readFileSync(root + "docs/TASK_FORMAT.md",
  "utf8");
const ideServer = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/IdeServer.java",
  "utf8");
const taskStore = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/TaskStore.java",
  "utf8");
const fixture = JSON.parse(readFileSync(root +
  "tests/fixtures/task_record_v1.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => {
  console.log((c ? "PASS " : "FAIL ") + n);
  c ? passed++ : failed++;
};

const block = src.split("/*@@TASKFORMAT@@*/")[1]
  .split("/*@@TASKFORMAT-END@@*/")[0];
const region = src.split("/*@@RUNREVIEW@@*/")[1]
  .split("/*@@TASKFORMAT-END@@*/")[0];

/* ---------- static pins ---------- */
ck("S1 bundle: block markers, hook, and the census " +
   "unchanged at 101",
   src.includes("/*@@TASKFORMAT@@*/") &&
   src.includes("/*@@TASKFORMAT-END@@*/") &&
   (src.match(/innerHTML/g) || []).length === 101 &&
   (app.match(/innerHTML/g) || []).length === 101 &&
   app.includes("__ghostTasks"));
ck("S1 writer: postRunRecord is the one writer of " +
   "run-derived task records (both posts, one place)",
   src.includes('postJson("/api/agent-runs", rec)') &&
   src.includes('postJson("/api/tasks", task)') &&
   src.includes("the ONE writer of run-derived task "
     + "records"));
ck("S1 panel: the Tasks panel, its parts and the " +
   "tools entry are in the page",
   html.includes('id="tasksPanel"') &&
   html.includes('id="tasksList"') &&
   html.includes('id="taskDetail"') &&
   html.includes('id="taskImportBtn"') &&
   html.includes('id="taskImportFile"') &&
   html.includes('id="toolTasks"') &&
   src.includes('"tasksPanel"]') &&
   src.includes('$("toolTasks")') &&
   css.includes("#tasksPanel"));
ck("S1 honesty: the record-only label is written out, "
   + "and no S1 copy uses an em dash",
   /* M2 (3.25.0) kept the promise this label made:
      resuming arrived with supervision, so the label
      now reads as the ended-run truth ("Record only.
      This run has ended...") and interrupted records
      carry the M2 copy instead. Pin follows the
      measured truth, move recorded here. */
   src.includes("Record only. This run has ended, "
     + "and the") &&
   src.includes("Interrupted. This run was ") &&
   !block.includes("—") &&
   !html.split('id="tasksPanel"')[1]
     .split("</div>\n\n<div")[0].includes("—") &&
   !doc.includes("—"));
ck("S1 servers: both carry the task routes with the " +
   "shared validation words",
   serverPy.includes('parsed.path == "/api/tasks"') &&
   serverPy.includes('"/api/tasks/update"') &&
   serverPy.includes("written by a newer GhostIDE") &&
   ideServer.includes('path.equals("/api/tasks")') &&
   ideServer.includes('path.equals("/api/tasks/update")') &&
   taskStore.includes("written by a newer ") &&
   taskStore.includes('SCHEMA = "ghostide.task"'));
ck("S1 doc: the schema is defined once, in the repo "
   + "document",
   doc.includes("# GhostIDE task records") &&
   doc.includes("ghostide.task") &&
   doc.includes("waiting-approval") &&
   doc.includes("importedFrom") &&
   doc.includes("Canonical form"));
ck("S1 gate: the viewport gate carries the task list "
   + "and detail states",
   gate.includes("tasks-list") &&
   gate.includes("tasks-detail") &&
   gate.includes("Record only"));

/* ---------- live pins ---------- */
const fakeWindow = {};
const api = new Function("window",
  region + "; return { makeTaskId, taskPlatform, "
  + "taskStatusFromOutcome, taskApprovalsSummary, "
  + "buildTaskRecordFromRun, validateTaskRecord, "
  + "taskImportCopy, TASK_SCHEMA, TASK_MAX_BYTES };"
)(fakeWindow);
const { makeTaskId, taskStatusFromOutcome,
  taskApprovalsSummary, buildTaskRecordFromRun,
  validateTaskRecord, taskImportCopy } = api;

ck("S1 live: the outcome to status table follows the "
   + "document",
   taskStatusFromOutcome("done") === "done" &&
   taskStatusFromOutcome("asked") === "done" &&
   taskStatusFromOutcome("failed") === "failed" &&
   taskStatusFromOutcome("stopped") === "stopped" &&
   taskStatusFromOutcome("cap") === "stopped" &&
   taskStatusFromOutcome("looping") === "stopped" &&
   taskStatusFromOutcome("mystery") === "failed");
ck("S1 live: the approvals summary counts what the "
   + "policy did",
   JSON.stringify(taskApprovalsSummary([
     { verdict: "allowed" }, { verdict: "auto" },
     { verdict: "granted" }, { verdict: "denied" },
     { verdict: "disabled" }, { verdict: "queued" }]))
   === JSON.stringify(
     { asked: 6, allowed: 3, denied: 2 }));
const built = buildTaskRecordFromRun({
  id: "run-20261118-120000-ab12cd", mode: "act",
  task: "Fix the crash\nin the parser",
  startedAt: "2026-11-18T12:00:00",
  endedAt: "2026-11-18T12:01:00", outcome: "cap",
  summary: "hit the cap",
  steps: [{ step: 1, type: "read", target: "a.py" },
          { step: 2, type: "edit", target: "a.py" }],
  approvals: [{ verdict: "allowed" }],
  filesChanged: [{ path: "a.py", kind: "modified" }],
  checkpoint: ".ghostide/checkpoints/ckpt-run-x.json",
  planPath: null, skipped: [],
}, { id: "task-20261118-120000-ab12cd",
     platform: "android", workspace: "on-device",
     stepCap: 25 });
ck("S1 live: a finished run builds a valid record in "
   + "the shared format",
   validateTaskRecord(built, 1000) === null &&
   built.kind === "agent-run" &&
   built.status === "stopped" &&
   built.title === "Fix the crash" &&
   built.goal.startsWith("Fix the crash") &&
   built.budget.stepCap === 25 &&
   built.steps.count === 2 &&
   built.steps.lastLabel === "edit a.py" &&
   built.checkpoint.endsWith("ckpt-run-x.json") &&
   built.payload.runId === "run-20261118-120000-ab12cd" &&
   built.payload.outcome === "cap" &&
   built.createdBy === "android");
ck("S1 live: a plan run builds a plan record",
   buildTaskRecordFromRun({ mode: "plan", task: "Plan it",
     outcome: "done", steps: [], approvals: [] },
     { platform: "desktop", workspace: "/w",
       stepCap: 50 }).kind === "plan");
ck("S1 live: the shared fixture validates through the "
   + "client mirror",
   validateTaskRecord(fixture, 1000) === null);
ck("S1 live: validation refuses by name, the newer "
   + "schema first of all",
   validateTaskRecord({ ...fixture, schemaVersion: 2 },
     1000) === "task record was written by a newer "
     + "GhostIDE (task schema version 2); this build "
     + "reads version 1" &&
   validateTaskRecord({ ...fixture, schema: "other" },
     1000) === "not a GhostIDE task record" &&
   validateTaskRecord({ ...fixture, status: "paused" },
     1000).includes("status must be one of") &&
   validateTaskRecord({ ...fixture,
     budget: { stepCap: true } }, 1000)
     .includes("budget.stepCap must be an integer") &&
   validateTaskRecord(fixture, api.TASK_MAX_BYTES + 1)
     .includes("task record too large"));
ck("S1 live: the import copy remaps identity and "
   + "nothing else",
   (() => {
     const copy = taskImportCopy(fixture,
       "task-20261118-180200-zz99zz",
       "2026-11-18T18:02:00");
     const strip = (r) => {
       const c = { ...r };
       delete c.id; delete c.provenance;
       return JSON.stringify(c);
     };
     return copy.id === "task-20261118-180200-zz99zz" &&
       strip(copy) === strip(fixture) &&
       copy.provenance.importedFrom.id === fixture.id &&
       copy.provenance.importedFrom.platform ===
         fixture.createdBy &&
       copy.createdBy === fixture.createdBy &&
       fixture.provenance === undefined &&
       validateTaskRecord(copy, 1000) === null;
   })());
ck("S1 live: task ids follow the house id shape",
   /^task-\d{8}-\d{6}-[a-z0-9]{4,6}$/.test(
     makeTaskId(new Date(2026, 10, 18, 12, 0, 0),
       "ab12cd")) &&
   makeTaskId(new Date(2026, 10, 18, 12, 0, 0), "ab12cd")
     === "task-20261118-120000-ab12cd");

console.log("TASKFORMAT (S1): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
