// R18 v1.75.0 notification sounds proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SOUND@@*/")[1].split("/*@@SOUND-END@@*/")[0];
const { NOTIFY_SOUNDS, beepSpec } =
  new Function("window", block + "; return { NOTIFY_SOUNDS, beepSpec };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("off is silent, soft is one gentle note",
   beepSpec("off").length === 0 && beepSpec("soft").length === 1 &&
   beepSpec("soft")[0].f === 880);
ck("chime rises, pop is short",
   beepSpec("chime").length === 2 &&
   beepSpec("chime")[1].f > beepSpec("chime")[0].f &&
   beepSpec("chime")[1].at > beepSpec("chime")[0].at &&
   beepSpec("pop").every((b) => b.d < 0.1));
ck("unknown sounds fall back to soft",
   beepSpec("nope") === NOTIFY_SOUNDS.soft);
ck("all notes are sane frequencies and times",
   Object.values(NOTIFY_SOUNDS).flat().every((b) =>
     b.f >= 100 && b.f <= 2000 && b.d > 0 && b.d <= 0.5 && b.at >= 0));
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("the picker and test button exist in HTML",
   htmlIds.has("setSound") && htmlIds.has("setSoundTest") &&
   ["off", "soft", "chime", "pop"].every((v) =>
     html.includes('<option value="' + v + '">')));
ck("the sound fires only after the ping gate passes",
   src.includes("return;\n  playNotifySound();\n  if (document.hidden) flashTitle(title);"));
ck("playback is WebAudio, feature-detected, persisted",
   src.includes("window.AudioContext") &&
   src.includes('notifySound: "soft"') &&
   src.includes('$("setSound").onchange') &&
   src.includes('$("setSoundTest").onclick'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
