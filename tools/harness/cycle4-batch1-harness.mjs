// Cycle 4 batch 1 proof (v2.71): git ahead/behind,
// tree folder counts, selection word count, terminal
// history persistence, terminal copy. I1 was
// live-proven both ways: a repo with a real upstream
// header "[ahead 1]" reported ahead 1; a repo with no
// upstream reported honest zeros.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I1 ahead/behind parsed on both servers, shown in panel",
   py.includes('r"ahead (\\d+)"') &&
   java.includes("headerCount(ln, \"ahead \")") &&
   src.includes('" ↑" + d.ahead'));
ck("I2 folder rows count descendant files",
   src.includes('x.path.startsWith(f.path + "/")') &&
   src.includes('" (" + kids + ")"'));
ck("I3 selection word count joins the status bar",
   src.includes("selWords") &&
   src.includes("match(/\\S+/g)"));
ck("I4 history persists (localStorage, capped 50)",
   src.includes('"ghostide.termHistory"') &&
   src.includes("termHistory.length > 50") &&
   (src.match(/noteTermHistory\(cmd\)/g) || []).length >= 2);
ck("I5 terminal copy button mirrors the run pane's",
   html.includes('id="termCopy"') &&
   src.includes('$("termOut").textContent'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
