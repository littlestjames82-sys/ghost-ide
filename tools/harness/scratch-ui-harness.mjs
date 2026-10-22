// R26 v1.83.0 scratchpad proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
const block = src.split("/*@@SCRATCH@@*/")[1].split("/*@@SCRATCH-END@@*/")[0];
const { trimScratch } =
  new Function("window", block + "; return { trimScratch };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("content trims, empties gate to null",
   trimScratch("  note to self \n") === "note to self" &&
   trimScratch("   ") === null && trimScratch("") === null);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("scratchpad panel and controls exist in HTML",
   ["toolScratch", "scratchPanel", "scratchText", "scratchToChat",
    "scratchSave", "scratchClose"].every((i) => htmlIds.has(i)));
ck("the pad autosaves locally and reloads on open",
   src.includes('localStorage.setItem("ghostide-scratch", e.target.value)') &&
   src.includes('localStorage.getItem("ghostide-scratch")'));
ck("send-to-chat fills the box, save writes scratchpad.md",
   src.includes('$("chatText").value = t;') &&
   src.includes('{ path: "scratchpad.md", content: t }') &&
   src.includes('alert("The scratchpad is empty.")'));
ck("the panel is styled like the other panels",
   css.includes("#scratchPanel { border-top: 1px solid #2e3038;") &&
   css.includes("#scratchText { width: 100%;"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
