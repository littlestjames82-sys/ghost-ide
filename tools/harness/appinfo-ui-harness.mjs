// R40 v1.97.0 app info proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@APPINFO@@*/")[1].split("/*@@APPINFO-END@@*/")[0];
const { appInfoText } =
  new Function("window", block + "; return { appInfoText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("the line assembles version and counts",
   appInfoText({ version: "1.97.0", chats: 3, prompts: 5,
     profiles: 2, starred: 7, eco: "25 packages / 2,642 tests" }) ===
   "GhostIDE v1.97.0 · 3 chats · 5 prompts · 2 profiles · " +
   "7 starred answers · eco bundle 25 packages / 2,642 tests");
ck("the info div exists in Settings", html.includes('id="appInfo"'));
ck("counts come from the real stores, version from the changelog",
   src.includes("chats: chatSessions.length,") &&
   src.includes("prompts: promptLib.length,") &&
   src.includes("profiles: Object.keys(loadProfiles()).length,") &&
   src.includes("starred: loadStarAnswers().length,") &&
   src.includes('fetch("changelog.json")') &&
   src.includes("setTimeout(refreshAppInfo, 900);"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
