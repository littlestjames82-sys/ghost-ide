// Roadmap G36 proof: the i18n tables are complete and
// honest - every key has both languages, no empty strings,
// every keyed id exists in the HTML, and the English entry
// matches the text the HTML ships today.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@I18N@@*/")[1].split("/*@@I18N-END@@*/")[0];
const fn = new Function("window", block + "; return { I18N, I18N_PH };");
const { I18N, I18N_PH } = fn({});

let passed = 0, failed = 0;
const ck = (name, cond) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  cond ? passed++ : failed++;
};

const htmlIds = new Set(
  [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const keys = Object.keys(I18N);
ck("dictionary covers the main chrome (>= 60 entries)",
  keys.length >= 60);
let both = true, nonempty = true, exists = true, enMatch = true;
const mismatches = [];
for (const [id, s] of Object.entries(I18N)) {
  if (!s.en || !s.es) both = false;
  if (!s.en.trim() || !s.es.trim()) nonempty = false;
  if (!htmlIds.has(id)) { exists = false; mismatches.push(id + " (no element)"); }
  // The English entry must equal the element's shipped text.
  const re = new RegExp('id="' + id + '"[^>]*>([^<]*)<');
  const m = html.match(re);
  if (m && m[1].trim() && m[1].trim() !== s.en) {
    enMatch = false; mismatches.push(id + ": html '" + m[1].trim() + "' vs dict '" + s.en + "'");
  }
}
ck("every entry has en + es", both);
ck("no empty translations", nonempty);
ck("every keyed id exists in the HTML", exists);
ck("English entries match the shipped HTML text", enMatch);
if (mismatches.length) console.log("  " + mismatches.join("\n  "));
let phOk = true;
for (const [id, s] of Object.entries(I18N_PH)) {
  if (!htmlIds.has(id) || !s.en || !s.es) phOk = false;
  const re = new RegExp('id="' + id + '"[^>]*placeholder="([^"]*)"');
  const m = html.match(re);
  if (m && m[1] !== s.en) phOk = false;
}
ck("placeholders: ids exist, both languages, en matches HTML", phOk);
ck("Spanish actually differs from English somewhere real",
  Object.values(I18N).filter((s) => s.en !== s.es).length >= 55);
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
