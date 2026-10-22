// R43 v2.00.0 search-all-chats proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@CHATSEARCH@@*/")[1].split("/*@@CHATSEARCH-END@@*/")[0];
const { searchChats, searchResultsText } =
  new Function("window", block + "; return { searchChats, searchResultsText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const CH = [
  { name: "Ideas", messages: [
    { role: "user", content: "let us build a KAYAK rack" },
    { role: "assistant", content: "Sure, measure the rails first." }] },
  { name: "Bugs", messages: [
    { role: "user", content: "the login times out" },
    { role: "assistant", content: "Check the kayak store cache." }] },
];
ck("matches are case-insensitive and carry chat + speaker",
   searchChats(CH, "kayak").length === 2 &&
   searchChats(CH, "KAYAK")[0].chat === "Ideas" &&
   searchChats(CH, "kayak")[1].role === "assistant");
ck("excerpts center on the match with whitespace collapsed",
   searchChats(CH, "login")[0].excerpt.includes("the login times out") &&
   !searchChats(CH, "login")[0].excerpt.includes("\n"));
ck("the cap holds and empty queries find nothing",
   searchChats(CH, "the", 1).length === 1 &&
   searchChats(CH, "  ").length === 0 &&
   searchChats(CH, "zzz").length === 0);
ck("the results text is honest about counts",
   searchResultsText("zzz", []).startsWith("No matches") &&
   searchResultsText("kayak", searchChats(CH, "kayak"))
     .startsWith("2 matches for \"kayak\":") &&
   searchResultsText("login", searchChats(CH, "login"))
     .includes("[Bugs] You:"));
ck("the tool button exists and reads every session's store",
   html.includes('id="toolSearchChats"') &&
   src.includes('$("toolSearchChats").onclick') &&
   src.includes("sessionHistoryKey(historyScope, s.id)") &&
   src.includes("searchChats(chats, q, 12)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
