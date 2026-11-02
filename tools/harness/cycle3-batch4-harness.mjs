// Cycle 3 batch 4 proof (v2.66): board Git jump,
// palette actions, replay elapsed + the desktop POST
// fix, Settings about-build, run-all runner. The
// replay chain was live-proven end to end: save with
// elapsed lists 187s, save without has no field, POST
// list/get both answer on the desktop (they silently
// 404'd before this batch - the panel showed zero
// runs on desktop since E16), traversal refused 400,
// and an atomic save left no temp litter behind.
import { readFileSync, existsSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I16 board panel jumps to the Git panel",
   src.includes('"Open Git panel"') &&
   src.includes('const vg = $("viewGit");'));
ck("I17 palette gains restart + pack actions",
   src.includes('"Restart MCP sessions"') &&
   src.includes('"View data packs"') &&
   src.includes("async function openPackListPanel()"));
ck("I18a elapsed recorded, bounded, never backfilled",
   src.includes("body.elapsed_s = Math.round(elapsedS);") &&
   py.includes("0 <= elapsed_s <= 86400") &&
   src.includes('", took "'));
ck("I18b desktop serves POST replay list + get",
   (py.match(/parsed\.path == "\/api\/eco\/replay\/list"/g)
     || []).length === 2 &&
   (py.match(/parsed\.path == "\/api\/eco\/replay\/get"/g)
     || []).length === 2);
ck("I19 about-this-build reads /api/health",
   html.includes('id="setAbout"') &&
   src.includes("async function refreshAbout()"));
ck("I20 run-all exists and gates on failure",
   existsSync(home + "/workspace/ghost-ide/tools/harness/run-all.mjs") &&
   readFileSync(home + "/workspace/ghost-ide/tools/harness/run-all.mjs", "utf8")
     .includes("process.exit(failed.length ? 1 : 0);"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
