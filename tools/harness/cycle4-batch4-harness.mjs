// Cycle 4 batch 4 proof (v2.74): priming upstream
// distance, run output save, MCP refresh past the
// phone cache, About file count, header health dot.
// The first I16 pick (pair revoke-all) was verified
// as already shipped since v2.32 and replaced.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I16 priming reports ahead/behind when nonzero",
   src.includes('" commit(s) ahead "') &&
   src.includes('" commit(s) "'));
ck("I17 run pane saves the full output as .log",
   html.includes('id="runSave"') &&
   src.includes('"ghostide-output-"') &&
   src.includes('$("runOut").textContent'));
ck("I18 refresh bypasses the phone list cache end to end",
   java.includes("boolean refresh") &&
   java.includes('Boolean.TRUE.equals(d.get("refresh"))') &&
   src.includes('"↻ Refresh tools"') &&
   src.includes("refresh: true"));
ck("I19 About counts workspace files",
   src.includes('" file(s)"') &&
   src.includes('fetch("/api/files")'));
ck("I20 health dot polls visibly and explains itself",
   html.includes('id="healthDot"') &&
   /* The dot poller was renamed pollHealthDot in
      Cycle 5: it had shared its name with the model
      poller, which froze the bundle build (A10). */
   src.includes("setInterval(pollHealthDot, 60000)") &&
   src.includes('"Server unreachable'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
