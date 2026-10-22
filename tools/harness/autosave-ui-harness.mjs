// R44 v2.01.0 autosave proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@AUTOSAVE@@*/")[1].split("/*@@AUTOSAVE-END@@*/")[0];
const { autosaveDue } =
  new Function("window", block + "; return { autosaveDue };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("due only when on, open, dirty and idle for two ticks",
   autosaveDue(true, true, true, 2) === true &&
   autosaveDue(true, true, true, 5) === true &&
   autosaveDue(true, true, true, 1) === false &&
   autosaveDue(false, true, true, 9) === false &&
   autosaveDue(true, false, true, 9) === false &&
   autosaveDue(true, true, false, 9) === false);
ck("the setting defaults off and the control exists",
   src.includes("wrapChat: false, autosave: false,") &&
   html.includes('id="setAutosave"'));
ck("the poller snapshots, idles, then calls the REAL save",
   src.includes("setInterval(() => {") &&
   src.includes("const cur = view.state.doc.toString();") &&
   src.includes("if (cur === asSnap) asIdle++;") &&
   src.includes("saveFile();") &&
   src.includes('$("setAutosave").onchange'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
