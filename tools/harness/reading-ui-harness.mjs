// R5 v1.62.0 editor reading pack proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
const block = src.split("/*@@READING@@*/")[1].split("/*@@READING-END@@*/")[0];
const { readingState } =
  new Function("window", block + "; return { readingState };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("defaults: normal spacing, everything on, no classes",
   readingState({}).lineHeight === "1.45" && readingState({}).classes.length === 0);
ck("each off switch maps to its class",
   readingState({ ligatures: false }).classes.join() === "lig-off" &&
   readingState({ lineNumbers: false }).classes.join() === "linenums-off" &&
   readingState({ activeLine: false }).classes.join() === "activeline-off");
ck("all off gives all three classes",
   readingState({ ligatures: false, lineNumbers: false, activeLine: false }).classes.length === 3);
ck("undefined means on (only explicit false turns off)",
   readingState({ ligatures: undefined, lineNumbers: 0 }).classes.length === 0);
ck("spacing is validated against the offered values",
   readingState({ lineHeight: "1.8" }).lineHeight === "1.8" &&
   readingState({ lineHeight: "huge" }).lineHeight === "1.45");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("reading controls exist in HTML",
   ["setLineHeight", "setLigatures", "setLineNumbers", "setActiveLine"].every((i) => htmlIds.has(i)));
ck("wiring applies through one function",
   src.includes("function applyEditorReading()") &&
   src.includes('$("setLineNumbers").onchange') && src.includes("applyEditorReading();"));
ck("CSS carries the variable and the three class rules",
   css.includes("var(--ghost-line-height") && css.includes("body.lig-off .cm-content") &&
   css.includes("body.linenums-off .cm-gutters") && css.includes("body.activeline-off .cm-activeLine"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
