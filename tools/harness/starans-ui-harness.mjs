// R36 v1.93.0 starred answers proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@STARANS@@*/")[1].split("/*@@STARANS-END@@*/")[0];
const { parseStarAnswers, toggleStarAnswer, isStarAnswer } =
  new Function("window", block +
  "; return { parseStarAnswers, toggleStarAnswer, isStarAnswer };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = { ts: 1, text: "answer one" }, b = { ts: 2, text: "answer two" };
ck("starring adds, unstarring removes, state reads back",
   isStarAnswer(toggleStarAnswer([], a), "answer one") &&
   !isStarAnswer(toggleStarAnswer([a], a), "answer one") &&
   toggleStarAnswer([a], b).length === 2);
ck("the list caps at 50, keeping the newest",
   (() => { let l = []; for (let i = 0; i < 55; i++)
     l = toggleStarAnswer(l, { ts: i, text: "ans " + i });
     return l.length === 50 && l[0].text === "ans 5" &&
       l[49].text === "ans 54"; })());
ck("stored data parses strictly",
   parseStarAnswers('[{"text":"x"}]').length === 1 &&
   parseStarAnswers('[{"nope":1}]').length === 0 &&
   parseStarAnswers("junk").length === 0);
ck("identical openings share one identity",
   toggleStarAnswer([{ ts: 1, text: "z".repeat(130) + " A" }],
     { ts: 2, text: "z".repeat(130) + " B" }).length === 0 &&
   toggleStarAnswer([], { ts: 1, text: "z".repeat(130) + " A" }).length === 1);
ck("the Star button rides on answers and Tools lists them",
   src.includes('star.title = "Keep this answer in Starred answers";') &&
   src.includes('$("toolStarred").onclick') &&
   src.includes('localStorage.getItem(\n      "ghostide-starred-answers")') &&
   html.includes('id="toolStarred"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
