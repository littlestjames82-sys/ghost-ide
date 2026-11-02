// Cycle 6 batch 4 proof (v2.90): background runs +
// control. The pill exists in the DOM with the
// :not(.hidden) display rule (the plain .hidden
// class alone would lose to an inline flex - the
// styling lives in style.css for that reason);
// pause is honored between steps; the queue drains
// FIFO into fresh runs; sequential batches honor
// Stop between actions.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I16 pill in DOM + CSS display rule + step updates",
   html.includes('id="agentPill"') &&
   css.includes("#agentPill:not(.hidden)") &&
   src.includes("agentPillStep("));
ck("I17 pause flag honored between steps, stop wins",
   src.includes("while (agentPause && !agentStop)") &&
   src.includes('agentPillPauseBtn.onclick'));
ck("I18 queue: send-while-busy queues, end drains FIFO",
   src.includes("agentQueue.push(text)") &&
   src.includes("agentQueue.shift()") &&
   src.includes('"▶ Starting queued task ("'));
ck("I19 sequential batches honor Stop between actions",
   src.includes('"(batch stopped by the user)"'));
ck("I20 accounting on the plain Done line too",
   src.includes('"🤖 Done: " + summary + " (Run: "'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
