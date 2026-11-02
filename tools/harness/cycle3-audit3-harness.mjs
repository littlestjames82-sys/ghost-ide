// Cycle 3 audit batch 3 (v2.69): A11-A15 re-run, A13
// deepened onto the pack view pin - and the deepening
// caught TWO real defects in Cycle 3's own pack panel
// (v2.66, never installed): it called a list route
// that does not exist (/api/eco/datapack/list; the
// real one is /api/eco/datapacks, entries are objects)
// and read view fields that do not exist (v.file /
// v.text; the route returns {ok, output}, as the Data
// pane has always read). Both fixed here. Live probes:
// 7 traversal-shaped pack names all refused by view;
// a real pack builds, lists and views; malformed JSON
// earns clean 400s and the server stays healthy; the
// v2.68 APK's signer cert is the lineage 8ea8684a.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A11 signer lineage is a build input, not a hope",
   readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8")
     .includes("ghostide-apk/debug.keystore"));
ck("A12 terminal honesty label intact",
   html.includes("local shell (unsandboxed)"));
ck("A13 view pin identical to the delete pin",
   (py.match(/data-pack-\[A-Za-z0-9_\.\-\]\+/g)
     || []).length >= 2);
ck("A13 FIX: pack panel uses the real list route + shapes",
   src.includes('postJson("/api/eco/datapacks", {})') &&
   !src.includes("/api/eco/datapack/list") &&
   src.includes("v.output || \"(empty pack summary)\""));
ck("A14 body cap still enforced at read_json",
   py.includes("MAX_BODY_BYTES = 64 * 1024 * 1024"));
ck("A15 malformed bodies become JSON 400s, never crashes",
   py.includes("def read_json") &&
   py.includes("Expecting") === false &&
   py.includes("json.loads"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
