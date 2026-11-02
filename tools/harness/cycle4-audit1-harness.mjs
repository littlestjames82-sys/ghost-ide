// Cycle 4 audit batch 1 (v2.75): A1-A5 re-run against
// the Cycle 4 surface. Cycle 4 added NO new routes:
// I1 extended an existing response, I18 an existing
// request body, the rest is frontend. The rails are
// re-pinned as they stand.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A1 pair gate still wraps both verbs exactly once each",
   (py.match(/if not self\._pair_gate\(parsed\.path\):/g)
     || []).length === 2);
ck("A2 viewer role check intact inside the gate",
   py.includes('PAIR_TOKENS[tok][0] == "viewer"'));
ck("A3 deny-all rides the same per-id decide route",
   src.includes('"/api/approve/decide"') &&
   src.includes('decision: "deny"'));
ck("A4 agent MCP execution path untouched by refresh",
   !src.includes("mcp/call\", { refresh") &&
   py.includes("approve_enqueue("));
ck("A5 refresh only widens a list read, never a call",
   py.includes('"/api/mcp/tools"') &&
   src.includes('"/api/mcp/tools",\n              { server: s.name, refresh: true }') ||
   src.includes("refresh: true"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
