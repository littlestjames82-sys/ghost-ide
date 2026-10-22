// R31 v1.88.0 file header actions proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@FILEACT@@*/")[1].split("/*@@FILEACT-END@@*/")[0];
const { pathBase } =
  new Function("window", block + "; return { pathBase };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("basenames resolve from nested and plain paths",
   pathBase("src/deep/main.py") === "main.py" &&
   pathBase("main.py") === "main.py" &&
   pathBase("/abs/path/file.js") === "file.js" &&
   pathBase("") === "" && pathBase(null) === "");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("both header buttons exist",
   htmlIds.has("copyPathBtn") && htmlIds.has("copyFileBtn"));
ck("path copy uses the open file and confirms visually",
   src.includes('$("copyPathBtn").onclick') &&
   src.includes("navigator.clipboard.writeText(currentFile)") &&
   src.includes('alert("No file is open.")'));
ck("file copy copies the live buffer, unsaved edits included",
   src.includes('$("copyFileBtn").onclick') &&
   src.includes("view.state.doc.toString()"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
