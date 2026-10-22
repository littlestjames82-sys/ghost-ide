// R17 v1.74.0 accent color proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
const block = src.split("/*@@ACCENT@@*/")[1].split("/*@@ACCENT-END@@*/")[0];
const { ACCENTS, accentPair } =
  new Function("window", block + "; return { ACCENTS, accentPair };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("six accents, all valid hex pairs",
   Object.keys(ACCENTS).length === 6 &&
   Object.values(ACCENTS).every((p) =>
     /^#[0-9a-f]{6}$/.test(p.base) && /^#[0-9a-f]{6}$/.test(p.hi)));
ck("green reproduces the pre-pack hexes exactly",
   ACCENTS.green.base === "#2c6e49" && ACCENTS.green.hi === "#35855a");
ck("unknown accents fall back to green",
   accentPair("nope") === ACCENTS.green && accentPair("violet").base === "#6716f3");
ck("CSS defaults carry the variables with the old hexes",
   css.includes(":root { --ghost-accent: #2c6e49; --ghost-accent-hi: #35855a; }"));
ck("every old accent hex became the variable (defaults aside)",
   (css.match(/#2c6e49/g) || []).length === 1 &&
   (css.match(/#35855a/g) || []).length === 1 &&
   (css.match(/var\(--ghost-accent\)/g) || []).length >= 6 &&
   css.includes("background: var(--ghost-accent); border-color: var(--ghost-accent);"));
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("the picker exists with all six options",
   htmlIds.has("setAccent") &&
   ["green", "violet", "blue", "amber", "rose", "teal"]
     .every((v) => html.includes('<option value="' + v + '">')));
ck("settings persist and apply the accent",
   src.includes('chatWidth: "360", accent: "green",') &&
   src.includes("function applyAccent()") &&
   src.includes('setProperty("--ghost-accent", p.base)') &&
   src.includes('$("setAccent").onchange'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
