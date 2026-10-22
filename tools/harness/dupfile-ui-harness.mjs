// R46 v2.03.0 duplicate file proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@DUPFILE@@*/")[1].split("/*@@DUPFILE-END@@*/")[0];
const { copyName } =
  new Function("window", block + "; return { copyName };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("suggested names put ' copy' before the extension, same folder",
   copyName("src/main.py") === "src/main copy.py" &&
   copyName("app.js") === "app copy.js" &&
   copyName("README") === "README copy" &&
   copyName(".env") === ".env copy" &&
   copyName("a/b/c.test.ts") === "a/b/c.test copy.ts");
ck("the button exists", html.includes('id="dupFileBtn"'));
ck("duplication reads saved content, writes the copy, opens it",
   src.includes('$("dupFileBtn").onclick') &&
   src.includes('prompt("Duplicate as:", copyName(currentFile))') &&
   src.includes('fetch("/api/file?path=" +') &&
   src.includes("await loadFiles();\n  openFile(name);") &&
   !src.includes("activeSessionId"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
