// Cycle 8 batch 1 proof (v3.03): editor diagnostics.
// The bundle gate matters most here: @codemirror/
// lint is a NEW import - if it broke the bundle the
// runbundle check in the ritual would catch it, and
// this harness pins that the wiring exists in the
// source the bundle is built from.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I1 lint gutter imported + compartment-wired",
   src.includes('from "@codemirror/lint"') &&
   src.includes("diagComp.of(diagExt())") &&
   src.includes("const diagComp = new Compartment();"));
ck("I2 diagnostics come from check-content on editor text",
   src.includes('postJson("/api/check-content", {') &&
   src.includes("content: view.state.doc.toString() })") &&
   src.includes("setTimeout(refreshDiagnostics, 1200)"));
ck("I3 problems chip jumps to the line",
   html.includes('id="diagChip"') &&
   src.includes("if (diagProblem) jumpToLine(diagProblem.line);"));
ck("I4 toggle reconfigures and clears honestly",
   html.includes('id="setDiag"') &&
   src.includes("view.dispatch(setDiagnostics(view.state, []));"));
ck("I5 checks fire on edit, save and tab activation",
   src.includes("if (currentFile) queueDiagnostics();") &&
   (src.match(/refreshDiagnostics\(\);/g) || []).length >= 3);
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
