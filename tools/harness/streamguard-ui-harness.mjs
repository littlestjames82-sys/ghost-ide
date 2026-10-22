// R18 wiring checks: beforeunload streaming guard.
import { readFileSync } from "fs";
const src = readFileSync(process.env.HOME + "/workspace/ghost-ide/web/src/main.js", "utf8");
let ok = 0, fail = 0;
const check = (c, l) => { if (c) { ok++; } else { fail++; console.log("  FAIL " + l); } };
check(src.includes('addEventListener("beforeunload"'), "guard registered");
check(src.includes("if (chatAbort)"), "guard keys on the live stream");
check(src.includes("e.preventDefault()"), "guard prevents the unload");
check((src.match(/let chatAbort = null;/g) || []).length === 1, "one chatAbort declaration");
console.log(`RESULT ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
