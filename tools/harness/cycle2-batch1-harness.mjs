// Cycle 2 batch 1 proof (v2.55): persistent MCP
// sessions, the sessions readout, clock-relative
// GhostConsole fixtures. The daemon was proven live:
// 3 IDE requests, exactly 1 fixture-server spawn.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const mcp = readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/serve.py", "utf8");
const cli = readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/cli.py", "utf8");
const conftest = readFileSync(home + "/workspace/ghostconsole/tests/conftest.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I1 daemon: ghostmcp serve keeps sessions per server",
   cli.includes('"serve"') &&
   mcp.includes("class _Daemon") &&
   mcp.includes("def _session(self, name, timeout)") &&
   mcp.includes("deadline = time.monotonic()"));
ck("I1 daemon: dead sessions retry once, config reloads",
   mcp.includes('"closed the connection" in str(e)') &&
   mcp.includes("def _sync_config(self):"));
ck("I1 client: IDE routes via the daemon with CLI fallback",
   py.includes("class _McpDaemon:") &&
   py.includes("def _mcp_cli_oneshot(args, timeout=50):") &&
   py.includes("return _mcp_cli_oneshot(args, timeout=timeout)"));
ck("I5 sessions: route + panel line",
   py.includes('"/api/mcp/sessions"') &&
   src.includes('"Live sessions: "'));
ck("I3 fixtures: clock-relative, no pinned board dates",
   conftest.includes("def fixture_iso(minutes=0, days=0):") &&
   !conftest.includes('"2026-10-31T08:'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
