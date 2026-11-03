// Cycle 8 audit batch 4 (v3.10): A16-A20 re-run +
// craft rails part 2, closing the cycle. Rails:
// the agent's git surface gained tags the same way
// it gained branches and stash - a GET in
// agentToolText and nothing else; the mutating
// routes keep exactly one caller each (audit3's
// pin, restated at cycle close); and the two new
// status-bar chips (diagnostics, tests) are
// independent state - neither's handler touches
// the other's element.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

const toolBody = src.slice(src.indexOf("async function agentToolText"),
  src.indexOf("async function runAgent"));
ck("A16 no canary or key-shaped strings in shipped sources",
   !py.includes("sk-canary") && !src.includes("sk-canary") &&
   !java.includes("sk-canary"));
ck("A17 one decide route per server; decisions ride it",
   py.includes("/api/approve/decide") &&
   java.includes('path.equals("/api/approve/decide")'));
ck("A18 caps: search pattern 200 both, notes 8000, show 20000",
   py.includes('"search pattern too long (200 max)"') &&
   java.includes('"search pattern too long (200 max)"') &&
   src.includes("next.length > 8000") &&
   py.includes("[:20000]"));
ck("A19 pair tokens expire (12h) on the desktop server",
   py.includes("PAIR_TOKEN_TTL") || py.includes("12 * 3600") ||
   py.includes("43200"));
ck("A20 replay records keep their shape (task/trail/saved_at)",
   py.includes('"saved_at"') && py.includes('"trail"'));
ck("RAIL agent git surface includes tags, read-only",
   toolBody.includes('fetch("/api/git/tags")') &&
   !toolBody.includes('"/api/git/tag"') &&
   !toolBody.includes('"/api/git/amend"'));
ck("RAIL mutating tag/amend routes keep exactly one caller each",
   (src.split('postJson("/api/git/tag"').length - 1) === 1 &&
   (src.split('"/api/git/amend"').length - 1) === 1);
const diagBody = src.slice(src.indexOf("async function refreshDiagnostics"),
  src.indexOf("async function saveFile"));
const noteBody = src.slice(src.indexOf("function noteTestRun"),
  src.indexOf("function lastTestLine"));
ck("RAIL the diag chip and test chip are independent state",
   !diagBody.includes("testChip") &&
   !noteBody.includes("diagChip"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
