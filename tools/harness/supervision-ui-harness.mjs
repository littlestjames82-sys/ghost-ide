// Mobile Cycle 3 (M2): on-device supervision.
//
// Static pins: the SUPERVISION block and its hook, the
// census unchanged, the run wiring (record created at
// start on the phone, progress synced at step
// boundaries, the waiting state saved before an
// approval parks the loop, the final write updating
// the same record, the loop counting from the task's
// own offset against the record's cap), the panel's
// interruption copy and Resume wiring with no em
// dashes, the native half (Supervision decisions,
// RunService, the bridge methods, the manifest still
// at 7 permissions), the schema document's M2
// section, and the viewport gate's two M2 states.
//
// Live pins: the TASKFORMAT + SUPERVISION region is
// extracted and driven through a scripted run: a
// fresh supervised record validates in the shared
// format, steps accumulate, an approval wait moves
// the arc, the derived state flips to interrupted
// when no live run stands behind the record, a
// resume restores the arc (running, interrupted,
// running) with the budget still counting across
// segments, the context validates and refuses by
// name when it is missing, foreign, ended, oversized
// or damaged, the continuation briefing summarizes
// instead of replaying, and the notification decision
// grid matches the native one.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const apkRoot = home + "/workspace/ghostide-apk-build/";
const src = readFileSync(root + "web/src/main.js", "utf8");
const app = readFileSync(root + "web/app.js", "utf8");
const gate = readFileSync(root + "tools/viewport_gate.py",
  "utf8");
const doc = readFileSync(root + "docs/TASK_FORMAT.md",
  "utf8");
const mainActivity = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/MainActivity.java",
  "utf8");
const supervisionJava = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/Supervision.java",
  "utf8");
const runService = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/RunService.java",
  "utf8");
const manifest = readFileSync(apkRoot +
  "app/src/main/AndroidManifest.xml", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => {
  console.log((c ? "PASS " : "FAIL ") + n);
  c ? passed++ : failed++;
};

const block = src.split("/*@@SUPERVISION@@*/")[1]
  .split("/*@@SUPERVISION-END@@*/")[0];
const region = src.split("/*@@TASKFORMAT@@*/")[1]
  .split("/*@@SUPERVISION-END@@*/")[0];

/* ---------- static pins ---------- */
ck("M2 bundle: block markers, hook, and the census " +
   "unchanged at 101",
   src.includes("/*@@SUPERVISION@@*/") &&
   src.includes("/*@@SUPERVISION-END@@*/") &&
   (src.match(/innerHTML/g) || []).length === 101 &&
   (app.match(/innerHTML/g) || []).length === 101 &&
   app.includes("__ghostSupervision"));
ck("M2 wiring: the record is created at run start, "
   + "synced at step boundaries, and finished by "
   + "updating the same record (M10: the final "
   + "write's task fields now read through liveRec, "
   + "which is sup.rec on the phone exactly as "
   + "before, or the desktop's pairing record)",
   src.includes("taskRecordCreate(sup.rec)") &&
   src.includes("if (sup) supSync();") &&
   src.includes('postJson("/api/tasks/update", task)') &&
   src.includes("const liveRec = sup ? sup.rec") &&
   src.includes("taskId: liveRec ? liveRec.id : undefined") &&
   src.includes("await sup.chain"));
ck("M2 wiring: approvals save the waiting state "
   + "before the loop parks, on both approval paths",
   (src.match(/await supApprovalBegin\(\)/g) || [])
     .length === 2 &&
   (src.match(/if \(sup\) supApprovalEnd\(\)/g) || [])
     .length === 2 &&
   src.includes('supSync("waiting-approval")') &&
   src.includes("window.GhostNative.approvalNeeded") &&
   src.includes("takeApprovalOpen"));
ck("M2 wiring: resume counts against the task's own "
   + "budget from its own offset",
   src.includes("resumeOf.rec.budget.stepCap") &&
   src.includes("stepOffset + 1") &&
   src.includes("resumeOf.rec.steps.count") &&
   src.includes("for (const t of resumeOf.context"
     + ".trail || [])"));
ck("M2 panel: interruption truth, the resume offer "
   + "and the named refusals, no em dashes",
   src.includes("Interrupted. This run was ") &&
   src.includes("▶ Resume this task") &&
   src.includes("resumeTaskFromRecord") &&
   src.includes("Cannot resume: ") &&
   src.includes("budget for this task is used up") &&
   src.includes("If Android closes the app, a ") &&
   !block.includes("—"));
ck("M2 native: the decision class, the run service "
   + "and the bridge methods, permissions still 7",
   supervisionJava.includes("shouldNotify") &&
   supervisionJava.includes("approvalBody") &&
   supervisionJava.includes("cleanTitle") &&
   runService.includes("startForeground") &&
   runService.includes("Supervision.runBody") &&
   mainActivity.includes("approvalNeeded") &&
   mainActivity.includes("takeApprovalOpen") &&
   mainActivity.includes("RunService.start") &&
   mainActivity.includes("appForeground") &&
   manifest.includes(".RunService") &&
   (manifest.match(/uses-permission/g) || [])
     .length === 7);
ck("M2 doc and gate: the format document carries "
   + "the supervision section, the gate the two "
   + "states",
   doc.includes("Supervision (M2)") &&
   doc.includes("runctx-") &&
   doc.includes("payload.arc") &&
   gate.includes("tasks-interrupted") &&
   gate.includes("tasks-waiting"));

/* ---------- live pins ---------- */
const fakeWindow = {};
const posts = [];
const fakePostJson = (url, body) => {
  posts.push({ url, body });
  return Promise.resolve({ ok: true });
};
const api = new Function("window", "postJson",
  region + "; return { supNewRecord, supSetStatus, "
  + "supApplyStep, taskDisplayState, resumeBudget, "
  + "buildRunContext, fitRunContext, "
  + "validateRunContext, buildResumeBriefing, "
  + "approvalNotifyDecision, supContextPath, "
  + "validateTaskRecord, RUN_CONTEXT_MAX_CHARS };"
)(fakeWindow, fakePostJson);
const { supNewRecord, supSetStatus, supApplyStep,
  taskDisplayState, resumeBudget, buildRunContext,
  fitRunContext, validateRunContext,
  buildResumeBriefing, approvalNotifyDecision,
  supContextPath, validateTaskRecord } = api;

const T0 = "2026-11-18T13:00:00";
const T1 = "2026-11-18T13:01:00";
const T2 = "2026-11-18T13:02:00";
const T3 = "2026-11-18T13:05:00";
const T4 = "2026-11-18T13:06:00";

/* A scripted supervised run, segment 1. */
let rec = supNewRecord({
  id: "task-20261118-130000-m2test", task: "Fix the crash",
  stepCap: 25, workspace: "on-device",
  platform: "android", planPath: null,
  runId: "run-20261118-130000-ab12", at: T0 });
ck("M2 live: a fresh supervised record is a valid "
   + "task record, running, with its context path",
   validateTaskRecord(rec, 1000) === null &&
   rec.status === "running" &&
   rec.payload.segments === 1 &&
   rec.payload.contextPath ===
     supContextPath(rec.id) &&
   rec.payload.arc.length === 1 &&
   rec.payload.arc[0].status === "running");
rec = supApplyStep(rec, { count: 1,
  lastLabel: "read app.py",
  approvals: { asked: 0, allowed: 0, denied: 0 },
  checkpoint: null, at: T1 });
rec = supApplyStep(rec, { count: 2,
  lastLabel: "edit app.py",
  approvals: { asked: 1, allowed: 1, denied: 0 },
  checkpoint: ".ghostide/checkpoints/ckpt-run-x.json",
  at: T2 });
ck("M2 live: step updates accumulate on the record",
   rec.steps.count === 2 &&
   rec.steps.lastLabel === "edit app.py" &&
   rec.approvals.allowed === 1 &&
   rec.checkpoint.endsWith("ckpt-run-x.json") &&
   rec.updatedAt === T2);
rec = supSetStatus(rec, "waiting-approval", T2);
rec = supSetStatus(rec, "running", T2);
ck("M2 live: an approval wait moves the arc and back",
   JSON.stringify(rec.payload.arc.map((e) => e.status))
   === JSON.stringify(
     ["running", "waiting-approval", "running"]) &&
   rec.status === "running");

/* The app dies here. The record is the truth left. */
ck("M2 live: a running record with no live run is "
   + "interrupted; with its live run it is running",
   taskDisplayState(rec, null).interrupted === true &&
   taskDisplayState(rec, null).word === "interrupted" &&
   taskDisplayState(rec, rec.id).interrupted === false &&
   taskDisplayState(rec, rec.id).word === "running" &&
   taskDisplayState({ ...rec, status: "done" }, null)
     .word === "done" &&
   taskDisplayState({ ...rec,
     status: "waiting-approval" }, null).wasWaiting
     === true);

/* Its context, as the writer would have saved it. */
const ctx = buildRunContext({
  taskId: rec.id, runId: "run-20261118-130000-ab12",
  task: "Fix the crash", plan: "",
  todos: [{ text: "fix it", done: false }],
  staged: { "app.py": "def greet():\n  pass\n" },
  deletions: [],
  trail: [{ step: 1, type: "read", target: "app.py" },
          { step: 2, type: "edit", target: "app.py" }],
  approvals: [{ kind: "run", target: "pytest",
    verdict: "granted" }],
  stepCount: 2, at: T2,
  messages: [{ role: "user",
    content: "SECRET-REPLAY-MARKER" }] });
ck("M2 live: the saved context validates for its own "
   + "record",
   validateRunContext(ctx, rec.id) === null &&
   fitRunContext(ctx) === ctx);
ck("M2 live: resume refuses by name, every way the "
   + "context can be wrong",
   validateRunContext(null, rec.id)
     .includes("missing or unreadable") &&
   validateRunContext({ ...ctx, taskId: "task-other" },
     rec.id).includes("different task record") &&
   validateRunContext({ ...ctx, ended: true,
     outcome: "done" }, rec.id)
     .includes("already ended") &&
   validateRunContext({ ...ctx, tooLarge: true },
     rec.id).includes("too large") &&
   validateRunContext({ ...ctx, kind: "other" },
     rec.id).includes("not a run context") &&
   validateRunContext({ ...ctx, staged: [] }, rec.id)
     .includes("damaged (staged changes)"));
const bigStaged = {};
for (let i = 0; i < 30; i++)
  bigStaged["big" + i + ".py"] =
    "x".repeat(60000);
ck("M2 live: an oversized context does not fit and "
   + "is never silently truncated into validity",
   fitRunContext(buildRunContext({
     taskId: rec.id, task: "t", staged: bigStaged,
     trail: [], approvals: [], stepCount: 0,
     at: T2 })) === null);

/* Segment 2: the resume, exactly as runAgent does it. */
ck("M2 live: the budget counts across segments",
   resumeBudget(rec).remaining === 23 &&
   resumeBudget({ ...rec,
     steps: { count: 25, lastLabel: "" } }).remaining
     === 0);
let rec2 = supSetStatus(rec, "interrupted",
  rec.updatedAt);
rec2 = supSetStatus(rec2, "running", T3);
rec2.payload.segments =
  (rec2.payload.segments | 0) + 1;
rec2 = supApplyStep(rec2, { count: 3,
  lastLabel: "run pytest",
  approvals: { asked: 1, allowed: 1, denied: 0 },
  checkpoint: null, at: T4 });
rec2 = supSetStatus(rec2, "done", T4);
ck("M2 live: the resumed arc reads running, "
   + "interrupted, running, done, steps cumulative",
   JSON.stringify(rec2.payload.arc.map((e) => e.status))
   === JSON.stringify(["running", "waiting-approval",
     "running", "interrupted", "running", "done"]) &&
   rec2.payload.segments === 2 &&
   rec2.steps.count === 3 &&
   validateTaskRecord(rec2, 1000) === null);
const briefing = buildResumeBriefing(rec, ctx);
ck("M2 live: the briefing summarizes the record and "
   + "never replays the old conversation",
   briefing.includes("CONTINUATION") &&
   briefing.includes("25 steps across all segments") &&
   briefing.includes("you have 23 left") &&
   briefing.includes("edit app.py") &&
   briefing.includes("app.py") &&
   briefing.includes("STILL STAGED") &&
   !briefing.includes("SECRET-REPLAY-MARKER"));

/* The notification decision grid, bundle half. */
ck("M2 live: backgrounded and granted notifies; "
   + "foregrounded does not; denied does not",
   approvalNotifyDecision({ waiting: true,
     pageHidden: true, granted: true }) === "notify" &&
   approvalNotifyDecision({ waiting: true,
     pageHidden: false, granted: true })
     === "foreground" &&
   approvalNotifyDecision({ waiting: true,
     pageHidden: true, granted: false }) === "denied" &&
   approvalNotifyDecision({ waiting: false,
     pageHidden: true, granted: true }) === "idle");

console.log("SUPERVISION (M2): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
