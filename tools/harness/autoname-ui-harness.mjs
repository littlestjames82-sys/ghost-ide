// R33 v1.90.0 auto-name proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const block = src.split("/*@@AUTONAME@@*/")[1].split("/*@@AUTONAME-END@@*/")[0];
const { autoChatName, isDefaultChatName } =
  new Function("window", block + "; return { autoChatName, isDefaultChatName };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("names come from the message, whitespace collapsed",
   autoChatName("  fix the\n login   bug ") === "fix the login bug" &&
   autoChatName("") === "" && autoChatName(null) === "");
ck("long messages trim to 28 chars with an ellipsis",
   autoChatName("please refactor the authentication module now").length === 28 &&
   autoChatName("please refactor the authentication module now").endsWith("…"));
ck("only untouched default names qualify",
   isDefaultChatName("Chat") && isDefaultChatName("Chat 12") &&
   !isDefaultChatName("Ideas") && !isDefaultChatName("Chat ideas"));
ck("the hook fires on the first user message only",
   src.includes("history.push({ role: \"user\", content: text });\n  maybeAutoName(text);") &&
   src.includes('m.role === "user").length;\n  if (users !== 1) return;') &&
   src.includes("s.name = name;\n  persistSessions();\n  renderSessionSel();") &&
   !src.includes("activeSessionId") && !src.includes("syncSessionPicker"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
