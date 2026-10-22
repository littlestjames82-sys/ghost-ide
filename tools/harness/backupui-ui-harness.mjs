// R7 wiring checks: restore previews before confirming.
import { readFileSync } from "fs";
const src = readFileSync(process.env.HOME + "/workspace/ghost-ide/web/src/main.js", "utf8");
let ok = 0, fail = 0;
const check = (c, l) => { if (c) { ok++; } else { fail++; console.log("  FAIL " + l); } };
const iIns = src.indexOf("/api/backup/inspect");
const iRes = src.indexOf("/api/backup/restore");
check(iIns > 0, "inspect endpoint used");
check(iIns < iRes, "inspect happens before restore");
check(src.includes("ins.files"), "preview shows file count");
check(src.includes("ins.created"), "preview shows backup date");
check(src.includes("ins.version"), "preview shows format version");
check(src.includes("format v"), "format label present");
console.log(`RESULT ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
