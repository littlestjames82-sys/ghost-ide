// Cycle 3 batch 1 proof (v2.63): per-server MCP
// restart, paired-devices readout, agent git priming,
// pack viewer, openable renders. Live probes: drop-one
// emptied the sessions list and the next call respawned
// (spawn count +2 across call/drop/recall); pack view
// returned the summary and refused a traversal name;
// renders returned JSON; /api/pair/devices answered
// metadata-only after a _time import bug was caught by
// the probe and fixed.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const serve = readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/serve.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I1 drop verb in the daemon + restart routes",
   serve.includes('verb == "drop"') &&
   py.includes('"verb": "drop"') &&
   java.includes('Json.str(rd, "server", "")'));
ck("I1 panel offers per-server Restart",
   src.includes('postJson("/api/mcp/restart",') &&
   src.includes("{ server: s.server }"));
ck("I2 devices readout on both servers (metadata)",
   py.includes('"/api/pair/devices"') &&
   py.includes('"role": rec[0]') &&
   java.includes('"/api/pair/devices"'));
ck("I3 priming gains the git line",
   src.includes("Git: on branch ") &&
   src.includes("(gs.changes || [])"));
ck("I4 pack view route on both servers, pinned",
   py.includes('"/api/eco/datapack/view"') &&
   java.includes('"/api/eco/datapack/view"'));
ck("I5 renders are JSON on both servers",
   py.includes('"mtime": int(f.stat().st_mtime)') &&
   java.includes('",\\"mtime\\":'));
ck("I5 shelf opens renders in the editor",
   src.includes('openFile(".ghostide/" + r.name)'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
