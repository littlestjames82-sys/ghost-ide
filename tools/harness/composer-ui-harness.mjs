// R1 v1.58.0 composer pack proof: pure steps extracted
// between @@COMPOSER@@ markers + static wiring.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@COMPOSER@@*/")[1].split("/*@@COMPOSER-END@@*/")[0];
const { CONTINUE_TEXT, estTokens, counterText, chatDraftKey } =
  new Function("window", block + "; return { CONTINUE_TEXT, estTokens, counterText, chatDraftKey };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("est tokens: empty is 0", estTokens("") === 0 && estTokens(null) === 0);
ck("est tokens: chars/4 rounded up", estTokens("abcd") === 1 && estTokens("a".repeat(41)) === 11);
ck("counter text format", counterText("hello") === "5 chars · ~2 tok");
ck("counter text empty is blank", counterText("") === "");
ck("draft key is per scope", chatDraftKey("on-device") === "ghostide-chatdraft:on-device");
ck("continue text says pick up where it left off", CONTINUE_TEXT.includes("where you left off"));
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("new ids exist in HTML", ["chatCount", "continueBtn"].every((i) => htmlIds.has(i)));
ck("input listener grows + counts + saves draft",
   src.includes('$("chatText").addEventListener("input"') &&
   src.includes("saveChatDraft();") && src.includes("growChatText();"));
ck("sendChat clears the draft", src.includes("clearChatDraft();"));
ck("loadHistory restores the draft", src.includes("restoreChatDraft();"));
ck("renderRich adds a per-message copy button", src.includes("msgCopy") && src.includes('cp.textContent = "⧉ Copy"'));
ck("continue button sends the continue text",
   src.includes('$("continueBtn").onclick') && src.includes('$("chatText").value = CONTINUE_TEXT;'));
ck("continue is guarded while a reply streams", src.includes("if (chatAbort) return;"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
