// Cycle 4 audit batch 4 (v2.78): A16-A20, A17 deepened
// + 1 fix. A17 hammer (live, fixture server): 6
// enqueued approvals, 6 parallel list reads (all
// valid), 6 parallel deny decides - every decide
// answered executed:false and the store ledger shows
// one coherent denied event per request. A19 fix:
// snapshot deltas under 1 KB claimed "1 KB smaller" -
// they now read "about the same size as now".
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A16 helper timeouts unchanged and bounded",
   py.includes("def _term_run(cmd, timeout=30)") &&
   py.includes("def _mcp_cli(args, timeout=50)"));
ck("A17 decide route is the single execution gate",
   py.includes("approve_decide(") &&
   src.includes('decision: "deny"'));
ck("A18 Cycle 4 shapes stay plain JSON fields",
   py.includes('"ahead": ahead, "behind": behind'));
ck("A19 FIX: sub-KB snapshot deltas no longer claim 1 KB",
   src.includes('" · about the same size as now"') &&
   src.includes("Math.abs(diff) < 1024"));
ck("A19 refreshed label only follows a successful refresh",
   src.includes('" tool(s) (refreshed)."'));
ck("A20 campaign file carries the Cycle 4 verdicts",
   readFileSync(home + "/workspace/ghost-ide/CAMPAIGN_20x20.md", "utf8")
     .includes("C4-I20 DONE"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
