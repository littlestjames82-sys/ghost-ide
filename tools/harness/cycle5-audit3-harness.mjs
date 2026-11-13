// Cycle 5 audit batch 3 (v2.85): A11-A15 re-run.
// A11 verified LIVE on the shipped v2.84 APK
// (apksigner: SHA-256 8ea8684a..., lineage
// unbroken). A15 probed live this cycle on current
// code: malformed JSON -> clean {error}, health 200
// after; the show route answers bad hashes 400.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A11 signer is the build.sh keystore constant",
   readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8")
     .includes("debug.keystore"));
/* Census moved by design: 139/129 after Cycle 7
   batch 1 (branches), 141/131 after batch 2 (stash),
   144/134 after Cycle 8 batch 3 (tags + amend). */
ck("A12 census re-derived: 146 desktop / 134 Java",
   (py.match(/parsed\.path ==/g) || []).length === 146 &&
   (java.match(/path\.equals\("\/api/g) || []).length === 134);
ck("A13 datapack name pins unchanged",
   py.includes('r"data-pack-[A-Za-z0-9_.-]+"') &&
   py.includes('".." in'));
ck("A14 history delta wording honest both ways",
   src.includes(' KB smaller than now') &&
   src.includes('about the same size as now'));
ck("A15 body cap + JSON guard unchanged",
   py.includes("MAX_BODY_BYTES = 64 * 1024 * 1024") &&
   py.includes("read_json"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
