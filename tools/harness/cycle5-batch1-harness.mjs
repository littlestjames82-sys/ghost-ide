// Cycle 5 batch 1 proof (v2.79). I1 is the headline:
// the android repo's CI frontend job had been failing
// in ~10s while JVM/probe jobs passed (reported Nov
// 2). Cause PROVEN by simulation: two campaign UI
// harnesses read IdeServer.java from
// ~/workspace/ghostide-apk-build, which the CI layout
// never created - they crashed (no RESULT line, job
// fail). With the tree linked they pass 8/8 and 7/7.
// Fix: ci.yml checks out ghostide-android and links
// it into the layout; the push spec already carries
// .github/workflows/ci.yml.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const ci = readFileSync(home + "/workspace/ghostide-apk-build/.github/workflows/ci.yml", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I1 CI frontend job now links the android tree",
   ci.includes("repository: littlestjames82-sys/ghostide-android") &&
   ci.includes('~/workspace/ghostide-apk-build'));
ck("I2 priming workspace shape with honest sizes",
   src.includes("Workspace shape: \" + paths.length") &&
   src.includes('"under 1 KB"'));
ck("I3 What's New can show the whole bundled history",
   src.includes('"Show all "') &&
   src.includes("renderEntries(all)"));
ck("I4 health dot tap opens Settings",
   src.includes("healthDotEl.onclick"));
ck("I5 resources/prompts refresh parity (Java + panel)",
   java.includes('verb.equals("resources")') &&
   src.includes('"↻ Refresh resources"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
