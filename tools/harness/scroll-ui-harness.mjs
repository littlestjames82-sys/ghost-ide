// R20 v1.77.0 auto-scroll control proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SCROLL@@*/")[1].split("/*@@SCROLL-END@@*/")[0];
const { isNearBottom, shouldChatScroll } =
  new Function("window", block + "; return { isNearBottom, shouldChatScroll };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("at the bottom counts as near, far up does not",
   isNearBottom(500, 500, 1000) === true &&
   isNearBottom(430, 500, 1000) === true &&
   isNearBottom(100, 500, 1000) === false);
ck("the threshold is honored",
   isNearBottom(390, 500, 1000, 120) === true &&
   isNearBottom(390, 500, 1000, 80) === false);
ck("auto on always scrolls, auto off follows only when near",
   shouldChatScroll(true, false) === true &&
   shouldChatScroll(true, true) === true &&
   shouldChatScroll(false, true) === true &&
   shouldChatScroll(false, false) === false &&
   shouldChatScroll(undefined, false) === true);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("the checkbox exists in Settings", htmlIds.has("setAutoScroll"));
ck("addMsg measures nearness before appending",
   src.includes("const wasNear = isNearBottom(logEl.scrollTop,") &&
   src.includes("if (shouldChatScroll(settings.autoScroll, wasNear))"));
ck("the streaming scroll is gated the same way",
   src.includes("const logS = $(\"chatLog\");") &&
   src.includes("isNearBottom(logS.scrollTop,"));
ck("the setting defaults on and persists",
   src.includes("autoScroll: true,") &&
   src.includes('$("setAutoScroll").checked = settings.autoScroll !== false;') &&
   src.includes('$("setAutoScroll").onchange'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
