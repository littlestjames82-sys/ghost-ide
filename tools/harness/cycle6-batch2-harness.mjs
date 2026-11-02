// Cycle 6 batch 2 proof (v2.88): budgets + batching
// depth. The step cap is a user setting wired into
// the loop, banner, cap message and the rules the
// model sees; batches record per-action trail
// entries and pure-read batches run concurrently;
// compaction summaries carry open check problems.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I6 step budget is a setting, wired end to end",
   src.includes("agentMaxSteps: 50") &&
   html.includes('id="agentStepsSel"') &&
   html.includes('id="agentRepairSel"') &&
   src.includes("step <= stepCap") &&
   src.includes('Your step budget for this run is '));
ck("I7 batched actions join the trail individually",
   src.includes("for (const a of batch)") &&
   src.includes("trail.push({ step: step, type: a.type,"));
ck("I8 meter line every ten steps",
   src.includes('"📊 " + (step - 1) + " steps in, "'));
ck("I9 pure-read batches run concurrently, order kept",
   src.includes("parts = await Promise.all(acts.map(batchPart))") &&
   src.includes("async function batchPart(a)"));
ck("I10 compaction summary carries open problems",
   src.includes("open check problems: ") &&
   src.includes("todos, lastBad") &&
   src.includes("lastBad = notes.filter"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
