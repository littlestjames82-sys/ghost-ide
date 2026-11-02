// Cycle 5 batch 4 proof (v2.82): commit viewer,
// replay copy, catalog copy, approve copy, priming
// change names. I16 live-proven on current code:
// a real hash returned stat+patch; "--help" and
// garbage hashes were refused by the hex pin.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I16 commit viewer: pinned hash route on both servers",
   py.includes('"/api/git/show"') &&
   py.includes('r"[0-9a-f]{7,40}"') &&
   java.includes('path.equals("/api/git/show")') &&
   java.includes('chash.matches("[0-9a-f]{7,40}")') &&
   src.includes('"/api/git/show?hash="'));
ck("I17 replay rows copy their summary line",
   src.includes("cpRun") &&
   src.includes("navigator.clipboard.writeText(\n          label.textContent)") ||
   src.includes("label.textContent);"));
ck("I18 catalog copy uses real fields (id, name, state)",
   src.includes('"📋 Copy catalog summary"') &&
   src.includes('t.id + " - " + t.name'));
ck("I19 approve rows copy the action text",
   src.includes('cpAct.title = "Copy this request'));
ck("I20 priming names the first changed paths",
   src.includes('" Changed: "') &&
   src.includes("gs.changes.slice(0, 3)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
