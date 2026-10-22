// R15 v1.72.0 editor status pack proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@STATUS@@*/")[1].split("/*@@STATUS-END@@*/")[0];
const { langName, cursorStatus } =
  new Function("window", block + "; return { langName, cursorStatus };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("base format is unchanged without a selection",
   cursorStatus(3, 14, 120, 4096, 0, 0) === "Ln 3, Col 14 · 120 lines · 4096 chars");
ck("a selection adds its char count",
   cursorStatus(3, 14, 120, 4096, 25, 1) ===
   "Ln 3, Col 14 · 120 lines · 4096 chars · 25 selected");
ck("a multi-line selection adds its line count too",
   cursorStatus(3, 14, 120, 4096, 90, 4).endsWith("90 selected (4 lines)"));
ck("language names resolve from extensions",
   langName("src/app.py") === "Python" && langName("web/MAIN.JS") === "JavaScript" &&
   langName("a/b.test.ts") === "TypeScript" && langName("notes.md") === "Markdown");
ck("unknown extensions fall back honestly",
   langName("data.weirdext") === "WEIRDEXT" && langName("LICENSE") === "Text" &&
   langName("") === "" && langName(null) === "");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("the file type span exists in HTML", htmlIds.has("fileType"));
ck("the editor listener uses the formatter",
   src.includes('$("cursorPos").textContent = cursorStatus(') &&
   src.includes('$("fileType").textContent = langName(currentFile);'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
