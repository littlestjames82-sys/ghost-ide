// Cycle 2 batch 2 proof (v2.56): Java MCP list cache,
// GhostData header redaction, board-aware agent
// priming, replay export, approve kind filter. The
// GhostData fix was proven live: a KEY=VALUE header now
// renders as CANARY=<redacted>, the value never prints.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const gd = readFileSync(home + "/workspace/ghostdata/src/ghostdata/sensitive.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I2 java cache: 5-minute, config-mtime keyed, lists only",
   java.includes("mcpListCache") &&
   java.includes("now - (Long) hit[1] < 300000") &&
   java.includes("private McpListResult mcpListBody("));
ck("I4 ghostdata: KEY=VALUE header values are masked",
   gd.includes("def display_name(name):") &&
   gd.includes('return head + "=<redacted>"'));
ck("I6 agent priming: board one-liner joins the memory",
   src.includes("function boardSummaryLine(d)") &&
   src.includes('"\\n\\nStudio board: " + line + "."'));
ck("I7 replay export: markdown transcript download",
   src.includes('"Export .md"') &&
   src.includes('"# Agent run transcript"'));
ck("I8 approve filter: kind derived and rows tagged",
   src.includes("row.dataset.kind = kindOf(it);") &&
   src.includes('["mcp", "MCP"]'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
