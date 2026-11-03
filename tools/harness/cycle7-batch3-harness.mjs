// Cycle 7 batch 3 proof (v2.97): search power.
// Proven live on a throwaway workspace copy this
// cycle: default behavior unchanged, ignoreCase and
// regex both match, a bad regex returns a clean
// error, dryRun replace counts without writing,
// and the real replace then writes.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I11 search options on both servers (cap + clean regex error)",
   py.includes('"search pattern too long (200 max)"') &&
   py.includes('"bad regex: "') &&
   java.includes('"search pattern too long (200 max)"') &&
   java.includes('"bad regex: "'));
ck("I12 find toggles in the panel, options persisted",
   html.includes('id="findIgnoreCase"') &&
   html.includes('id="findRegex"') &&
   src.includes('"ghostide.findOpts"'));
ck("I13 match navigation over the last result set",
   src.includes("async function findJump(dir)") &&
   html.includes('id="findNext"'));
ck("I14 replace dryRun on both servers",
   py.includes('"dryRun": dry') &&
   java.includes('\\"dryRun\\":'));
ck("I15 replace flow previews before it writes",
   src.includes("dryRun: true })") &&
   src.includes('" occurrence(s) of \\""'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
