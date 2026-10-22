// R4 v1.61.0 sampling controls proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const sBlock = src.split("/*@@SAMPLING@@*/")[1].split("/*@@SAMPLING-END@@*/")[0];
const { TEMP_PRESETS, genStats } =
  new Function("window", sBlock + "; return { TEMP_PRESETS, genStats };")({});
const cBlock = src.split("/*@@CHATOPTS@@*/")[1].split("/*@@CHATOPTS-END@@*/")[0];
const { answerMaxTokens } =
  new Function("window", cBlock + "; return { answerMaxTokens };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("presets are the three documented values",
   TEMP_PRESETS.precise === 0.1 && TEMP_PRESETS.balanced === 0.3 && TEMP_PRESETS.creative === 0.7);
ck("custom length honors an in-range value",
   answerMaxTokens("custom", false, 1024, 768) === 768 &&
   answerMaxTokens("custom", false, 1024, 128) === 128 &&
   answerMaxTokens("custom", false, 1024, 2048) === 2048);
ck("custom length falls back to base out of range",
   answerMaxTokens("custom", false, 1024, 64) === 1024 &&
   answerMaxTokens("custom", false, 1024, 9999) === 1024 &&
   answerMaxTokens("custom", false, 1024, undefined) === 1024);
ck("older lengths still map as before",
   answerMaxTokens("short", false, 1024, 768) === 512 &&
   answerMaxTokens("long", false, 1024, 768) === 2048 &&
   answerMaxTokens("normal", false, 1024, 768) === 1024);
ck("stats line formats time, tokens and rate",
   genStats(400, 2000) === "answered in 2.0s · ~100 tok · ~50 tok/s (estimates)");
ck("stats line is empty for empty or timeless answers",
   genStats(0, 2000) === "" && genStats(100, 0) === "");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("sampling controls exist in HTML",
   ["chatTemp", "chatTempVal", "setCustomTokens", "tempPrecise", "tempBalanced", "tempCreative"]
     .every((i) => htmlIds.has(i)));
ck("both length selects offer Custom",
   (html.match(/value="custom"/g) || []).length === 2);
ck("sliders sync through one function",
   src.includes("function syncTempControls()") && src.includes('$("chatTemp").oninput') &&
   src.includes("setTemperature(TEMP_PRESETS.creative)"));
ck("sendChat passes the custom token count",
   src.includes("settings.customTokens),"));
ck("sendChat shows the stats line after an answer",
   src.includes("genStats(full.length, Date.now() - chatT0)"));
ck("custom tokens setting is validated on save",
   src.includes("if (n >= 128 && n <= 2048)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
