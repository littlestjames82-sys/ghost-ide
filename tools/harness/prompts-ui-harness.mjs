// R3 v1.60.0 prompt library proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@PROMPTS@@*/")[1].split("/*@@PROMPTS-END@@*/")[0];
const { normalizePrompts, upsertPrompt, removePrompt, promptByName } =
  new Function("window", block + "; return { normalizePrompts, upsertPrompt, removePrompt, promptByName };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("normalize drops junk and empties",
   normalizePrompts([{ name: " A ", text: " x " }, { name: "", text: "y" },
     { name: "B" }, "junk", null]).length === 1 &&
   normalizePrompts([{ name: " A ", text: " x " }])[0].name === "A");
ck("normalize dedupes by name, caps name and text",
   normalizePrompts([{ name: "P", text: "1" }, { name: "P", text: "2" }]).length === 1 &&
   normalizePrompts([{ name: "n".repeat(50), text: "t".repeat(5000) }])[0].name.length === 40 &&
   normalizePrompts([{ name: "n", text: "t".repeat(5000) }])[0].text.length === 4000);
ck("upsert appends a new prompt",
   upsertPrompt([], "A", "hello").length === 1);
ck("upsert replaces the same name in place of duplicating",
   upsertPrompt([{ name: "A", text: "old" }], "A", "new").length === 1 &&
   upsertPrompt([{ name: "A", text: "old" }], "A", "new")[0].text === "new");
ck("upsert of blank name/text is a no-op",
   upsertPrompt([{ name: "A", text: "x" }], "  ", "y").length === 1 &&
   upsertPrompt([{ name: "A", text: "x" }], "B", "  ").length === 1);
ck("remove takes only the named prompt",
   removePrompt([{ name: "A", text: "1" }, { name: "B", text: "2" }], "A").length === 1 &&
   removePrompt([{ name: "A", text: "1" }], "Z").length === 1);
ck("lookup finds by exact name",
   promptByName([{ name: "A", text: "1" }], "A").text === "1" &&
   promptByName([{ name: "A", text: "1" }], "a") === null);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("library controls exist in HTML",
   ["promptSel", "promptSave", "promptInsert", "promptDel"].every((i) => htmlIds.has(i)));
ck("library persists under its own key",
   src.includes('localStorage.getItem("ghostide-prompts"') &&
   src.includes('localStorage.setItem("ghostide-prompts"'));
ck("save/insert/delete are wired",
   src.includes('$("promptSave").onclick') && src.includes('$("promptInsert").onclick') &&
   src.includes('$("promptDel").onclick'));
ck("insert refreshes counter + draft",
   src.includes("growChatText();\n  updateChatCount();\n  saveChatDraft();"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
