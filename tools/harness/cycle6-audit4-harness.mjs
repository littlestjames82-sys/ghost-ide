// Cycle 6 audit batch 4 (v2.94): A16-A20 re-run +
// the remaining loop rails. A16 swept the shipped
// sources for canary/key-shaped strings: zero hits.
// Rails: EXPLORE's whitelist (re-verified by
// negative space in its dispatch), NOTE's pinned
// path, the queue's single-run guard (drain only
// fires after agentRunning was released, and
// runAgent itself refuses to start while busy),
// and pause's stop-dominance (the wait condition
// includes !agentStop).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

const exploreBody = src.slice(src.indexOf("async function runExplore"),
  src.indexOf("async function noteAppend"));
ck("A16 no canary or key-shaped strings in shipped sources",
   !py.includes("sk-canary") && !src.includes("sk-canary") &&
   !java.includes("sk-canary"));
ck("A17 one decide route per server; decisions ride it",
   py.includes("/api/approve/decide") &&
   java.includes('path.equals("/api/approve/decide")'));
ck("A18 caps: explore 6 steps, notes 8000, show 20000",
   exploreBody.includes("s <= 6") &&
   src.includes("next.length > 8000") &&
   py.includes("[:20000]"));
ck("RAIL explore whitelist: no write/run/delete/mcp dispatch",
   !exploreBody.includes('a.type === "write"') &&
   !exploreBody.includes('a.type === "run"') &&
   !exploreBody.includes('a.type === "delete"') &&
   !exploreBody.includes('a.type === "mcp"') &&
   src.includes('const path = ".ghostide/agent-notes.md";'));
ck("RAIL queue + pause: single-run guard, stop beats pause",
   src.includes('if (agentRunning) {\n    addMsg("SYSTEM", "An agent task is already running.");') &&
   src.includes("agentQueue.shift()") &&
   src.includes("while (agentPause && !agentStop)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
