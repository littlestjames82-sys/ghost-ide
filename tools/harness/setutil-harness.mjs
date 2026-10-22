// R13: sanitizeImportedSettings adversarial harness.
// Runs the real @@SETUTIL@@ block from main.js.
import { readFileSync } from "fs";
const src = readFileSync(
  process.env.HOME + "/workspace/ghost-ide/web/src/main.js", "utf8");
const a = src.indexOf("/*@@SETUTIL@@*/");
const b = src.indexOf("/*@@SETUTIL-END@@*/");
if (a < 0 || b < 0) { console.log("BLOCK MISSING"); process.exit(1); }
const window = {};
eval(src.slice(a, b));
const { sanitizeImportedSettings } = window.__ghostSetUtil;
const schema = { name: "x", count: 3, flag: true, note: "n" };
let ok = 0, fail = 0;
const check = (c, l) => { if (c) { ok++; } else { fail++; console.log("  FAIL " + l); } };
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
check(eq(sanitizeImportedSettings(
  { name: "a", count: 5, flag: false, note: "z" }, schema),
  { name: "a", count: 5, flag: false, note: "z" }),
  "clean import passes through");
check(eq(sanitizeImportedSettings(
  { name: "a", evil: "drop", count: 1 }, schema),
  { name: "a", count: 1 }), "unknown keys dropped");
check(eq(sanitizeImportedSettings(
  { name: 42, count: "5", flag: "yes" }, schema), null),
  "all-wrong-types gives null");
check(sanitizeImportedSettings(null, schema) === null
  && sanitizeImportedSettings([1, 2], schema) === null
  && sanitizeImportedSettings("str", schema) === null,
  "null / array / string top level refused");
check(sanitizeImportedSettings({}, schema) === null,
  "empty object gives null");
const polluted = JSON.parse('{"__proto__": {"pwned": 1}, "name": "b"}');
const out = sanitizeImportedSettings(polluted, schema);
check(out && out.name === "b" && !("pwned" in out)
  && ({}).pwned === undefined,
  "prototype pollution attempt neutralized");
check(eq(sanitizeImportedSettings(
  { name: { nested: true }, note: ["a"] }, schema), null),
  "object/array values for string keys dropped");
check(sanitizeImportedSettings(
  { name: "x".repeat(20001) }, schema) === null,
  "overlong string values dropped (R13 cap)");
check(eq(sanitizeImportedSettings(
  { name: "x".repeat(20000) }, schema),
  { name: "x".repeat(20000) }), "at-cap string survives");
console.log(`RESULT ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
