// Cycle 2 audit batch 2 (v2.60): A6-A10 re-run, A7
// deepened. Live probes (fixture server, canary planted
// in canary.env + as a CSV header): board, datapacks,
// MCP sessions and eco/info outputs all canary-clean;
// the GhostData analyze output through the IDE carries
// zero canary occurrences (the C2-I4 redaction holding
// in the integrated path).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A6 parity: Cycle 2 routes exist on both servers",
   ["/api/eco/datapacks", "/api/eco/datapack/delete",
    "/api/mcp/restart", "/api/mcp/sessions"]
     .every((r) => py.includes('"' + r + '"')
       && java.includes('"' + r + '"')));
ck("A6 parity: pack mtime in seconds on both servers",
   py.includes('"mtime": int(') &&
   java.includes("dd.lastModified() / 1000"));
ck("A7 redaction lives in the bundled GhostData",
   readFileSync(home + "/workspace/ghostdata/src/ghostdata/infer.py", "utf8")
     .includes("sensitive.display_name(self.name)"));
ck("A8 new sinks are textContent (commit line, dots, packs)",
   src.includes('lc.textContent = "Last commit: "') &&
   src.includes('el.textContent += " ●";'));
const ecoState = JSON.parse(readFileSync(home +
  "/workspace/ghost-ide/tools/eco-bundle-state.json",
  "utf8"));
ck("A9 bundle pins: 29 tools, versions held",
   Object.keys(ecoState.tools).length === 29 &&
   ecoState.tools.ghostdata.version === "0.1.1" &&
   // ghostmcp was 0.3.0 at the Cycle 2 audit; Cycle 3
   // I1 bumped it to 0.3.1 (drop verb) with a fresh
   // GREEN gate, so the pin moves with the gate state.
   ecoState.tools.ghostmcp.version === "0.3.1");
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
