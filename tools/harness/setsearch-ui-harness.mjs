// R11 wiring checks: settings search highlight + Enter jump.
import { readFileSync } from "fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
let ok = 0, fail = 0;
const check = (c, l) => { if (c) { ok++; } else { fail++; console.log("  FAIL " + l); } };
check(src.includes("let setFirstHit = null;"), "first-hit state exists");
check(src.includes('classList.toggle("setHit"'), "matches get the highlight class");
check(src.includes("setFirstHit = el"), "first visible match recorded");
check(src.includes("scrollIntoView"), "Enter scrolls to the match");
check(css.includes(".setHit"), "highlight style defined");
console.log(`RESULT ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
