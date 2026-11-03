// Cycle 7 audit batch 4 (v3.02): A16-A20 re-run +
// flow rails part 2. Rails: the PLAN loop's pause
// wait sits inside runPlan's own body (not just the
// ACT loop's), and the agent's git surface stays
// read-only - agentToolText fetches branches/stash
// but never posts to the mutating branch/stash
// routes.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

const planBody = src.slice(src.indexOf("async function runPlan"),
  src.indexOf("async function openAgentReview"));
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
ck("RAIL plan pause lives in runPlan's own loop",
   planBody.includes("while (agentPause && !agentStop)") &&
   planBody.includes("Planning paused at step"));
ck("RAIL agent git surface is read-only",
   toolBody.includes('fetch("/api/git/branches")') &&
   toolBody.includes('fetch("/api/git/stash")') &&
   !toolBody.includes('"/api/git/branch"') &&
   !toolBody.includes('postJson("/api/git/stash"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
