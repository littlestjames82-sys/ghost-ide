// Cycle 8 batch 2 proof (v3.04): folding completed.
// The pre-cycle state is the finding: foldAll was
// imported and two Tools buttons called it, but
// codeFolding() was in NO extension list, so the
// commands had no fold state to act on. This
// harness pins the machinery in BOTH extension
// lists - the split pane has its own and would
// otherwise silently miss the feature.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

const base = src.slice(src.indexOf("function baseExtensions"),
  src.indexOf("function saveSession"));
const split = src.slice(src.indexOf("function splitExtensions"),
  src.indexOf("function openSplit"));
ck("I6 codeFolding + foldGutter wired via compartment",
   src.includes("codeFolding, foldGutter,") &&
   src.includes("const foldComp = new Compartment();") &&
   base.includes("foldComp.of(foldExt())"));
ck("I7 fold keymap in the main editor",
   base.includes("keymap.of(foldKeymap)"));
ck("I8 settings toggle present + wired",
   html.includes('id="setFold"') &&
   src.includes('$("setFold").onchange'));
ck("I9 split pane carries fold + diag compartments too",
   split.includes("foldComp.of(foldExt())") &&
   split.includes("diagComp.of(diagExt())"));
ck("I10 the pre-existing Fold buttons now have state to act on",
   src.includes('$("toolFold").onclick') &&
   src.includes("foldAll(view)") &&
   src.includes("[codeFolding(), foldGutter()]"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
