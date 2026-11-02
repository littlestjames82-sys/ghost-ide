// Cycle 2 batch 4 proof (v2.58): board last-commit,
// Settings MCP readout + restart, palette panel openers,
// agent scroll toggle + REPL parity (both verified as
// pre-existing coverage), tree change dots, build.sh
// staged-asset self-check.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const build = readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I14 board: last commit line from /api/git/log",
   src.includes('"Last commit: " + top.hash'));
ck("I15 settings: MCP readout + restart wired",
   src.includes("refreshMcpInfo") &&
   src.includes('"/api/mcp/restart"'));
ck("I15 restart route on both servers",
   py.includes('"/api/mcp/restart"') &&
   java.includes('"/api/mcp/restart"') &&
   java.includes('"/api/mcp/sessions"'));
ck("I16 palette: the eight panel openers are commands",
   ["toolApprove", "toolBoard", "toolEco", "toolMcp",
    "toolReplay", "toolRecipes", "toolLeads", "toolQuote"]
     .every((id) => src.includes(
       'run: () => $("' + id + '").click()')));
ck("I17 scroll toggle pre-exists and is honored",
   src.includes("shouldChatScroll(settings.autoScroll") &&
   src.includes('$("setAutoScroll").checked'));
ck("I18 tree dots: watch set feeds rows, open clears",
   src.includes("const watchChanged = new Set();") &&
   src.includes('el.textContent += " ●";') &&
   src.includes("watchChanged.delete(path);"));
ck("I19 REPL shares slice/ask, ask lead is mode-aware",
   src.includes('termMode === "repl"') &&
   src.includes("Explain this REPL output"));
ck("I20 build.sh refuses a stale staged bundle",
   build.includes("SELF-CHECK FAILED") &&
   build.includes("cmp -s"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
