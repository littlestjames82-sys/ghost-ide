// R30 v1.87.0 what's-new proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const block = src.split("/*@@WHATSNEW@@*/")[1].split("/*@@WHATSNEW-END@@*/")[0];
const { cmpVer, whatsNew, whatsNewText } =
  new Function("window", block + "; return { cmpVer, whatsNew, whatsNewText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("versions compare numerically, not lexically",
   cmpVer("1.87.0", "1.9.0") > 0 && cmpVer("1.9.0", "1.87.0") < 0 &&
   cmpVer("1.87.0", "1.87.0") === 0 && cmpVer("2.0.0", "1.99.9") > 0);
const E = [{ version: "1.87.0", goal: "What's new", summary: "S." },
           { version: "1.86.0", goal: "Older", summary: "O." }];
ck("an update surfaces only the newest entry",
   whatsNew(E, "1.80.0").version === "1.87.0" &&
   whatsNew(E, "1.87.0") === null && whatsNew(E, "1.88.0") === null);
ck("first run baselines silently, empty log stays quiet",
   whatsNew(E, null) === null && whatsNew(E, "") === null &&
   whatsNew([], "1.0.0") === null);
ck("the message names version, goal and summary",
   whatsNewText(E[0]) === "What's new in v1.87.0 (What's new): S.");
ck("the check reads the bundled changelog and marks seen",
   src.includes('fetch("changelog.json")') &&
   src.includes('localStorage.setItem("ghostide-seen-version"') &&
   src.includes("setTimeout(checkWhatsNew, 1200);") &&
   src.includes('addMsg("SYSTEM", whatsNewText(fresh));'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
