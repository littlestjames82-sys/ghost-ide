// R28 v1.85.0 last-run line proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@LASTRUN@@*/")[1].split("/*@@LASTRUN-END@@*/")[0];
const { lastRunText } =
  new Function("window", block + "; return { lastRunText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("the line combines stats with the run's settings",
   lastRunText("answered in 3.2s · ~40 tok · ~13 tok/s (estimates)", 0.3, 1024) ===
   "Last run: answered in 3.2s · ~40 tok · ~13 tok/s (estimates) · temp 0.3 · max 1024 tok");
ck("no stats, no line",
   lastRunText("", 0.3, 1024) === "" && lastRunText(null, 0.3, 1024) === "");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("the line exists in Chat options", htmlIds.has("lastRun"));
ck("completion writes and persists the line with real settings",
   src.includes('localStorage.setItem("ghostide-lastrun", lr);') &&
   src.includes("answerMaxTokens(settings.chatLength,") &&
   src.includes('$("lastRun").textContent = lr;'));
ck("the line is restored on startup",
   src.includes('localStorage.getItem("ghostide-lastrun")'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
