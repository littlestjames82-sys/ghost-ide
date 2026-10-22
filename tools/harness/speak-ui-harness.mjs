// R14 v1.71.0 speak answer proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const block = src.split("/*@@SPEAK@@*/")[1].split("/*@@SPEAK-END@@*/")[0];
const { speakText } =
  new Function("window", block + "; return { speakText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("code blocks become a spoken placeholder",
   speakText("Run this:\n```\nrm -rf /\n```\nCareful!") ===
   "Run this: (code block) Careful!");
ck("inline code and bold flatten to plain words",
   speakText("Use `grep` for **fast** search") === "Use grep for fast search");
ck("headers lose their hashes, whitespace collapses",
   speakText("## Title\n\nSome   text") === "Title Some text");
ck("long answers are capped for the speech engine",
   speakText("x".repeat(5000)).length === 4000);
ck("the button is feature-detected with a stop toggle",
   src.includes('"speechSynthesis" in window') &&
   src.includes("speechSynthesis.cancel()") &&
   src.includes('sp.textContent = "🔊 Speak"'));
ck("speech uses the flattened text",
   src.includes("new SpeechSynthesisUtterance(speakText(text))"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
