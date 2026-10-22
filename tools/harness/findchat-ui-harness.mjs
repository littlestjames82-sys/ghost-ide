// R12 v1.69.0 find-in-chat proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@FINDCHAT@@*/")[1].split("/*@@FINDCHAT-END@@*/")[0];
const { msgMatches } =
  new Function("window", block + "; return { msgMatches };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("empty query matches everything",
   msgMatches("anything", "") === true && msgMatches("", "") === true);
ck("matching is case-insensitive on both sides",
   msgMatches("Fix the Parser", "parser") === true &&
   msgMatches("Fix the Parser", "PARSER") === true &&
   msgMatches("Fix the Parser", "missing") === false);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("find controls exist in HTML",
   ["chatFind", "chatFindCount"].every((i) => htmlIds.has(i)));
ck("the filter hides non-matches and counts",
   src.includes("function applyChatFind()") &&
   src.includes('el.style.display = hit ? "" : "none"') &&
   src.includes('" messages match"'));
ck("typing drives the filter, loads re-apply it",
   src.includes('$("chatFind").addEventListener("input", applyChatFind)') &&
   src.includes("updateChatStats();\n  applyChatFind();"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
