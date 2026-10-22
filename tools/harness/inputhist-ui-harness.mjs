// R21 v1.78.0 input history proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const block = src.split("/*@@INPUTHIST@@*/")[1].split("/*@@INPUTHIST-END@@*/")[0];
const { SENT_CAP, pushSent, navSent } =
  new Function("window", block + "; return { SENT_CAP, pushSent, navSent };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("sends append in order, trimmed, empties skipped",
   JSON.stringify(pushSent(pushSent([], "  hi "), "")) === '["hi"]' &&
   JSON.stringify(pushSent(["a"], "b")) === '["a","b"]');
ck("re-sending a message moves it to the end (no dupes)",
   JSON.stringify(pushSent(["a", "b", "c"], "a")) === '["b","c","a"]');
ck("the list is capped at 50",
   pushSent(Array.from({ length: 60 }, (_, i) => "m" + i), "new").length === SENT_CAP &&
   pushSent(Array.from({ length: 60 }, (_, i) => "m" + i), "new")[0] === "m11");
const L = ["one", "two", "three"];
ck("Up walks older and stops at the oldest",
   navSent(L, -1, -1).text === "three" && navSent(L, 2, -1).text === "two" &&
   navSent(L, 0, -1).text === "one" && navSent(L, 0, -1).idx === 0);
ck("Down walks newer and returns to the draft sentinel",
   navSent(L, 0, 1).text === "two" &&
   navSent(L, 2, 1).idx === -1 && navSent(L, 2, 1).text === null &&
   navSent(L, -1, 1).text === null && navSent([], -1, -1).text === null);
ck("every send is recorded and persisted",
   src.includes("recordSent(text);") &&
   src.includes('localStorage.getItem("ghostide-sent")') &&
   src.includes('localStorage.setItem("ghostide-sent"'));
ck("recall is wired to the arrow keys with draft restore",
   src.includes('e.key !== "ArrowUp" && e.key !== "ArrowDown"') &&
   src.includes("sentDraft = ta.value;") &&
   src.includes('ta.value = step.idx === -1 ? sentDraft : step.text;'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
