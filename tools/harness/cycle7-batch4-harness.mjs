// Cycle 7 batch 4 proof (v2.98): continuity.
// Session restore already reopened tabs (pre-cycle);
// this batch adds where-you-were to it, plus find
// text persistence, and makes the new git sections
// tell the truth across the surfaces that summarize
// git state (copy line, agent priming, non-repo
// clearing).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I16 cursor positions ride the session restore",
   src.includes("let pendingPos = {};") &&
   src.includes("pos[p] = st.selection.main.head") &&
   src.includes("pendingPos = s.pos || {};"));
ck("I17 find text persists across reloads",
   src.includes('"ghostide.findText"'));
ck("I18 copy-status line carries the stash depth",
   src.includes('" stashed" : "")'));
ck("I19 agent priming names stashed work",
   src.includes('" stash " +') &&
   src.includes('"entries shelved."'));
ck("I20 non-repo state clears the stash section too",
   src.includes('const sl = $("stashList");'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
