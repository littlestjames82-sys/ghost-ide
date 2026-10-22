// R25 v1.82.0 pinned files proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@PINFILES@@*/")[1].split("/*@@PINFILES-END@@*/")[0];
const { PIN_CAP, togglePin, pinKey } =
  new Function("window", block + "; return { PIN_CAP, togglePin, pinKey };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("pinning adds, re-pinning removes",
   JSON.stringify(togglePin([], "a.py")) === '["a.py"]' &&
   JSON.stringify(togglePin(["a.py", "b.py"], "a.py")) === '["b.py"]');
ck("the cap drops the oldest pin",
   JSON.stringify(togglePin(["a", "b", "c"], "d")) === '["b","c","d"]' &&
   PIN_CAP === 3);
ck("pinning nothing changes nothing, keys are scoped",
   JSON.stringify(togglePin(["a"], "")) === '["a"]' &&
   pinKey("/proj") === "ghostide-pinned:/proj");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("pin controls exist in HTML",
   htmlIds.has("pinFileBtn") && htmlIds.has("pinChips"));
ck("sends attach pinned files before the selection attach",
   src.indexOf("for (const p of pinnedFiles)") >
   src.indexOf("const attachedNames = [];") &&
   src.indexOf("for (const p of pinnedFiles)") <
   src.indexOf("const selNow = view.state.selection.main;") &&
   src.includes('attachedNames.push("📌 " + p);'));
ck("pins load per scope and render as chips",
   src.includes("loadPinned();\n}") &&
   src.includes("function renderPinChips()") &&
   src.includes('$("pinFileBtn").onclick'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
