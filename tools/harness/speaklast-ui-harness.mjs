// R49 v2.06.0 speak-last-answer proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SPEAKLAST@@*/")[1].split("/*@@SPEAKLAST-END@@*/")[0];
const { lastAnswerOf } =
  new Function("window", block + "; return { lastAnswerOf };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("the newest assistant message wins",
   lastAnswerOf([{ role: "assistant", content: "old" },
     { role: "user", content: "q" },
     { role: "assistant", content: "new" }]) === "new" &&
   lastAnswerOf([{ role: "user", content: "q" }]) === "" &&
   lastAnswerOf([]) === "" && lastAnswerOf(null) === "");
ck("the button exists", html.includes('id="speakLastBtn"'));
ck("speech mirrors the proven per-message path, stop included",
   src.includes('$("speakLastBtn").onclick') &&
   src.includes('alert("No answer to speak yet.")') &&
   src.includes("if (speechSynthesis.speaking) {\n    speechSynthesis.cancel();\n    return;\n  }") &&
   src.includes("new SpeechSynthesisUtterance(speakText(text)))"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
