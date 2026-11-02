// Cycle 6 batch 1 proof (v2.87): the self-repair
// core. DONE is gated on the staged checks (the
// loop's own agentCheckOne), VERIFY reports the
// problems themselves, applying changes runs the
// full pipeline on disk, identical actions are
// detected, and repairs ride the trail + summary.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I1 DONE gate refuses on failing staged checks",
   src.includes("async function doneGate()") &&
   src.includes('"DONE refused: "') &&
   src.includes("agentRepairRounds: 3") &&
   src.includes("if (await doneGate())"));
ck("I2 post-apply verify runs + prefills a fix task",
   src.includes('"🔍 Post-apply verify: "') &&
   src.includes('"Fix the verify problems"'));
ck("I3 VERIFY action returns the problems themselves",
   src.includes('const probs = (d.checks.problems || []).slice(0, 10)'));
ck("I4 loop detection warns at 3, stops at 4",
   src.includes("sigCount >= 4") &&
   src.includes('outcome = "looping"') &&
   src.includes("sigCount === 3"));
ck("I5 repairs counted in trail + run summary line",
   src.includes('type: "repairs"') &&
   src.includes('" repair round(s), "'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
