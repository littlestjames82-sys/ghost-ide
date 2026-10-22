// R11 v1.68.0 message tools proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const block = src.split("/*@@MSGTOOLS@@*/")[1].split("/*@@MSGTOOLS-END@@*/")[0];
const { extractCodeBlocks, trimForEdit, answerFilename } =
  new Function("window", block + "; return { extractCodeBlocks, trimForEdit, answerFilename };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("code blocks are extracted without fences or language tags",
   JSON.stringify(extractCodeBlocks("look:\n```js\nlet a = 1;\n```\nend")) ===
   JSON.stringify(["let a = 1;"]));
ck("multiple blocks come out in order",
   extractCodeBlocks("```\na\n```\nx\n```py\nb\n```").join("|") === "a|b");
ck("no blocks or an unclosed fence gives an empty list",
   extractCodeBlocks("plain text").length === 0 &&
   extractCodeBlocks("```\nnever closed").length === 0);
const hist = [
  { role: "user", content: "one" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "two" },
  { role: "assistant", content: "a2" },
];
ck("edit rewind keeps everything before the turn",
   trimForEdit(hist, 2).kept.length === 2 && trimForEdit(hist, 2).text === "two" &&
   trimForEdit(hist, 0).kept.length === 0);
ck("edit refuses assistant turns and bad indexes",
   trimForEdit(hist, 1) === null && trimForEdit(hist, 9) === null &&
   trimForEdit(hist, -1) === null);
ck("answer filenames are sortable timestamps",
   answerFilename(new Date(2026, 9, 21, 13, 5, 9)) === "answer-2026-10-21-130509.md");
ck("renderRich gains Save and Code buttons",
   src.includes('sv.textContent = "💾 Save"') &&
   src.includes("extractCodeBlocks(text)") &&
   src.includes('"/api/file"'));
ck("loaded user turns gain the edit button",
   src.includes("attachEditBtn(body.parentElement, history.length - 1)"));
ck("edit rewinds, reloads and refills the box",
   src.includes("function editUserTurn(idx)") &&
   src.includes('$("chatText").value = t.text;'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
