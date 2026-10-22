// R24 v1.81.0 settings profiles proof. SETUTIL comes
// along because applyProfile runs through sanitize.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const grab = (a, b) => src.split(a)[1].split(b)[0];
const { applyProfile, profileNames } = new Function("window",
  grab("/*@@SETUTIL@@*/", "/*@@SETUTIL-END@@*/") +
  grab("/*@@PROFILES@@*/", "/*@@PROFILES-END@@*/") +
  "; return { applyProfile, profileNames };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const cur = { style: "balanced", temp: 0.3, accent: "green" };
ck("applying a profile overrides only what it holds",
   applyProfile(cur, { style: "teacher" }).style === "teacher" &&
   applyProfile(cur, { style: "teacher" }).accent === "green");
ck("wrong-type values and unknown keys are dropped",
   applyProfile(cur, { temp: "hot" }).temp === 0.3 &&
   !("evil" in applyProfile(cur, { evil: 1 })) &&
   applyProfile(cur, { temp: 0.9 }).temp === 0.9);
ck("a junk profile returns the current settings untouched",
   JSON.stringify(applyProfile(cur, null)) === JSON.stringify(cur) &&
   JSON.stringify(applyProfile(cur, [1, 2])) === JSON.stringify(cur));
ck("profile names list sorted, junk-safe",
   JSON.stringify(profileNames({ b: {}, a: {} })) === '["a","b"]' &&
   profileNames(null).length === 0);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("profile controls exist in Settings",
   ["profSel", "profSave", "profApply", "profDelete"]
     .every((i) => htmlIds.has(i)));
ck("profiles persist under their own key and apply with reload",
   src.includes('localStorage.getItem("ghostide-profiles")') &&
   src.includes("Object.assign(settings, applyProfile(settings, all[name]));") &&
   src.includes("location.reload();"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
