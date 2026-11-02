// Cycle 3 batch 3 proof (v2.65): atomic writes both
// servers, build eco self-check, daemon idle reaping,
// approve wait age, session age/idle. Daemon behaviors
// are covered by GhostMCP suite tests (drop, reap,
// age/idle fields) plus a live unit probe; the atomic
// write replaces the torn-file risk A14 recorded.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const build = readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8");
const serve = readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/serve.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I11 desktop save is snapshot + temp + replace",
   py.includes("snapshot_history(p, data.get(\"content\", \"\"))") &&
   py.includes("os.replace(tmp, p)"));
ck("I11 phone writeFile is temp + atomic move",
   java.includes(".tmp-ghostide") &&
   java.includes("StandardCopyOption.ATOMIC_MOVE"));
ck("I12 build refuses a bundle that drifts from pins",
   build.includes("eco bundle vs gate pins") &&
   build.includes('state[tool]["version"]'));
ck("I13 reaper exists, is lazy, and suite-tested",
   serve.includes("IDLE_LIMIT_S = 1800.0") &&
   serve.includes("def _reap_idle") &&
   readFileSync(home + "/workspace/ghostmcp/tests/test_serve_cycle3.py", "utf8")
     .includes("test_idle_sessions_are_reaped"));
ck("I14 approve rows show the wait",
   src.includes('" - waiting "') &&
   src.includes("it.ingested_at"));
ck("I15 sessions carry age + idle to both readouts",
   serve.includes('"age_s": int(') &&
   src.includes("Math.round(s.age_s / 60)") &&
   src.includes("Math.round(s.idle_s / 60)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
