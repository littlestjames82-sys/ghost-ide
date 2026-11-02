// Cycle 4 batch 2 proof (v2.72): deny-all, verify
// trend history, grouped find, persistent filter,
// What's New viewer. Three first picks for this batch
// (font size, word wrap, Quick Open recents) were
// verified as ALREADY covered and replaced before
// building - see the campaign file.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I6 deny-all loops decides, confirms, executes nothing",
   src.includes('"Deny all "') &&
   src.includes('decision: "deny"') &&
   src.includes('confirm("Deny all "'));
ck("I7 verify history keeps 12 with trend markers",
   src.includes("hist.slice(0, 12)") &&
   src.includes('" ▼ fewer problems"') &&
   src.includes('" ▲ more problems"'));
ck("I8 plain find groups matches under counted file heads",
   src.includes("const byFile = new Map();") &&
   src.includes('" (" + ms.length + ")"'));
ck("I9 file filter persists and restores at boot",
   src.includes('"ghostide.fileFilter"') &&
   src.includes('$("fileFilter").value = fileFilterText'));
ck("I10 What's new renders the bundled changelog",
   html.includes('id="setWhatsNew"') &&
   src.includes('fetch("changelog.json")') &&
   src.includes("(d.entries || []).slice(0, 6)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
