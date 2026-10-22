// R35 v1.92.0 what-Ghost-sees proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SYSPREV@@*/")[1].split("/*@@SYSPREV-END@@*/")[0];
const { systemPreview } =
  new Function("window", block + "; return { systemPreview };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("the preview lists every shaping input",
   systemPreview({ style: "balanced", persona: "Be direct.",
     custom: "Prefer small diffs.", temp: 0.3, maxTok: 1024,
     budget: 6000, window: 20 }) ===
   "Style: balanced\nPersona: Be direct.\n" +
   "Custom instructions: Prefer small diffs.\n" +
   "Sampling: temp 0.3 · max 1024 tok\n" +
   "Context: slice budget 6000 chars · history window 20");
ck("empty persona and instructions read as (none)",
   systemPreview({ style: "plain", persona: "", custom: "",
     temp: 0.7, maxTok: 512, budget: 3000, window: 10 })
     .includes("Persona: (none)\nCustom instructions: (none)"));
ck("the button exists", html.includes('id="sysPreviewBtn"'));
ck("the preview gathers the REAL send inputs and stays display-only",
   src.includes('$("sysPreviewBtn").onclick') &&
   src.includes("persona: personaSuffix(settings.chatStyle),") &&
   src.includes("maxTok: answerMaxTokens(settings.chatLength,") &&
   src.includes("budget: sliceBudget(),") &&
   src.includes('addMsg("SYSTEM", "What Ghost sees:\\n" + systemPreview({') &&
   !src.includes("history.push({ role: \"system\""));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
