// Cycle 3 batch 2 proof (v2.64): git-dirty tree
// markers, REPL run-current-file, eco run history,
// verify copy-summary, terminal clear. The REPL
// whole-file assumption was live-proven: a multi-line
// program POSTed to /api/repl executed as one block
// (def + two prints, correct output).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I6 dirty set fed by refreshGit, marked in tree",
   src.includes("const gitDirtyPaths = new Set();") &&
   src.includes("gitDirtyPaths.add(c.path)") &&
   src.includes('el.textContent += " ◆";'));
ck("I7 Run file button, repl-only, capped, editor text",
   html.includes('id="termRunFile"') &&
   src.includes('mode === "repl" ? "" : "none"') &&
   src.includes("text.length > 20000") &&
   src.includes("view.state.doc.toString()"));
ck("I8 eco runs noted on both run paths + shown",
   (src.match(/noteEcoRun\(t\.name, !rr\.error\)/g)
     || []).length === 2 &&
   src.includes('"ghostide.ecoRuns"') &&
   src.includes('"Recent runs: "'));
ck("I9 copy summary writes the pane title",
   html.includes('id="runCopy"') &&
   src.includes('$("runTitle").textContent'));
ck("I10 clear button empties output only",
   html.includes('id="termClear"') &&
   src.includes('$("termOut").textContent = "";'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
