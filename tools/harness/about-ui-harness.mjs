// R50 v2.07.0 about-this-build proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@ABOUT@@*/")[1].split("/*@@ABOUT-END@@*/")[0];
const { aboutText } =
  new Function("window", block + "; return { aboutText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("about combines the info line with the newest entry",
   aboutText("GhostIDE v2.07.0 · 3 chats",
     { version: "2.07.0", goal: "About", summary: "S." }) ===
   "GhostIDE v2.07.0 · 3 chats\n\nLatest change (v2.07.0, About): S.");
ck("a missing changelog degrades to the info line alone",
   aboutText(" GhostIDE v? ", null) === " GhostIDE v? ");
ck("the tool button exists", html.includes('id="toolAbout"'));
ck("about reuses the real info assembly and live stores",
   src.includes('$("toolAbout").onclick') &&
   src.includes("aboutText(appInfoText({") &&
   src.includes("profiles: Object.keys(loadProfiles()).length,") &&
   src.includes("starred: loadStarAnswers().length,"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
