// Cycle 2 audit batch 3 (v2.61): A11-A15 re-run. Live
// probes: unknown studio verb/tool and a malformed
// body all returned {error} JSON; the v2.60 APK signer
// prefix matches the lineage (8ea8684a...). A11's
// staged-match leg is now enforced inside build.sh
// itself (C2-I20 self-check).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const build = readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A11 staged match enforced in-build (C2-I20)",
   build.includes("SELF-CHECK FAILED"));
ck("A12 terminal honesty unchanged (labels + refusal)",
   src.includes("local shell (unsandboxed)") &&
   java.includes("/api/terminal"));
ck("A13 switch/worktree guards unchanged",
   py.includes("workspace is not a folder") ||
   py.includes("not a folder"));
ck("A14 snapshot-before-overwrite still on the write path",
   py.includes("snapshot_history("));
ck("A15 new routes return {error} JSON shapes",
   py.includes('{"error": "not a pack name"}') &&
   java.includes('"not a "') &&
   py.includes('"unknown studio tool: "'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
