// R8 v1.65.0 chat display pack proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
const block = src.split("/*@@DISPLAY@@*/")[1].split("/*@@DISPLAY-END@@*/")[0];
const { displayState } =
  new Function("window", block + "; return { displayState };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("defaults: 13px text, 360 panel, no classes",
   displayState({}).chatFs === "13" && displayState({}).chatW === "360" &&
   displayState({}).classes.length === 0);
ck("offered sizes and widths pass through (numbers coerced)",
   displayState({ chatFs: 15, chatWidth: 560 }).chatFs === "15" &&
   displayState({ chatFs: 15, chatWidth: 560 }).chatW === "560");
ck("unoffered values fall back to defaults",
   displayState({ chatFs: "99", chatWidth: "1000" }).chatFs === "13" &&
   displayState({ chatFs: "99", chatWidth: "1000" }).chatW === "360");
ck("bubbles need an explicit on, labels an explicit off",
   displayState({ bubbles: true }).classes.join() === "chat-bubbles" &&
   displayState({ bubbles: 1 }).classes.length === 0 &&
   displayState({ roleLabels: false }).classes.join() === "no-roles" &&
   displayState({ roleLabels: true }).classes.length === 0);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("display controls exist in HTML",
   ["setChatFs", "setChatWidth", "setBubbles", "setRoleLabels"].every((i) => htmlIds.has(i)));
ck("wiring applies through one function",
   src.includes("function applyChatLook()") &&
   src.includes('$("setChatWidth").onchange') && src.includes("applyChatLook();"));
ck("CSS variables drive log size and panel width",
   css.includes("font-size: var(--ghost-chat-fs, 13px)") &&
   css.includes("width: var(--ghost-chat-w, 360px)"));
ck("bubble and label rules exist",
   css.includes("body.chat-bubbles .msg") && css.includes("body.no-roles .msg .who"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
