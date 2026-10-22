// R48 v2.05.0 clear-all-chats proof. Loads the real
// SESSIONS block so the key rule under test is the
// shipped one, not a copy.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const g = (a, b) => src.split(a)[1].split(b)[0];
const { projectHistoryKeys } = new Function("window",
  g("/*@@SESSIONS@@*/", "/*@@SESSIONS-END@@*/") +
  g("/*@@CLEARCHATS@@*/", "/*@@CLEARCHATS-END@@*/") +
  "; return { projectHistoryKeys };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("keys cover the default session's bare key and every named one",
   JSON.stringify(projectHistoryKeys("proj",
     [{ id: "s1" }, { id: "s2" }, { id: "abc" }])) ===
   JSON.stringify(["ghostide-history:proj",
     "ghostide-history:proj:s2", "ghostide-history:proj:abc"]) &&
   projectHistoryKeys("proj", []).length === 0 &&
   projectHistoryKeys("proj", null).length === 0);
ck("the button exists in the backup area", html.includes('id="clearChatsBtn"'));
ck("clearing is confirmed, key-scoped, and re-renders honestly",
   src.includes('$("clearChatsBtn").onclick') &&
   src.includes('confirm("Delete every chat in this project? " +') &&
   src.includes("localStorage.removeItem(k);") &&
   src.includes("loadHistory();\n  renderSessionSel();") &&
   !src.includes("localStorage.clear()"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
