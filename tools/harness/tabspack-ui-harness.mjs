// R39 v1.96.0 tabs pack proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@TABSPACK@@*/")[1].split("/*@@TABSPACK-END@@*/")[0];
const { othersOf } =
  new Function("window", block + "; return { othersOf };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("others excludes exactly the kept tab",
   JSON.stringify(othersOf(["a", "b", "c"], "b")) === '["a","c"]' &&
   JSON.stringify(othersOf(["a"], "a")) === "[]" &&
   JSON.stringify(othersOf([], "a")) === "[]");
ck("both buttons exist beside the tab bar",
   html.includes('id="tabCloseOthers"') && html.includes('id="tabCloseAll"'));
ck("bulk closes iterate snapshots through the real closeTab",
   src.includes('$("tabCloseOthers").onclick') &&
   src.includes("othersOf(tabOrder.slice(), currentFile)") &&
   src.includes("for (const p of tabOrder.slice()) closeTab(p);") &&
   src.includes("if (!currentFile) return;"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
