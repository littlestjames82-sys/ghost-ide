// R37 v1.94.0 slash commands pack 2 proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const g = (a, b) => src.split(a)[1].split(b)[0];
const { SLASH_COMMANDS, parseSlash, slashHelpText } = new Function("window",
  g("/*@@SLASH@@*/", "/*@@SLASH-END@@*/") +
  "; return { SLASH_COMMANDS, parseSlash, slashHelpText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("the table now carries thirteen commands",
   SLASH_COMMANDS.length === 13 &&
   ["rename", "star", "scratch", "backup", "sees"]
     .every((c) => SLASH_COMMANDS.some((x) => x.cmd === c)));
ck("/rename parses its argument, the others parse bare",
   parseSlash("/rename Deep work").arg === "Deep work" &&
   parseSlash("/star").cmd === "star" &&
   parseSlash("/sees").cmd === "sees" &&
   parseSlash("/backup now").cmd === "backup");
ck("help lists the new commands",
   slashHelpText().includes("/rename") &&
   slashHelpText().includes("/sees"));
ck("the dispatcher wires every new command to real controls",
   src.includes('if (s.cmd === "rename")') &&
   src.includes("cur.name = name;\n      persistSessions();\n      renderSessionSel();") &&
   src.includes('$("sessionStar").click(); return; }') &&
   src.includes('$("toolScratch").click(); return; }') &&
   src.includes('$("toolBackup").click(); return; }') &&
   src.includes('$("sysPreviewBtn").click(); return; }') &&
   !src.includes("activeSessionId"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
