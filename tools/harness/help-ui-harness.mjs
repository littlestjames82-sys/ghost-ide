// R16 v1.73.0 help pack proof. Extracts the CHATOPTS,
// SLASH and SHORTCUTS pure blocks alongside HELP so the
// assembled text can be checked against the live tables.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const grab = (a, b) => src.split(a)[1].split(b)[0];
const ctx = new Function("window",
  grab("/*@@CHATOPTS@@*/", "/*@@CHATOPTS-END@@*/") +
  grab("/*@@SLASH@@*/", "/*@@SLASH-END@@*/") +
  grab("/*@@SHORTCUTS@@*/", "/*@@SHORTCUTS-END@@*/") +
  grab("/*@@HELP@@*/", "/*@@HELP-END@@*/") +
  "; return { CHAT_STYLES, QUICK_PROMPTS, SLASH_COMMANDS, buildHelpText };")({});
const { CHAT_STYLES, QUICK_PROMPTS, SLASH_COMMANDS, buildHelpText } = ctx;
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const help = buildHelpText();
ck("help names every live answer style",
   Object.keys(CHAT_STYLES).every((s) => help.includes(s)));
ck("help names every slash command and quick prompt",
   SLASH_COMMANDS.every((c) => help.includes("/" + c.name)) &&
   QUICK_PROMPTS.every((q) => help.includes(q.label)));
ck("help carries the shortcuts list",
   help.includes("Ctrl + .") && help.includes("Keyboard shortcuts"));
ck("help includes the practical tips",
   help.includes("Edit & resend") && help.includes("Find in chat"));
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("the Help button exists in the Tools panel", htmlIds.has("toolHelp"));
ck("the button hides tools and posts the help",
   src.includes('$("toolHelp").onclick') &&
   src.includes('addMsg("SYSTEM", buildHelpText())'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
