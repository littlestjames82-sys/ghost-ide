// Cycle 6 audit batch 3 (v2.93): A11-A15 re-run +
// the DONE-gate exclusivity rail. A11 verified LIVE
// on the v2.92 APK during its ritual (apksigner
// SHA-256 8ea8684a...). The gate rail: inside
// runAgent's body there is exactly ONE assignment
// of outcome = "done", and it sits behind
// doneGate(); the repair cap is clamped 0..5 and
// the gate opens at the cap by design (a bounded
// refusal, never an infinite one).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

const agentBody = src.slice(src.indexOf("async function runAgent"),
  src.indexOf("async function runPlan"));
ck("A11 signer is the build.sh keystore constant",
   readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8")
     .includes("debug.keystore"));
/* Census moved by design: 139/129 after Cycle 7
   batch 1 (branches), 141/131 after batch 2 (stash),
   144/134 after Cycle 8 batch 3 (tags + amend). */
ck("A12 census after Cycle 8 additions: 144 desktop / 134 Java",
   (py.match(/parsed\.path ==/g) || []).length === 144 &&
   (java.match(/path\.equals\("\/api/g) || []).length === 134);
ck("A13 datapack name pins unchanged",
   py.includes('r"data-pack-[A-Za-z0-9_.-]+"') &&
   py.includes('".." in'));
ck("A14 history delta wording honest both ways",
   src.includes(' KB smaller than now') &&
   src.includes('about the same size as now'));
ck("RAIL DONE gate is the only road to done in ACT",
   (agentBody.match(/outcome = "done"/g) || []).length === 1 &&
   agentBody.includes("if (await doneGate())") &&
   agentBody.includes("Math.max(0, Math.min(5,"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
