// Chat options + settings expansion proof (headless part):
// the pure steps behind GhostIDE's expanded chat options -
// answer-style instructions, the custom-instructions suffix,
// the answer-length -> max_tokens mapping (with the legacy
// Short answers flag), the history window sent to the model,
// quick-prompt templates and message time stamps. Extracted
// from main.js between the @@CHATOPTS@@ markers, the same
// pattern as the ECO UI harnesses. The full click-through
// (real DOM, real model) stays with the device pass; wiring
// is asserted statically below.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const src = readFileSync(
  home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(
  home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@CHATOPTS@@*/")[1]
  .split("/*@@CHATOPTS-END@@*/")[0];
const { CHAT_STYLES, QUICK_PROMPTS, personaSuffix,
  answerMaxTokens, windowHistory, quickPromptText,
  msgStamp } = new Function("window",
  block + "; return { CHAT_STYLES, QUICK_PROMPTS, " +
  "personaSuffix, answerMaxTokens, windowHistory, " +
  "quickPromptText, msgStamp };")({});

let passed = 0, failed = 0;
const ck = (name, cond) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  cond ? passed++ : failed++;
};

// --- answer styles ---
ck("five answer styles, balanced first",
   Object.keys(CHAT_STYLES).join(",") ===
   "balanced,teacher,codeonly,reviewer,rubberduck");
ck("balanced adds no instruction",
   CHAT_STYLES.balanced.instruction === "");
ck("every other style has a real instruction",
   ["teacher", "codeonly", "reviewer", "rubberduck"]
     .every((k) => CHAT_STYLES[k].instruction.length > 40));
ck("every style has a label",
   Object.values(CHAT_STYLES)
     .every((s) => s.label && s.label.length > 2));

// --- persona suffix (system prompt addition) ---
ck("balanced + no custom instructions is empty",
   personaSuffix("balanced", "") === "" &&
   personaSuffix("balanced", "   ") === "");
ck("teacher suffix carries its instruction",
   personaSuffix("teacher", "")
     .includes(CHAT_STYLES.teacher.instruction));
ck("custom instructions ride in the suffix, trimmed",
   personaSuffix("balanced", "  Use tabs.  ")
     .includes("Use tabs.") &&
   !personaSuffix("balanced", "  Use tabs.  ")
     .includes("  Use tabs."));
ck("style and custom instructions compose",
   personaSuffix("reviewer", "Be blunt.")
     .includes(CHAT_STYLES.reviewer.instruction) &&
   personaSuffix("reviewer", "Be blunt.")
     .includes("Be blunt."));
ck("custom instructions are capped at 1000 chars",
   personaSuffix("balanced", "x".repeat(1500))
     .includes("x".repeat(1000)) &&
   !personaSuffix("balanced", "x".repeat(1500))
     .includes("x".repeat(1001)));
ck("an unknown style falls back to no instruction",
   personaSuffix("nope", "") === "");

// --- answer length -> max_tokens ---
ck("short is 512, long is 2048, normal is the base",
   answerMaxTokens("short", false, 1024) === 512 &&
   answerMaxTokens("long", false, 1024) === 2048 &&
   answerMaxTokens("normal", false, 1024) === 1024);
ck("legacy Short answers flag still wins when unset",
   answerMaxTokens(undefined, true, 1024) === 512 &&
   answerMaxTokens(undefined, false, 1024) === 1024);
ck("an explicit length beats the legacy flag",
   answerMaxTokens("normal", true, 1024) === 1024 &&
   answerMaxTokens("long", true, 1024) === 2048);

// --- history window (what is SENT, not what is shown) ---
const hist = [];
for (let i = 0; i < 10; i++)
  hist.push({ role: i % 2 ? "assistant" : "user",
    content: "m" + i });
ck("turns 0 / unset sends everything",
   windowHistory(hist, 0).length === 10 &&
   windowHistory(hist, undefined).length === 10);
ck("2 turns sends the last 4 messages, in order",
   windowHistory(hist, 2).map((m) => m.content)
     .join(",") === "m6,m7,m8,m9");
ck("a window bigger than the history sends it all",
   windowHistory(hist, 99).length === 10);
ck("windowing never mutates the full history",
   hist.length === 10 &&
   windowHistory(hist, 1) !== hist);

// --- quick prompts ---
ck("five quick prompts with labels",
   QUICK_PROMPTS.length === 5 &&
   QUICK_PROMPTS.every((p) => p.id && p.label && p.text));
ck("prompt text takes the file name",
   quickPromptText("explain", "app.py")
     .includes("app.py") &&
   !quickPromptText("explain", "app.py").includes("{file}"));
ck("no file open still reads sensibly",
   quickPromptText("bugs", null).includes("this file") &&
   !quickPromptText("bugs", null).includes("{file}"));
ck("an unknown prompt id is empty",
   quickPromptText("nope", "x.py") === "");

// --- message stamps ---
ck("stamp is HH:MM, zero padded",
   msgStamp(new Date(2026, 9, 20, 9, 5)) === "09:05" &&
   msgStamp(new Date(2026, 9, 20, 23, 59)) === "23:59");

// --- static wiring ---
const htmlIds = new Set(
  [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const newIds = ["chatStyle", "chatLength", "chatChips",
  "regenBtn", "copyLastBtn", "exportChatBtn",
  "setChatStyle", "setChatLen", "setCustomInstr",
  "setHistTurns", "setSendKey", "setPing", "setTimestamps",
  "setFontFamily", "setCompactChat", "setReduceMotion"];
ck("all new controls exist in the HTML",
   newIds.every((id) => htmlIds.has(id)));
ck("no duplicate ids were introduced",
   newIds.every((id) =>
     (html.match(new RegExp('id="' + id + '"', "g")) || [])
       .length === 1));
ck("main.js wires every new control",
   newIds.every((id) => src.includes('$("' + id + '")')));
ck("settings defaults carry every new key",
   ["chatStyle", "chatLength", "customInstr", "historyTurns",
    "sendKey", "timestamps", "compactChat", "reduceMotion",
    "fontFamily"].every((k) =>
     new RegExp(k + ":").test(
       src.split("ghostide-settings")[0])));
ck("sendChat uses the persona suffix",
   src.includes("personaSuffix(settings.chatStyle"));
ck("sendChat uses the answer-length mapping",
   src.includes("answerMaxTokens(settings.chatLength"));
ck("sendChat windows the history it sends",
   src.includes("windowHistory(history"));
ck("sendChat no longer hard-codes the short flag alone",
   !src.includes("settings.shortAnswers ? 512"));
ck("the send key honors the Ctrl+Enter setting",
   src.includes('settings.sendKey === "ctrl"'));
ck("timestamps gate on the setting in addMsg",
   src.includes("settings.timestamps && stamp"));
ck("compact chat + reduce motion apply body classes",
   src.includes('"chat-compact"') &&
   src.includes('"reduce-motion"'));
ck("the ping setting writes the existing notify key",
   src.includes('localStorage.setItem("ghostide-notify"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
