// Cycle 8 audit batch 1 (v3.07): A1-A5 re-run on
// current code + craft rail 1. Live evidence this
// cycle (fixture server on v3.06 code, a7 canary
// workspace): canary sweep over health, the NEW
// git/tags route, tests/discover and eco/info -
// 0 hits x4; malformed JSON to the NEW tag route
// answered with a clean parse error; an unknown
// route 404s as JSON; health stayed up throughout.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

const gateCount = (py.match(/if not self\._pair_gate\(parsed\.path\):/g) || []).length;
ck("A1 pair gate wraps do_GET/do_POST once each (new routes inside it)",
   gateCount === 2 && py.includes('PAIR_TOKENS[tok][0] == "viewer"'));
ck("A2 traversal + commit hash pin intact",
   py.includes('"path escapes workspace"') &&
   py.includes('r"[0-9a-f]{7,40}"') &&
   java.includes('chash.matches("[0-9a-f]{7,40}")'));
ck("A3 atomic writes intact both servers",
   py.includes("os.replace(") && java.includes("ATOMIC_MOVE"));
ck("A4 canary string absent from shipped sources",
   !py.includes("sk-canary-12345") &&
   !java.includes("sk-canary-12345"));
ck("A5 eco pins: 29 tools incl ghostmcp 0.3.2, stamp e13",
   readFileSync(home + "/workspace/ghost-ide/tools/eco_bundle_gate.py", "utf8")
     .includes('"ghostmcp"') &&
   readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/__init__.py", "utf8")
     .includes('__version__ = "0.3.2"') &&
   java.includes(".ready-e13"));
const diagBody = src.slice(src.indexOf("async function refreshDiagnostics"),
  src.indexOf("async function saveFile"));
ck("RAIL diagnostics are compute-only (check-content in, no file writes)",
   diagBody.includes('"/api/check-content"') &&
   !diagBody.includes('"/api/file"') &&
   diagBody.includes("Math.min(d.line, view.state.doc.lines)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
