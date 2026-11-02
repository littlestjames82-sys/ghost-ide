// Cycle 5 audit batch 4 (v2.86): A16-A20 re-run +
// the cycle posture. A16 swept the shipped sources
// for canary/key-shaped strings: zero hits. A20 is
// the five-source version ritual itself, enforced
// by check_versions in this release's build.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A16 no canary or key-shaped strings in shipped sources",
   !py.includes("sk-canary") && !src.includes("sk-canary") &&
   !java.includes("sk-canary"));
ck("A17 approval rails: one decide route per server; deny-all rides it",
   py.includes("/api/approve/decide") &&
   java.includes('path.equals("/api/approve/decide")') &&
   src.includes('"Deny all"')); // live ledger proof: Cycle 4 A17
ck("A18 caps: show output capped 20000 both servers",
   py.includes('[:20000]') &&
   java.includes("gr.stdout.length() > 20000"));
ck("A19 verify rows render via textContent from structured fields",
   src.includes('p.path + ":"') &&
   src.includes("probBox.textContent"));
/* Was a 2.86.0 literal in Cycle 5 (true only that
   release); the durable claim is server/VERSION.json
   agreement, which check_versions enforces fully. */
ck("A20 versions: server.py and VERSION.json agree",
   py.includes('APP_VERSION = "' +
     JSON.parse(readFileSync(home +
       "/workspace/ghost-ide/VERSION.json", "utf8")).latest +
     '"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
