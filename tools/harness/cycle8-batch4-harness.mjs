// Cycle 8 batch 4 proof (v3.06): tests craft.
// Server: the single-test narrowing exists in the
// route, the Python runner, and the JS argv - and
// the TAP skip guard keeps a pattern run from
// counting skipped tests as passes. Frontend: one
// renderer for all scopes, per-test rows, the
// failed re-run, and a persisted last-run summary.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I16 route takes an optional name and requires its file",
   py.includes('only = data.get("name") or None') &&
   py.includes('"a single-test run needs its file"') &&
   py.includes("results.extend(run_test_file(rel, only))"));
ck("I16 Python runner filters, JS uses an escaped name pattern",
   py.includes("if only and name != only:") &&
   py.includes('"--test-name-pattern"') &&
   py.includes("_re_mod.escape(only)"));
ck("I16 skipped tests never count as passes",
   py.includes('if name.endswith("# SKIP"):'));
ck("I17 discover rows run single tests",
   src.includes("tr.onclick = () => runTests(f.path, t.name);"));
ck("I18 re-run failed only, through the single-test route",
   src.includes("async function rerunFailedTests()") &&
   src.includes('{ path: f.file, name: f.name }'));
ck("I19 last run persists and drives the chip",
   src.includes('localStorage.setItem("ghostide.lastTests"') &&
   src.includes("function noteTestRun(d)") &&
   src.includes("function lastTestLine()"));
ck("I20 one renderer for every scope",
   src.includes("function renderTestResults(d, scope)") &&
   src.includes('renderTestResults(merged, "failed re-run")'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
