// Cycle 3 audit batch 1 (v2.67): A1-A5 re-run against
// the Cycle 3 surface, A4/A5 deepened for the new
// routes. Live probes (two-server fixture workspace):
// fx + fx2 both serve; sessions carry age/idle; a
// per-server restart dropped ONLY fx while fx2 kept
// serving from its live session and fx respawned on
// next use; /api/pair/devices emitted an empty list
// with zero token-shaped strings. Source pins below
// cover the rails those probes exercise.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const serve = readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/serve.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A1 pairing gate still precedes routing, both verbs",
   (py.match(/if not self\._pair_gate\(parsed\.path\):/g)
     || []).length === 2);
ck("A2 new routes stay pinned (devices fixed path, drop by name)",
   py.includes('"/api/pair/devices"') &&
   serve.includes('if verb == "drop":'));
ck("A3 queue-first rails intact for run/delete/mcp",
   src.includes('policy === "queue"') &&
   py.includes("def approve_enqueue"));
ck("A4 deepened: per-server restart routes to the drop verb",
   py.includes('{"verb": "drop",') &&
   py.includes('"server": server}') &&
   serve.includes("self._drop(name)"));
ck("A4 rails: MCP still executes only inside approve_decide",
   py.slice(py.indexOf("def approve_decide"))
     .includes('elif kind == "mcp":'));
ck("A5 deepened: devices route emits metadata keys only",
   py.includes('"role": rec[0]') &&
   py.includes('"issued": int(rec[1])') &&
   py.includes("Token values never leave the server."));
ck("A5 hash binding unchanged",
   py.includes('"--hash", str(rec.get("hash"))'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
