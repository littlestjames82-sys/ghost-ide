// R6 v1.63.0 chat export pack proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@EXPORT@@*/")[1].split("/*@@EXPORT-END@@*/")[0];
const { chatToMarkdown, chatToText, chatToHtml, chatStats, chatStatsText } =
  new Function("window", block + "; return { chatToMarkdown, chatToText, chatToHtml, chatStats, chatStatsText };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const hist = [
  { role: "user", content: "hi there" },
  { role: "assistant", content: "use <b>bold</b> & \"quotes\"" },
];
ck("markdown keeps the long-standing format",
   chatToMarkdown(hist) === "# GhostIDE chat export\n\n**You:** hi there\n\n---\n\n**Ghost:** use <b>bold</b> & \"quotes\"\n");
ck("text format is plain and labelled",
   chatToText(hist).startsWith("GhostIDE chat export\n\nYou: hi there") &&
   chatToText(hist).includes("Ghost: use"));
ck("html escapes message content",
   !chatToHtml(hist).includes("<b>bold</b>") &&
   chatToHtml(hist).includes("&lt;b&gt;bold&lt;/b&gt;") &&
   chatToHtml(hist).includes("&amp;"));
ck("html is a standalone page",
   chatToHtml(hist).startsWith("<!doctype html>") &&
   chatToHtml(hist).includes("</html>"));
ck("stats count messages, words and tokens",
   chatStats(hist).messages === 2 && chatStats(hist).words === 6 &&
   chatStats(hist).estTokens === Math.ceil((8 + 26) / 4));
ck("stats text summarizes, empty chat is honest",
   chatStatsText(hist).includes("2 messages") &&
   chatStatsText([]) === "No messages yet.");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("export controls exist in HTML",
   ["exportFmt", "copyWholeBtn", "chatStats"].every((i) => htmlIds.has(i)));
ck("both export buttons share one path",
   src.includes('$("toolExportChat").onclick = () => exportChatAs("md");') &&
   src.includes('exportChatAs($("exportFmt").value)'));
ck("stats refresh on save and on load",
   src.includes("updateChatStats();\n}") &&
   src.includes("restoreChatDraft();\n  updateChatStats();"));
ck("copy whole chat is wired to the text format",
   src.includes('$("copyWholeBtn").onclick') && src.includes("chatToText(history)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
