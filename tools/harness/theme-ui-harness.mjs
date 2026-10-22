// Ghost theme proof (v2.40): the editor surfaces and
// syntax palette are defined through CodeMirror's
// theme facet and wired into BOTH editors after
// oneDark, so they actually override the base theme.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("ghostTheme is a CodeMirror theme on the app palette",
   src.includes("const ghostTheme = EditorView.theme({") &&
   src.includes('backgroundColor: "#0d0e13"') &&
   src.includes("}, { dark: true });"));
ck("ghostHighlight defines the violet-forward palette",
   src.includes("const ghostHighlight = HighlightStyle.define([") &&
   src.includes('{ tag: t.keyword, color: "#bb9af7" }') &&
   src.includes("color: \"#9ece6a\""));
ck("the theme imports are in place",
   src.includes("HighlightStyle,") &&
   src.includes('import { tags as t } from "@lezer/highlight";'));
ck("both editors take the theme after oneDark",
   (src.match(/oneDark, ghostTheme, syntaxHighlighting\(ghostHighlight\)/g) || []).length === 2);
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
