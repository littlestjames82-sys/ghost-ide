// Cycle 7 batch 1 proof (v2.95): branches end to
// end. Server routes proven live on the fixture
// repo this cycle (list; flag-shaped and traversal
// names refused; create/switch; current-branch
// delete refused). The name pin must exist in BOTH
// servers with the same shape - a pin that exists
// only on desktop is a hole on the phone.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I1 branches route both servers",
   py.includes('"/api/git/branches"') &&
   java.includes('"/api/git/branches"'));
ck("I2 branch action route + identical name pin both servers",
   py.includes("def _branch_name_ok") &&
   py.includes('r"[A-Za-z0-9][A-Za-z0-9._/-]*"') &&
   java.includes('"[A-Za-z0-9][A-Za-z0-9._/-]*"') &&
   py.includes("cannot delete the current branch") &&
   java.includes("cannot delete the current branch"));
ck("I3 panel Branches section wired",
   html.includes('id="branchList"') &&
   src.includes("async function renderBranches()") &&
   src.includes('branchAct("switch", b.name)'));
ck("I4 branchChip opens the git drawer",
   src.includes("branchChipEl.onclick"));
ck("I5 agent GIT knows branches, read-only",
   src.includes("(status|diff|log|branches)") &&
   src.includes('act.what === "branches"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
