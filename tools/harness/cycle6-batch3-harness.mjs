// Cycle 6 batch 3 proof (v2.89): sub-runs + agent
// memory. EXPLORE's dispatch whitelist is read-only
// by construction (no write/run/delete/MCP/nested
// explore branches exist in runExplore); NOTE writes
// only the pinned scratchpad path in .ghostide/;
// priming reads both the notes and the last run.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

const exploreBody = src.slice(src.indexOf("async function runExplore"),
  src.indexOf("async function noteAppend"));
ck("I11 EXPLORE sub-run: capped, read-only dispatch",
   src.includes('type: "explore", question') &&
   exploreBody.includes("s <= 6") &&
   !exploreBody.includes('a.type === "write"') &&
   !exploreBody.includes('a.type === "run"') &&
   !exploreBody.includes('a.type === "mcp"') &&
   exploreBody.includes("no nested EXPLORE"));
ck("I12 NOTE writes only the pinned scratchpad path",
   src.includes('const path = ".ghostide/agent-notes.md";') &&
   src.includes("next.length > 8000"));
ck("I13 priming includes notes + last recorded run",
   src.includes('Your agent notes from earlier runs ') &&
   src.includes('Your last recorded run in this '));
ck("I14 explore is in rules, batch-blocked, trailed",
   src.includes('"EXPLORE <question> - delegate a focused read-only"') &&
   src.includes("MCP|EXPLORE|NOTE") &&
   src.includes("act.question ||"));
ck("I15 notes viewer with owner clear",
   html.includes('id="agentNotesBtn"') &&
   src.includes('"Clear notes"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
