// R7 v1.64.0 slash commands proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const block = src.split("/*@@SLASH@@*/")[1].split("/*@@SLASH-END@@*/")[0];
const { SLASH_COMMANDS, parseSlash, slashHelpText } =
  new Function("window", block + "; return { SLASH_COMMANDS, parseSlash, slashHelpText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("plain text is not a command",
   parseSlash("fix this") === null && parseSlash("") === null && parseSlash(" /fix") === null);
ck("a bare command parses with an empty arg",
   parseSlash("/fix").cmd === "fix" && parseSlash("/fix").arg === "" &&
   parseSlash("/fix").kind === "ai");
ck("command plus note parses, case-insensitive",
   parseSlash("/FIX the parser").cmd === "fix" &&
   parseSlash("/FIX the parser").arg === "the parser");
ck("local commands carry the local kind",
   parseSlash("/clear").kind === "local" && parseSlash("/help").kind === "local" &&
   parseSlash("/regen").kind === "local" && parseSlash("/export").kind === "local");
ck("unknown or malformed commands are not commands",
   parseSlash("/unknown") === null && parseSlash("/") === null &&
   parseSlash("/fix-bug") === null);
ck("the catalogue has all thirteen commands",
   SLASH_COMMANDS.length === 13 &&
   SLASH_COMMANDS.every((c) => c.cmd && c.blurb && c.kind));
ck("help text lists every command",
   SLASH_COMMANDS.every((c) => slashHelpText().includes("/" + c.cmd)));
const scStart = src.indexOf("async function sendChat()");
const scSlice = src.slice(scStart, scStart + 3000);
ck("sendChat intercepts before the model check",
   scSlice.indexOf("parseSlash(text)") > 0 &&
   scSlice.indexOf("parseSlash(text)") < scSlice.indexOf("if (!modelUp)"));
ck("the interception clears the box and the draft",
   src.includes("runSlash(slash);") && src.includes("clearChatDraft();\n    updateChatCount();\n    runSlash(slash);"));
ck("AI commands reuse aiAction with the note",
   src.includes("function aiAction(kind, note) {") &&
   src.includes('aiAction(s.cmd, s.arg)') &&
   src.includes('(note ? "\\n\\nAlso: " + note : "")'));
ck("local commands drive the existing controls",
   src.includes('$("clearChatBtn").click()') && src.includes('$("toolRegen").click()') &&
   src.includes('exportChatAs($("exportFmt").value)') &&
   src.includes('addMsg("SYSTEM", slashHelpText())'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
