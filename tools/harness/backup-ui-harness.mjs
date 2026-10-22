// R19 v1.76.0 data backup proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@BACKUP@@*/")[1].split("/*@@BACKUP-END@@*/")[0];
const { backupKeyOk, buildBackup, parseBackup } =
  new Function("window", block + "; return { backupKeyOk, buildBackup, parseBackup };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("only ghostide- namespaced keys qualify",
   backupKeyOk("ghostide-settings") && backupKeyOk("ghostide-history:/p") &&
   backupKeyOk("ghostide-chatdraft:/p:s1") &&
   !backupKeyOk("other-app-key") && !backupKeyOk("ghostide-") &&
   !backupKeyOk("evil ghostide-settings"));
ck("build keeps app data and drops foreign keys and non-strings",
   JSON.stringify(buildBackup({
     "ghostide-settings": "{}", "ghostide-prompts": "[]",
     "foreign": "x", "ghostide-num": 42 }).data) ===
   JSON.stringify({ "ghostide-settings": "{}", "ghostide-prompts": "[]" }));
ck("a built backup parses back to the same data",
   JSON.stringify(parseBackup(JSON.stringify(buildBackup(
     { "ghostide-settings": "{\"a\":1}" })))) ===
   JSON.stringify({ "ghostide-settings": "{\"a\":1}" }));
ck("parse rejects wrong envelopes",
   parseBackup("{\"app\":\"other\",\"version\":1,\"data\":{}}") === null &&
   parseBackup("{\"app\":\"ghostide-backup\",\"version\":2,\"data\":{\"ghostide-settings\":\"{}\"}}") === null &&
   parseBackup("not json") === null &&
   parseBackup("{\"app\":\"ghostide-backup\",\"version\":1,\"data\":{}}") === null);
ck("parse rejects foreign keys and non-string values inside",
   parseBackup(JSON.stringify({ app: "ghostide-backup", version: 1,
     data: { "foreign": "x" } })) === null &&
   parseBackup(JSON.stringify({ app: "ghostide-backup", version: 1,
     data: { "ghostide-settings": 42 } })) === null);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("both backup buttons exist in Settings",
   htmlIds.has("setExportData") && htmlIds.has("setImportData"));
ck("export downloads the built backup, import confirms then reloads",
   src.includes('download("ghostide-backup.json"') &&
   src.includes("buildBackup(collectLocalMap())") &&
   src.includes('alert("That file is not a valid GhostIDE backup.")') &&
   src.includes("location.reload();"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
