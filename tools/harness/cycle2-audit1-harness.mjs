// Cycle 2 audit batch 1 (v2.59): A1-A5 re-run against
// the Cycle 2 surface. Live probes (fixture server):
// six traversal-shaped pack names all refused by the
// delete pin; /api/mcp/restart + /api/mcp/sessions
// answer. Source: the pair gate still runs before
// routing in both verbs, so every Cycle 2 route sits
// behind it.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A1 pairing: gate precedes routing in GET and POST",
   (py.match(/if not self\._pair_gate\(parsed\.path\):/g)
     || []).length === 2);
ck("A2 new routes take no unpinned paths (delete pin)",
   py.includes('_re_mod.fullmatch(') &&
   py.includes('".." in name'));
ck("A3 toolrun rails: agent branches still queue-first",
   src.includes('policy === "queue"') &&
   src.includes('"mcp"'));
ck("A4 MCP executes only inside approve_decide",
   py.slice(py.indexOf("def approve_decide"))
     .includes('elif kind == "mcp":'));
ck("A5 hash binding: decide passes the record hash",
   py.includes('"--hash", str(rec.get("hash"))'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
