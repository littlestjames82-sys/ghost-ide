// R47 v2.04.0 jump-to-latest proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const g = (a, b) => src.split(a)[1].split(b)[0];
const { showJump } = new Function("window",
  g("/*@@SCROLL@@*/", "/*@@SCROLL-END@@*/") +
  g("/*@@JUMP@@*/", "/*@@JUMP-END@@*/") +
  "; return { showJump };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
// viewport 400 tall, content 2000: bottom is st=1600.
ck("the button shows only when well above the bottom",
   showJump(0, 400, 2000) === true &&
   showJump(1000, 400, 2000) === true &&
   showJump(1500, 400, 2000) === false &&
   showJump(1600, 400, 2000) === false &&
   showJump(0, 400, 300) === false);
ck("the button exists, hidden at rest",
   html.includes('id="jumpLatest" class="hidden"'));
ck("scrolling syncs it and clicking jumps to the end",
   src.includes('$("chatLog").addEventListener("scroll", syncJumpBtn);') &&
   src.includes("el.scrollTop = el.scrollHeight;") &&
   src.includes("!showJump(el.scrollTop, el.clientHeight,"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
