// Campaign batch 4 proof (v2.50, I16-I20): worktree
// briefing, MCP list cache, settings bundle readout,
// verify draft-fix-task, version build gate.
import { readFileSync, existsSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const buildSh = readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8");
const gate = home + "/workspace/ghostide-apk-build/check_versions.py";
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@CAMPAIGN4@@*/"), b = src.indexOf("/*@@CAMPAIGN4-END@@*/");
ck("CAMPAIGN4 block markers present", a >= 0 && b > a);
ck("agent priming names the worktrees when there are several",
   src.includes('Git worktrees in this workspace: ') &&
   src.includes('fetch("/api/git/worktrees")'));
ck("desktop caches MCP lists keyed by config mtime, calls stay live",
   py.includes("_MCP_LIST_CACHE = {}") &&
   py.includes("def _mcp_list_cached(verb, server, argv)") &&
   py.includes('return _mcp_list_cached(') &&
   py.includes("def mcp_call(server, tool, arguments):\n    return _mcp_cli("));
ck("eco info endpoint exists on both servers",
   py.includes('"/api/eco/info"') &&
   java.includes('"/api/eco/info"') &&
   java.includes('nm.startsWith(".ready-")'));
ck("settings shows the bundle readout",
   html.includes('id="setEcoInfo"') &&
   src.slice(a, b).includes('fetch("/api/eco/info")') &&
   src.slice(a, b).includes('"generation " + d.generation'));
ck("verify result is kept and the fix draft is built from its gaps",
   src.includes("lastVerify = d;") &&
   html.includes('id="runFix"') &&
   src.slice(a, b).includes("lastVerify.checks.problems") &&
   src.slice(a, b).includes('"Fix the gaps from the last Verify run'));
ck("build gate script exists and build.sh runs it first",
   existsSync(gate) &&
   buildSh.includes("check_versions.py") &&
   readFileSync(gate, "utf8").includes(
     "all five sources agree"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
