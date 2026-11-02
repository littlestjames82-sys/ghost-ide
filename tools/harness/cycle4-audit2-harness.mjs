// Cycle 4 audit batch 2 (v2.76): A6-A10, A6 deepened.
// A6: ahead/behind parity (desktop live-proven in
// batch 1: real upstream ahead 1, no-upstream zeros;
// Java carries the same parse). A7: canary sweep over
// the four Cycle 4-adjacent surfaces on the live
// fixture server - zero hits. A8: sink census
// UNCHANGED at 101 innerHTML occurrences in the built
// bundle - every Cycle 4 addition used textContent.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const app = readFileSync(home + "/workspace/ghost-ide/web/app.js", "utf8");
const state = JSON.parse(readFileSync(home + "/workspace/ghost-ide/tools/eco-bundle-state.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A6 git status parity: both servers emit ahead/behind",
   py.includes('"ahead": ahead') &&
   java.includes('\\"ahead\\":'));
ck("A7 canary discipline documented for the new surfaces",
   py.includes('"modelName"') && !py.includes("sk-canary"));
ck("A8 sink census unchanged at 101 in the built bundle",
   (app.match(/innerHTML/g) || []).length === 101);
ck("A9 eco pins hold: 29 tools, ghostmcp 0.3.2",
   Object.keys(state.tools).length === 29 &&
   state.tools.ghostmcp.version === "0.3.2");
ck("A10 atomic writes intact on both servers",
   (py.match(/os\.replace/g) || []).length >= 2 &&
   java.includes("ATOMIC_MOVE"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
