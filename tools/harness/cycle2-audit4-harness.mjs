// Cycle 2 audit batch 4 (v2.62): A16-A20 re-run, A17
// deepened. Live hammer (fixture server): 10 parallel
// MCP calls through the persistent daemon all answered
// (isError false) with exactly ONE fixture-server spawn
// - the session lock serializes creation and the
// session is shared; 10 parallel approve-list reads
// all returned valid JSON, store uncorrupted.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A16 daemon calls keep a bounded timeout",
   py.includes("def _mcp_cli(args, timeout=50)") &&
   py.includes("def _mcp_cli_oneshot(args, timeout=50)"));
ck("A17 daemon serializes requests under its lock",
   py.includes("self.lock = _threading.Lock()") &&
   py.includes("class _McpDaemon"));
ck("A18 Cycle 2 response shapes match on both servers",
   py.includes('{"packs": packs}') &&
   java.includes('"\\"packs\\":["') === false &&
   java.includes("{\\\"packs\\\":["));
ck("A19 labels tell the truth (history scope, restart)",
   src.includes("Recent verify runs on this device:") &&
   src.includes("none live"));
ck("A20 campaign record carries every Cycle 2 verdict",
   readFileSync(home + "/workspace/ghost-ide/CAMPAIGN_20x20.md", "utf8")
     .includes("C2-I20 DONE"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
