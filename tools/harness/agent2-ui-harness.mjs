// Beat Cline C1-C3 (v2.34.0): Agent v2 protocol, Plan/Act,
// checkpoints. Pure steps between @@AGENT2@@ markers + wiring.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@AGENT2@@*/")[1].split("/*@@AGENT2-END@@*/")[0];
const { parseAgent2Action, applyEditPatch, normalizeAgentTodos,
  addAgentTodo, completeAgentTodo, makeAgentCheckpoint,
  agentStateSummary, compactAgentMessages, buildDiskCheckpoint,
  checkpointFileName, splitEditMarkers } =
  new Function("window", block +
    "; return { parseAgent2Action, applyEditPatch, normalizeAgentTodos," +
    " addAgentTodo, completeAgentTodo, makeAgentCheckpoint," +
    " agentStateSummary, compactAgentMessages, buildDiskCheckpoint," +
    " checkpointFileName, splitEditMarkers };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

let a = parseAgent2Action("EDIT a.py\n```\nold line\n```\n```\nnew line\n```");
ck("EDIT two-block parses", a.type === "edit" && a.path === "a.py" &&
   a.oldText === "old line\n" && a.newText === "new line\n");
a = parseAgent2Action("EDIT a.py\n```\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```");
ck("EDIT marker form parses", a.type === "edit" && a.oldText === "old\n" && a.newText === "new\n");
ck("splitEditMarkers rejects plain text", splitEditMarkers("hello") === null);
a = parseAgent2Action("SEARCH needle\n");
ck("SEARCH parses", a.type === "search" && a.query === "needle");
a = parseAgent2Action("LIST src");
ck("LIST parses with and without path", a.type === "list" && a.path === "src" &&
   parseAgent2Action("LIST").type === "list");
a = parseAgent2Action("RUN python3 -m pytest -q");
ck("RUN parses the full command", a.type === "run" && a.command === "python3 -m pytest -q");
a = parseAgent2Action("DELETE old.py");
ck("DELETE parses", a.type === "delete" && a.path === "old.py");
a = parseAgent2Action("TODO write the tests");
ck("TODO parses", a.type === "todo" && a.text === "write the tests");
a = parseAgent2Action("STEP_DONE 2");
ck("STEP_DONE parses", a.type === "stepdone" && a.text === "2");
a = parseAgent2Action("DONE all fixed\n```md\n# Plan\n- x\n```");
ck("DONE carries a fenced plan", a.type === "done" && a.summary === "all fixed" && a.plan.includes("# Plan"));
a = parseAgent2Action("WRITE b.py\n```py\nx = 1\n```");
ck("v1 WRITE still parses via fallback", a.type === "write" && a.content === "x = 1\n");
a = parseAgent2Action("READ b.py");
ck("v1 READ still parses via fallback", a.type === "read" && a.path === "b.py");

let r = applyEditPatch("a\nold line\nb\n", "old line\n", "new line\n");
ck("patch applies an exact single match", r.ok && r.content === "a\nnew line\nb\n");
r = applyEditPatch("x\nx\n", "x\n", "y\n");
ck("patch refuses an ambiguous match", !r.ok && /more than once/.test(r.error));
r = applyEditPatch("abc", "zzz", "y");
ck("patch refuses a missing match", !r.ok && /not found/.test(r.error));
r = applyEditPatch(null, "a", "b");
ck("patch refuses a nonexistent file", !r.ok && /WRITE/.test(r.error));

let t = addAgentTodo([], "one"); t = addAgentTodo(t, "two"); t = addAgentTodo(t, "one");
ck("todos add and dedupe", t.length === 2 && t[0].done === false);
t = completeAgentTodo(t, "2");
ck("todos complete by number", t[1].done === true && t[0].done === false);
t = completeAgentTodo(t, "one");
ck("todos complete by text", t[0].done === true);
ck("todos normalize garbage", normalizeAgentTodos("junk").length === 0 &&
   normalizeAgentTodos([{ text: "  x  " }])[0].text === "x");

const cp = makeAgentCheckpoint(3, "WRITE a.py", 5, { "a.py": "v2" }, ["old.py"], t);
ck("checkpoint snapshots state", cp.n === 3 && cp.staged["a.py"] === "v2" &&
   cp.deletions[0] === "old.py" && cp.todos.length === 2);
const summary = agentStateSummary({ "a.py": "1" }, [], [{ text: "rest", done: false }]);
ck("state summary names staged files and open items",
   summary.includes("a.py") && summary.includes("rest"));
const msgs = [{ role: "system", content: "s" }];
for (let i = 0; i < 20; i++) msgs.push({ role: "user", content: "x".repeat(4000) });
const compacted = compactAgentMessages(msgs, "SUMMARY", 20000);
ck("compaction shrinks and keeps the summary",
   compacted.length < msgs.length &&
   JSON.stringify(compacted).includes("SUMMARY"));
ck("small conversations are not compacted",
   compactAgentMessages(msgs.slice(0, 3), "S", 20000).length === 3);
const dc = buildDiskCheckpoint("task x", { "a.py": null }, { "b.py": "old" });
ck("disk checkpoint shape", dc.kind === "ghostide-checkpoint" &&
   dc.files["a.py"] === null && dc.deleted["b.py"] === "old");
ck("checkpoint file name is under .ghostide/checkpoints",
   checkpointFileName(new Date(2026, 9, 22, 13, 5, 9)) ===
   ".ghostide/checkpoints/ckpt-20261022-130509.json");

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("plan toggle + checkpoint controls exist in HTML",
   ["planToggle", "ckptBtn", "agentResumeBtn"].every((i) => htmlIds.has(i)));
ck("sendChat routes Plan before Act",
   src.includes('if ($("planToggle") && $("planToggle").checked)') &&
   src.indexOf("runPlan(text)") > src.indexOf("planToggle"));
ck("agent step cap is 50", src.includes("const AGENT_MAX_STEPS = 50;"));
ck("RUN goes through the terminal endpoint with an approval UI",
   src.includes('postJson("/api/terminal"') && src.includes("agentApproveRunUi"));
ck("auto-check after WRITE and EDIT",
   (src.match(/agentCheckOne\(act\.path/g) || []).length >= 2);
ck("review saves a disk checkpoint before applying",
   src.includes("buildDiskCheckpoint(review.task") &&
   src.indexOf("buildDiskCheckpoint(review.task") < src.indexOf("Agent changes applied:"));
ck("checkpoints panel + restore are wired",
   src.includes('$("ckptBtn").onclick') && src.includes("restoreDiskCheckpoint"));
ck("resume is wired to the persisted active task",
   src.includes('$("agentResumeBtn").onclick') && src.includes("agentActiveLoad()"));
ck("plan mode rejects mutating actions",
   src.includes("Plan mode is ") && src.includes("read-only"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
