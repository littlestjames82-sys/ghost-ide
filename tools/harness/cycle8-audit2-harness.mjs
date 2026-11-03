// Cycle 8 audit batch 2 (v3.08): A6-A10 re-run +
// craft rail 2. A8 measured on the freshly built
// v3.07 bundle: innerHTML still exactly 101 - the
// tests renderer clears with textContent because
// this census caught its first draft at 102 during
// the improvement phase. The eco gate was re-run
// for real in this batch (all 29 packages green).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
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
ck("A8 sink census unchanged at 101 on the craft bundle",
   (bundle.match(/innerHTML/g) || []).length === 101);
ck("A9 extraction stamp still e13",
   java.includes(".ready-e13"));
ck("A10 bundle freshness: craft markers in the built bundle",
   bundle.includes("refreshDiagnostics") &&
   bundle.includes("foldGutter") &&
   bundle.includes("renderTags") &&
   bundle.includes("rerunFailedTests"));
const foldExt = src.slice(src.indexOf("function foldExt"),
  src.indexOf("const view = new EditorView"));
ck("RAIL fold + diag extensions are pure view state (no fetches)",
   !foldExt.includes("fetch(") && !foldExt.includes("postJson"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
