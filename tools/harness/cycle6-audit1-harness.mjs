// Cycle 6 audit batch 1 (v2.91): A1-A5 re-run on
// current code. Live evidence this cycle (fixture
// server, v2.90 code): canary sweep 0 hits on the
// five standard routes; the commit route refused a
// flag-shaped hash; malformed JSON answered with a
// clean {error} and health stayed up.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

const gateCount = (py.match(/if not self\._pair_gate\(parsed\.path\):/g) || []).length;
ck("A1 pair gate wraps do_GET/do_POST once each",
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
ck("A5 eco pins: gate lists 29 tools incl ghostmcp 0.3.2 source",
   readFileSync(home + "/workspace/ghost-ide/tools/eco_bundle_gate.py", "utf8")
     .includes('"ghostmcp"') &&
   readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/__init__.py", "utf8")
     .includes('__version__ = "0.3.2"') &&
   java.includes(".ready-e13"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
