// R42 v1.99.0 chat size quick-step proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@FSQUICK@@*/")[1].split("/*@@FSQUICK-END@@*/")[0];
const { FS_STEPS, stepFs } =
  new Function("window", block + "; return { FS_STEPS, stepFs };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("steps match the real picker list exactly",
   JSON.stringify(FS_STEPS) === JSON.stringify(["12", "13", "15"]) &&
   src.includes('const CHAT_FS = ["12", "13", "15"];'));
ck("stepping walks and clamps",
   stepFs("12", 1) === "13" && stepFs("13", 1) === "15" &&
   stepFs("15", 1) === "15" && stepFs("12", -1) === "12" &&
   stepFs("99", 1) === "15");
ck("both header buttons exist",
   html.includes('id="fsDown"') && html.includes('id="fsUp"'));
ck("bumps go through the real apply path and keep Settings in sync",
   src.includes("settings.chatFs = stepFs(settings.chatFs, dir);") &&
   src.includes('$("setChatFs").value = String(settings.chatFs);') &&
   src.includes("saveSettings();\n  applyChatLook();") &&
   src.includes('$("fsUp").onclick'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
