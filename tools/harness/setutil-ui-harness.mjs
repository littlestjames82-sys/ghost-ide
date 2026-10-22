// R10 v1.67.0 settings utilities proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SETUTIL@@*/")[1].split("/*@@SETUTIL-END@@*/")[0];
const { rowMatches, sanitizeImportedSettings } =
  new Function("window", block + "; return { rowMatches, sanitizeImportedSettings };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("empty filter matches everything",
   rowMatches("Anything", "") === true && rowMatches("", "") === true);
ck("filter is a case-insensitive substring match",
   rowMatches("Chat creativity (temperature)", "TEMP") === true &&
   rowMatches("Chat creativity", "editor") === false);
const schema = { temperature: 0.3, wrap: true, chatStyle: "balanced", customTokens: 1024 };
ck("import keeps known keys with matching types",
   JSON.stringify(sanitizeImportedSettings(
     { temperature: 0.7, wrap: false, hacker: "x" }, schema)) ===
   JSON.stringify({ temperature: 0.7, wrap: false }));
ck("import drops type mismatches",
   sanitizeImportedSettings({ temperature: "hot", wrap: 1 }, schema) === null &&
   sanitizeImportedSettings({ customTokens: 512 }, schema).customTokens === 512);
ck("import rejects non-objects and empties",
   sanitizeImportedSettings(null, schema) === null &&
   sanitizeImportedSettings([1, 2], schema) === null &&
   sanitizeImportedSettings({}, schema) === null &&
   sanitizeImportedSettings("json", schema) === null);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("utility controls exist in HTML",
   ["setSearch", "setExportBtn", "setImportBtn", "setResetBtn", "setImportFile"]
     .every((i) => htmlIds.has(i)));
ck("filter is wired to the search box",
   src.includes("function filterSettings()") &&
   src.includes('$("setSearch").addEventListener("input", filterSettings)'));
ck("reset clears the settings keys and reloads",
   src.includes('localStorage.removeItem("ghostide-settings")') &&
   src.includes('localStorage.removeItem("ghostide-notify")'));
ck("export downloads the settings JSON",
   src.includes('a.download = "ghostide-settings.json"') &&
   src.includes("JSON.stringify(settings, null, 2)"));
ck("import sanitizes before applying",
   src.includes("sanitizeImportedSettings(obj, settings)") &&
   src.includes("Object.assign(settings, clean);"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
