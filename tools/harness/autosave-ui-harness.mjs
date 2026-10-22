// Autosave proof (rewritten v2.37): ONE autosave
// setting - a mode string owned by the editor
// select. Before the untangle, a v2.01 checkbox
// feature shared the settings key AND the
// setAutosave element id, its binding landed on
// the select (getElementById takes the first
// match) and stomped the mode with undefined,
// and the duplicate "autosave" key in the
// defaults literal made the boolean win.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@AUTOSAVE@@*/")[1].split("/*@@AUTOSAVE-END@@*/")[0];
const { autosaveMode } =
  new Function("window", block + "; return { autosaveMode };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("mode mapping: stored values normalize to a mode",
   autosaveMode("delay") === "delay" &&
   autosaveMode("off") === "off" &&
   autosaveMode(true) === "delay" &&
   autosaveMode(false) === "off" &&
   autosaveMode(undefined) === "off" &&
   autosaveMode("junk") === "off" &&
   autosaveMode(42) === "off");
ck("the mode is normalized at load and at save",
   src.includes("settings.autosave = autosaveMode(settings.autosave);"));
ck("the defaults declare the key once, as a mode",
   src.includes('autosave: "off"') && !src.includes("autosave: false"));
ck("exactly one setAutosave element, and it is the select",
   html.split('id="setAutosave"').length - 1 === 1 &&
   html.includes('<select id="setAutosave">') &&
   html.includes('<option value="delay">'));
ck("no checkbox binding or poller survives",
   !src.includes('$("setAutosave").checked') &&
   !src.includes("asSnap") &&
   !src.includes("autosaveDue"));
ck("the select binding and the debounce own the setting",
   src.includes('$("setAutosave").value = settings.autosave || "off";') &&
   src.includes('if (settings.autosave !== "delay") return;') &&
   src.includes("setTimeout(() => {"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
