// R27 v1.84.0 appearance pack 2 proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const css = readFileSync(home + "/workspace/ghost-ide/web/style.css", "utf8");
const block = src.split("/*@@APPEAR2@@*/")[1].split("/*@@APPEAR2-END@@*/")[0];
const { CHAT_FONTS, chatFontStack } =
  new Function("window", block + "; return { CHAT_FONTS, chatFontStack };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("four fonts, default is the empty (untouched) stack",
   Object.keys(CHAT_FONTS).length === 4 && chatFontStack("default") === "" &&
   chatFontStack("mono").includes("monospace") &&
   chatFontStack("nope") === "");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("density and chat font controls exist in Settings",
   htmlIds.has("setDensity") && htmlIds.has("setChatFont") &&
   ["default", "system", "mono", "serif"].every((v) =>
     html.includes('<option value="' + v + '">')));
ck("the chat log reads the font variable",
   css.includes("font-family: var(--ghost-chat-font, inherit);"));
ck("compact density tightens real rules",
   css.includes("body.density-compact button { padding: 4px 9px; }") &&
   css.includes("body.density-compact .msg { margin-bottom: 7px; }") &&
   css.includes("body.density-compact header { padding: 5px 10px; }"));
ck("settings persist and apply both",
   src.includes("autoScroll: true, density: false, chatFont: \"default\",") &&
   src.includes("function applyAppear2()") &&
   src.includes('classList.toggle("density-compact"') &&
   src.includes('$("setDensity").onchange') &&
   src.includes('$("setChatFont").onchange'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
