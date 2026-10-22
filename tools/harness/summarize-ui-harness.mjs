// R45 v2.02.0 summarize chat proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SUMMARIZE@@*/")[1].split("/*@@SUMMARIZE-END@@*/")[0];
const { summaryRequest } =
  new Function("window", block + "; return { summaryRequest };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("the request asks for decisions and open items, briefly",
   summaryRequest([{ role: "user" }, { role: "assistant" }])
     .includes("at most 5 short bullet points") &&
   summaryRequest([{ role: "user" }, { role: "assistant" }])
     .includes("what is still open"));
ck("thin chats are refused",
   summaryRequest([]) === "" && summaryRequest([{ role: "user" }]) === "" &&
   summaryRequest(null) === "");
ck("the button exists", html.includes('id="summarizeBtn"'));
ck("it sends through the normal path, no side channel",
   src.includes('$("summarizeBtn").onclick') &&
   src.includes('$("chatText").value = req;\n  sendChat();') &&
   src.includes('alert("Not enough conversation to summarize yet.")'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
