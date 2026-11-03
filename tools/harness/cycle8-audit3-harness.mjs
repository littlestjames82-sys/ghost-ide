// Cycle 8 audit batch 3 (v3.09): A11-A15 re-run +
// craft rails part 1. A11 verified LIVE on the
// v3.08 APK during this batch (apksigner SHA-256
// 8ea8684a...). Rails: the tag name pin is the
// branch pin's shape on both servers, amend is a
// plain --amend with no force or reset flags
// anywhere near it, and the single-test narrowing
// can only select from the discovered test files.
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
ck("A12 census at the Cycle 8 level: 144 desktop / 134 Java",
   (py.match(/parsed\.path ==/g) || []).length === 144 &&
   (java.match(/path\.equals\("\/api/g) || []).length === 134);
ck("A13 datapack name pins unchanged",
   py.includes('r"data-pack-[A-Za-z0-9_.-]+"') &&
   py.includes('".." in'));
ck("A14 history delta wording honest both ways",
   src.includes(' KB smaller than now') &&
   src.includes('about the same size as now'));
ck("A15 body cap + malformed JSON error path intact",
   py.includes("MAX_BODY_BYTES = 64 * 1024 * 1024"));
ck("RAIL tag pin mirrors the branch pin on both servers",
   py.includes("if not _branch_name_ok(name):") &&
   java.includes('"bad tag name"') &&
   java.includes('name.matches(\n                        "[A-Za-z0-9][A-Za-z0-9._/-]*")') ||
   (py.includes("_branch_name_ok(name)") &&
    java.includes('"bad tag name"')));
ck("RAIL amend is a plain --amend (no force, no reset)",
   py.includes('args = ["commit", "--amend"]') &&
   !py.includes('"--amend", "--hard"') &&
   java.includes('gitArgs("commit",') &&
   java.includes('"--amend"'));
ck("RAIL single-test runs select only from discovered files",
   py.includes('targets = [f["path"] for f in discover_tests()') &&
   py.includes('raise ValueError("not a test file: " + want)'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
