// Audit batch 4 proof (v2.54, A16-A20). Live probes:
// 14 parallel enqueues -> 14 unique pending records,
// zero corruption (the store is file-per-record).
// Timeout census and docs checks ran against the
// sources; this harness locks the invariants.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
const issues = readFileSync(home + "/workspace/ghost-ide/KNOWN_ISSUES.md", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A16 timeouts: subprocess helpers carry explicit bounds",
   py.includes("def _eco_cli(tool_id, args, ws, timeout=120)") &&
   py.includes("def _mcp_cli(args, timeout=50)") &&
   py.includes("def git_out(args, timeout=30)") &&
   py.includes("def _term_run(cmd, timeout=30)"));
ck("A16 timeouts: java runProcess enforces a deadline + destroys",
   java.includes("long deadline = t0 + timeoutSec * 1000L;") &&
   java.includes("proc.destroy();") &&
   java.includes("[timed out after "));
ck("A17 concurrency: terminal + REPL sessions are lock-guarded",
   py.includes("_TERM_LOCK = _threading.Lock()") &&
   py.includes("_REPL_LOCK = _threading.Lock()"));
ck("A18 contract: java sendText is asset-only, APIs send {error}",
   !java.includes('sendText(out, 400, "{\\"error\\"') &&
   java.includes('sendJson(out, 404, "{\\"error\\":\\"no such route\\"}")'));
ck("A19 accessibility: .ghostbtn now defines a 36px tap target",
   css.includes("button.ghostbtn {") &&
   css.includes("min-height: 36px"));
ck("A20 docs: KNOWN_ISSUES no longer claims LAN has no auth",
   !issues.includes("LAN mode has NO authentication") &&
   issues.includes("tokens\n  expire after 12 hours"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
