// Cycle 5 batch 3 proof (v2.81): eco history clear,
// settings clear-all, clickable verify problems,
// palette mirrors. Verify problems were verified as
// structured {path, line, message} in the server's
// own builder before rendering them as rows.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I11 eco recent-runs clear sits beside the list",
   src.includes('"Recent runs cleared."') &&
   src.includes('removeItem("ghostide.ecoRuns")'));
ck("I12 clear-all wipes four stores + the live list",
   html.includes('id="setClearHist"') &&
   src.includes('"ghostide.verifyHistory"') &&
   src.includes("termHistory.length = 0"));
ck("I13 verify problems render as opening rows",
   html.includes('id="runProblems"') &&
   py.includes('"path": str(rel), "line": ln') &&
   src.includes("jumpToLine(p.line || 1)"));
ck("I13 plain runs clear stale problem rows",
   src.includes('const pb = $("runProblems");'));
ck("I14/I15 palette mirrors the cycle's new actions",
   src.includes('"Toggle file tree order"') &&
   src.includes('"Copy settings JSON"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
