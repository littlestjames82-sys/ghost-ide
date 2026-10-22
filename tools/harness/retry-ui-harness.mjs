// R38 v1.95.0 retry last send proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@RETRY@@*/")[1].split("/*@@RETRY-END@@*/")[0];
const { retryText } =
  new Function("window", block + "; return { retryText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("an unanswered last message is retryable",
   retryText([{ role: "user", content: "a" },
     { role: "assistant", content: "b" },
     { role: "user", content: "fix it" }]) === "fix it");
ck("an answered chat, empty chat and junk are not",
   retryText([{ role: "user", content: "a" },
     { role: "assistant", content: "b" }]) === "" &&
   retryText([]) === "" && retryText(null) === "" &&
   retryText([{ role: "user" }]) === "");
ck("the button exists", html.includes('id="retryBtn"'));
ck("retry pops before resending, so nothing duplicates",
   src.includes('$("retryBtn").onclick') &&
   src.includes("history.pop();\n  saveHistory();\n" +
     '  $("chatText").value = text;\n  sendChat();') &&
   src.includes('alert("Nothing to retry: the last message " +'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
