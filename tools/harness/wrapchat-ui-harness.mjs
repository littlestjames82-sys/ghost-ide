// R41 v1.98.0 chat wrap proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
const block = src.split("/*@@WRAPCHAT@@*/")[1].split("/*@@WRAPCHAT-END@@*/")[0];
const { wrapChatClass } =
  new Function("window", block + "; return { wrapChatClass };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("the class maps cleanly from the setting",
   wrapChatClass(true) === "chat-wrap" && wrapChatClass(false) === "");
ck("the CSS actually wraps messages and code",
   css.includes("body.chat-wrap #chatLog .msg { overflow-wrap: anywhere; }") &&
   css.includes("body.chat-wrap .msg pre { white-space: pre-wrap; }"));
ck("the setting defaults off and the control exists",
   src.includes('bubbles: false, wrapChat: false,') &&
   html.includes('id="setWrapChat"'));
ck("wiring toggles the body class and persists",
   src.includes('document.body.classList.toggle("chat-wrap",') &&
   src.includes('$("setWrapChat").onchange') &&
   src.includes("applyWrapChat();"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
