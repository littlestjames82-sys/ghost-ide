// R32 v1.89.0 line operations proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@LINEOPS@@*/")[1].split("/*@@LINEOPS-END@@*/")[0];
const { planLineOp } =
  new Function("window", block + "; return { planLineOp };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const L = ["a", "b", "c"];
ck("duplicate inserts below and follows the copy",
   JSON.stringify(planLineOp(L, 1, "dup")) ===
   JSON.stringify({ lines: ["a", "b", "b", "c"], idx: 2 }));
ck("move swaps with the neighbor and stops at the edges",
   JSON.stringify(planLineOp(L, 1, "up")) ===
   JSON.stringify({ lines: ["b", "a", "c"], idx: 0 }) &&
   JSON.stringify(planLineOp(L, 1, "down")) ===
   JSON.stringify({ lines: ["a", "c", "b"], idx: 2 }) &&
   planLineOp(L, 0, "up").idx === 0 &&
   planLineOp(L, 2, "down").idx === 2);
ck("delete removes, clamps the cursor, never empties the doc",
   JSON.stringify(planLineOp(L, 2, "del")) ===
   JSON.stringify({ lines: ["a", "b"], idx: 1 }) &&
   JSON.stringify(planLineOp(["only"], 0, "del")) ===
   JSON.stringify({ lines: [""], idx: 0 }));
ck("bad indexes and ops are refused, input is not mutated",
   planLineOp(L, 9, "dup") === null && planLineOp(L, 0, "nope") === null &&
   L.length === 3);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("all four status bar buttons exist",
   ["lineDup", "lineUp", "lineDown", "lineDel"].every((i) => htmlIds.has(i)));
ck("ops run through the editor and the Alt keys are editor-only",
   src.includes("function applyLineOp(op)") &&
   src.includes('plan.lines.join("\\n")') &&
   src.includes('e.target.closest(".cm-editor")') &&
   src.includes('$("lineDup").onclick'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
