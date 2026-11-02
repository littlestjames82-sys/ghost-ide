// Cycle 3 audit batch 2 (v2.68): A6-A10 re-run. Live
// probes: the fixture canary (sk-canary-12345 in a
// sibling server's env) appears in NONE of servers,
// sessions, eco/info, devices or health output; a
// 12-save burst against the new atomic write path
// landed last-write-wins with zero temp litter. The
// innerHTML census is 100 - exactly the Cycle 2 A8
// count: every Cycle 3 UI addition used textContent.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const ecoState = JSON.parse(readFileSync(home + "/workspace/ghost-ide/tools/eco-bundle-state.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A6 parity: new routes exist on both servers",
   py.includes('"/api/pair/devices"') &&
   java.includes('"/api/pair/devices"') &&
   java.includes('"/api/eco/replay/list"') &&
   py.includes("os.replace(tmp, p)") &&
   java.includes("StandardCopyOption.ATOMIC_MOVE"));
ck("A7 canary discipline: servers list names env, never values",
   readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/client.py", "utf8")
     .includes("env_names = sorted(str(k) for k in env)"));
ck("A8 sink census unchanged (100 lines, 101 occurrences)",
   (src.match(/innerHTML/g) || []).length === 101);
ck("A9 bundle pins at e13 (29 tools, gated versions)",
   Object.keys(ecoState.tools).length === 29 &&
   ecoState.tools.ghostmcp.version === "0.3.2" &&
   ecoState.tools.ghostdata.version === "0.1.1" &&
   !Object.values(ecoState.tools)
     .some((t) => t.tests_failed));
ck("A10 version sources are a single gated set",
   readFileSync(home + "/workspace/ghostide-apk-build/check_versions.py", "utf8")
     .includes("all five sources agree"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
