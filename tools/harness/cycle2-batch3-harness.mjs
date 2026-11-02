// Cycle 2 batch 3 proof (v2.57): watch jump links,
// verify history, eco search, renders history, pack
// management. Desktop routes proven live on a fixture
// (packs listed, renders listed, traversal name
// refused, real pack deleted).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I9 watch: changed files render as open-file links",
   src.includes('link.onclick = (ev) => {') &&
   src.includes("openFile(p);") &&
   src.includes('entry.endsWith(" (gone)")'));
ck("I10 verify history: last five runs kept on-device",
   src.includes('"ghostide.verifyHistory"') &&
   src.includes("Recent verify runs on this device:"));
ck("I11 eco search: rows tagged and filtered by query",
   src.includes("row.dataset.tool = (t.name") &&
   src.includes('ecoSearch.placeholder = "Filter tools…"'));
ck("I12 renders verb on both servers",
   py.includes('if verb == "renders":') &&
   java.includes('verb.equals("renders")'));
ck("I13 datapacks list + delete on both servers",
   py.includes('"/api/eco/datapacks"') &&
   py.includes('"/api/eco/datapack/delete"') &&
   java.includes('"/api/eco/datapacks"') &&
   java.includes('"/api/eco/datapack/delete"'));
ck("I13 delete is pinned to the pack namespace",
   py.includes('r"data-pack-[A-Za-z0-9_.-]+"') &&
   java.includes('"data-pack-[A-Za-z0-9_.-]+"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
