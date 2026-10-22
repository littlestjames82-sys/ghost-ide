// R22 v1.79.0 insert answer proof. Pulls MSGTOOLS in
// too, since insertionText builds on extractCodeBlocks.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const grab = (a, b) => src.split(a)[1].split(b)[0];
const { insertionText } = new Function("window",
  grab("/*@@MSGTOOLS@@*/", "/*@@MSGTOOLS-END@@*/") +
  grab("/*@@INSERT@@*/", "/*@@INSERT-END@@*/") +
  "; return { insertionText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("code answers insert only the code",
   insertionText("Try this:\n```py\nprint(1)\n```\nDone.") === "print(1)");
ck("multiple blocks insert joined",
   insertionText("```\na\n```\nmid\n```\nb\n```") === "a\n\nb");
ck("plain answers insert the full text",
   insertionText("Just words, no code.") === "Just words, no code.");
ck("the button guards on an open file",
   src.includes('alert("Open a file first, then insert.")') &&
   src.includes('ins.textContent = "⤵ Insert"'));
ck("insert replaces the selection through the editor",
   src.includes("view.dispatch({") &&
   src.includes("insert: payload") &&
   src.includes("const payload = insertionText(text);"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
