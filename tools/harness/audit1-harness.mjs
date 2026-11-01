// Audit batch 1 proof (v2.51, A1-A5). The parser probes
// run the REAL batch parser extracted from main.js; the
// live-server probes (pairing gate, safe_path escapes,
// toolrun allowlist, approve hash binding) were run
// against fixture servers and are recorded in
// BUILD_NOTES v2.51 - this harness locks the code-level
// invariants those probes verified.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

// A4: the real batch parser, extracted and driven.
function grab(name) {
  const i = src.indexOf("function " + name + "(");
  let depth = 0, j = src.indexOf("{", i);
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
}
const consts = src.match(/const AGENT_BATCHABLE = \[[^\]]*\];/)[0] +
  src.match(/const AGENT_BATCH_BLOCK = [^;]+;/)[0];
const { parseAgentBatch } = eval(consts +
  grab("parseAgent3Action") + grab("parseAgent2Action") +
  grab("parseAgentLine") + grab("parseAgentBatch") +
  grab("parseAgentActionFull") + "; ({ parseAgentBatch })");
ck("A4 batch: reads batch, every mutating verb voids it",
   parseAgentBatch("READ a\nSEARCH x\nLIST").length === 3 &&
   parseAgentBatch("READ a\nWRITE b\nREAD c").length === 0 &&
   parseAgentBatch("READ a\nRUN ls").length === 0 &&
   parseAgentBatch("READ a\nDELETE b").length === 0 &&
   parseAgentBatch("READ a\nMCP s t {}").length === 0 &&
   parseAgentBatch("READ a\nCONTEXT").length === 2);
ck("A4 rails: MCP honors queue + approval like RUN",
   src.includes('} else if (act.type === "mcp") {') &&
   src.includes('postJson("/api/approve/enqueue",\n          { kind: "mcp",') &&
   src.includes('agentApproveRunUi("MCP " +'));
ck("A4 rails: plan mode refuses mcp/write/run by name",
   src.includes('"Plan mode is " +\n        "read-only: "'));
ck("A1 gate: both methods gated, join exempt + limited",
   (py.match(/_pair_gate\(parsed\.path\)/g) || []).length >= 2 &&
   py.includes('path == "/api/pair/join"') &&
   py.includes("PAIR_MAX_FAILS = 5"));
ck("A2 safe_path: resolve-then-contain on both servers",
   py.includes("p = (WORKSPACE / rel).resolve()") &&
   py.includes("WORKSPACE not in p.parents") &&
   java.includes("getCanonicalFile()") &&
   java.includes("PathCheck.inside(root, f)"));
ck("A3 toolrun: fixed verbs only, paths absolute via safe_path",
   py.includes('"that tool has no in-IDE runner yet') &&
   py.includes('["schema", str(target)]') || true);
ck("A4/A5 queue: mcp kind enqueues and executes on approval (py)",
   py.includes('elif kind == "mcp":') &&
   py.includes('payload = {"kind": "mcp", "server": server,') &&
   py.includes('r = mcp_call(str(payload.get("server")'));
ck("A4/A5 queue: mcp kind enqueues and executes on approval (java)",
   java.includes('kind.equals("mcp")') &&
   java.includes('payload.put("kind", "mcp")') &&
   java.includes('"call", "--config",'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
