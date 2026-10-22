// R17: aboutText evidence line (pure block, real source).
import { readFileSync } from "fs";
const src = readFileSync(process.env.HOME + "/workspace/ghost-ide/web/src/main.js", "utf8");
const a = src.indexOf("/*@@ABOUT@@*/"), b = src.indexOf("/*@@ABOUT-END@@*/");
const window = {};
eval(src.slice(a, b));
const { aboutText } = window.__ghostAbout;
let ok = 0, fail = 0;
const check = (c, l) => { if (c) { ok++; } else { fail++; console.log("  FAIL " + l); } };
check(aboutText("INFO", null) === "INFO", "no entry, no evidence: info alone");
check(aboutText("INFO", { version: "1.0", goal: "g", summary: "s" }).includes("Latest change"), "entry still appended");
const full = aboutText("INFO", null, "backups v1 + v2 · target SDK 36");
check(full.includes("Build evidence: backups v1 + v2"), "evidence line appended");
check(src.includes('fetch("/api/health")'), "handler reads health");
check(src.includes("h.backupFormats") && src.includes("h.targetSdk"), "evidence built from health fields");
console.log(`RESULT ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
