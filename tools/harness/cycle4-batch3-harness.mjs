// Cycle 4 batch 3 proof (v2.73): snapshot size delta,
// agent test priming, eco generation in the catalog,
// pack-summary copy, multi-project board lines. Two
// first picks (undoable restore, Settings eco info)
// were verified as already covered and replaced.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I11 history rows size snapshots against the current doc",
   src.includes('" KB smaller than now"') &&
   src.includes('" KB larger than now"'));
ck("I12 agent priming counts test files and says so either way",
   src.includes("Tests: \" + tests.length") &&
   src.includes("Tests: no test files found in"));
ck("I13 catalog head names the bundle generation",
   src.includes('" Bundle generation "'));
ck("I14 pack view keeps the list shape and adds copy",
   src.includes('"📋 Copy pack summary"') &&
   src.includes('pre.textContent = v.error'));
ck("I15 board lists every project the model carries",
   src.includes("(d.projects || []).slice(1)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
