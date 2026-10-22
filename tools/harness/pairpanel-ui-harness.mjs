// R3 wiring checks: unpair row + status text.
import { readFileSync } from "fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let ok = 0, fail = 0;
const check = (c, l) => { if (c) { ok++; } else { fail++; console.log("  FAIL " + l); } };
check(src.includes("pairStateRow"), "status row exists");
check(src.includes("localStorage.removeItem(PAIR_TOKEN_KEY)"), "unpair forgets the token");
check(src.includes("storedPairToken()"), "status reads the stored token");
check((src.match(/PAIR_TOKEN_KEY = /g) || []).length === 1, "one token key definition");
check(src.includes("Unpaired. Reload"), "unpair feedback text");
console.log(`RESULT ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
