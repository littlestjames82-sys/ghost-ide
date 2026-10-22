// R34 v1.91.0 starred sessions + phantom-fix proof.
// The fix checks matter most: the phantom identifiers
// must be GONE from main.js, and the real ones present.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@STARS@@*/")[1].split("/*@@STARS-END@@*/")[0];
const { parseStars, toggleStar } =
  new Function("window", block + "; return { parseStars, toggleStar };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("PHANTOM FIX: no dead identifiers remain anywhere",
   !src.includes("activeSessionId") && !src.includes("saveSessions()") &&
   !src.includes("syncSessionPicker") && !src.includes("loadPrompts()"));
ck("PHANTOM FIX: auto-name uses the real session plumbing",
   src.includes("(x) => x.id === activeSession);") &&
   src.includes("s.name = name;\n  persistSessions();\n  renderSessionSel();"));
ck("PHANTOM FIX: prompt export reads the real library",
   src.includes("const list = promptLib;"));
ck("star lists parse strictly and toggle cleanly",
   JSON.stringify(parseStars('["s1","s2"]')) === '["s1","s2"]' &&
   JSON.stringify(parseStars("junk")) === "[]" &&
   JSON.stringify(parseStars('{"x":1}')) === "[]" &&
   JSON.stringify(toggleStar(["s1"], "s2")) === '["s1","s2"]' &&
   JSON.stringify(toggleStar(["s1", "s2"], "s1")) === '["s2"]');
ck("star wiring persists per project and re-sorts the picker",
   src.includes('return "ghostide-starred:" + historyScope;') &&
   src.includes('$("sessionStar").onclick') &&
   src.includes("sortSessionsByStars();\n  persistSessions();\n  renderSessionSel();") &&
   src.includes('loadStars().includes(s.id) ? "\\u2605 " : ""'));
ck("the Star button exists",
   html.includes('id="sessionStar"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
