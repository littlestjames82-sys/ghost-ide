// R29 v1.86.0 export pack 2 proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const grab = (a, b) => src.split(a)[1].split(b)[0];
const { titledMarkdown, allChatsExport, chatToMarkdown } =
  new Function("window",
    grab("/*@@EXPORT@@*/", "/*@@EXPORT-END@@*/") +
    grab("/*@@EXPORT2@@*/", "/*@@EXPORT2-END@@*/") +
    "; return { titledMarkdown, allChatsExport, chatToMarkdown };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const md = chatToMarkdown([{ role: "user", content: "hi" }]);
ck("exports are retitled with the session name",
   titledMarkdown(md, "Ideas").startsWith("# Ideas") &&
   titledMarkdown(md, "Ideas").includes("**You:** hi"));
ck("the combined export skips empties and separates chats",
   allChatsExport(["# A\n\nx", "", "  ", "# B\n\ny"]) ===
   "# A\n\nx\n---\n\n# B\n\ny" &&
   allChatsExport([]) === "");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("both export buttons exist",
   htmlIds.has("toolExportAll") && htmlIds.has("promptExport"));
ck("all-chats reads every session's stored history",
   src.includes('$("toolExportAll").onclick') &&
   src.includes("sessionHistoryKey(historyScope, s.id)") &&
   src.includes('download("ghostide-all-chats.md", out, "text/markdown");') &&
   src.includes('alert("No chats with messages in this project yet.")'));
ck("prompts export downloads the library as JSON",
   src.includes('$("promptExport").onclick') &&
   src.includes('download("ghostide-prompts.json"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
