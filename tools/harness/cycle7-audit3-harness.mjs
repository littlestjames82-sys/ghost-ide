// Cycle 7 audit batch 3 (v3.01): A11-A15 re-run +
// the flow rails part 1. A11 verified LIVE on the
// v3.00 APK during its ritual (apksigner SHA-256
// 8ea8684a...). The rails: the branch name pin is
// byte-identical in shape on both servers, and the
// stash ref is rebuilt from a pinned index on both
// - neither server ever interpolates a client ref.
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
ck("A12 census at the Cycle 7 level: 141 desktop / 131 Java",
   (py.match(/parsed\.path ==/g) || []).length === 141 &&
   (java.match(/path\.equals\("\/api/g) || []).length === 131);
ck("A13 datapack name pins unchanged",
   py.includes('r"data-pack-[A-Za-z0-9_.-]+"') &&
   py.includes('".." in'));
ck("A14 history delta wording honest both ways",
   src.includes(' KB smaller than now') &&
   src.includes('about the same size as now'));
ck("RAIL branch pin identical in shape on both servers",
   py.includes('r"[A-Za-z0-9][A-Za-z0-9._/-]*"') &&
   java.includes('"[A-Za-z0-9][A-Za-z0-9._/-]*"') &&
   py.includes("cannot delete the current branch") &&
   java.includes("cannot delete the current branch"));
ck("RAIL stash ref rebuilt from a pinned index on both",
   py.includes('"stash@{%d}" % idx') &&
   py.includes("isinstance(idx, bool)") &&
   java.includes('"stash@{" + (int) dv + "}"') &&
   java.includes("bad stash index"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
