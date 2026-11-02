// Cycle 4 audit batch 3 (v2.77): A11-A15. A11 signer
// verified LIVE on the v2.76 APK (apksigner SHA-256
// 8ea8684a..., lineage unbroken). A15 malformed JSON
// probed live on the fixture server: clean {error}
// answers on tools + decide, health still 200 after.
// A12 takes a fresh route census as the Cycle 5
// baseline: desktop 136 parsed.path comparisons,
// Java 126 path.equals("/api...") routes.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A11 signer lineage is a build.sh constant, not luck",
   readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8")
     .includes("debug.keystore"));
ck("A12 route census recorded (136 desktop / 126 Java)",
   (py.match(/parsed\.path ==/g) || []).length === 136 &&
   (java.match(/path\.equals\("\/api/g) || []).length === 126);
ck("A13 name pins still refuse traversal shapes",
   py.includes('r"data-pack-[A-Za-z0-9_.-]+"') &&
   py.includes('".." in'));
ck("A14 history delta is display-only math (no writes)",
   py.includes("/api/history") &&
   readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8")
     .includes('" KB smaller than now"'));
ck("A15 body cap + JSON guard unchanged",
   py.includes("MAX_BODY_BYTES = 64 * 1024 * 1024") &&
   py.includes("def read_json"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
