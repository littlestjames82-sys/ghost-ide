// R13 v1.70.0 shortcuts pack proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SHORTCUTS@@*/")[1].split("/*@@SHORTCUTS-END@@*/")[0];
const { SHORTCUTS, stepSession, shortcutHelpText } =
  new Function("window", block + "; return { SHORTCUTS, stepSession, shortcutHelpText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const L = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
ck("stepping moves with wraparound both ways",
   stepSession(L, "s1", 1) === "s2" && stepSession(L, "s3", 1) === "s1" &&
   stepSession(L, "s1", -1) === "s3" && stepSession(L, "s2", -1) === "s1");
ck("stepping from an unknown id lands on the first",
   stepSession(L, "nope", 1) === "s1" && stepSession([], "s1", 1) === "s1");
ck("the table lists the new and existing keys",
   SHORTCUTS.length === 8 && shortcutHelpText().includes("Ctrl + .") &&
   shortcutHelpText().includes("Ctrl + Shift + P"));
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("the shortcuts button exists in HTML", htmlIds.has("shortcutBtn"));
ck("the handler guards the code editor",
   src.includes('e.target.closest(".cm-editor")') && src.includes("if (inEditor) return;"));
ck("each key drives its control",
   src.includes('$("chatText").focus()') && src.includes('$("chatOptsBtn").click()') &&
   src.includes('$("clearChatBtn").click()') &&
   src.includes("switchSession(stepSession(chatSessions, activeSession, 1))"));
ck("help opens from the button as a system message",
   src.includes('$("shortcutBtn").onclick') &&
   src.includes('addMsg("SYSTEM", shortcutHelpText())'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
