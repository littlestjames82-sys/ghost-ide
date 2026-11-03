// Cycle 6 audit batch 2 (v2.92): A6-A10 re-run.
// A8 measured on the freshly built bundle with all
// twenty agentic features in it: innerHTML still
// 101 - the pill, notes viewer, explore and queue
// UI are all textContent/createElement.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const bundle = readFileSync(home + "/workspace/ghost-ide/web/app.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A6 timeouts intact (cli 120 / mcp 50 / term 30)",
   py.includes("timeout=120") && py.includes("timeout=50")
   && py.includes("def _term_run(cmd, timeout=30)"));
ck("A7 push modes + signer are script constants",
   readFileSync(home + "/workspace/ghostide-apk-build/push_repos.py", "utf8")
     .includes('"100644"') &&
   readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8")
     .includes("debug.keystore"));
ck("A8 sink census unchanged at 101 on the agentic bundle",
   (bundle.match(/innerHTML/g) || []).length === 101);
ck("A9 extraction stamp still e13",
   java.includes(".ready-e13"));
ck("A10 bundle freshness: agentic markers in the built bundle",
   bundle.includes("runExplore") &&
   bundle.includes("agentPillShow") &&
   bundle.includes("doneGate"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
