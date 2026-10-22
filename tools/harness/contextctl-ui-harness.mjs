// R9 v1.66.0 context control pack proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@CONTEXTCTL@@*/")[1].split("/*@@CONTEXTCTL-END@@*/")[0];
const { clampSliceBudget, diffSnippet } =
  new Function("window", block + "; return { clampSliceBudget, diffSnippet };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("budget accepts exactly the offered values",
   [3000, 6000, 12000, 20000].every((v) => clampSliceBudget(v) === v) &&
   clampSliceBudget("12000") === 12000);
ck("budget falls back to 6000 for anything else",
   clampSliceBudget(4500) === 6000 && clampSliceBudget(0) === 6000 &&
   clampSliceBudget(undefined) === 6000 && clampSliceBudget("lots") === 6000);
ck("empty diffs give no snippet",
   diffSnippet("") === "" && diffSnippet("   \n") === "" && diffSnippet(null) === "");
ck("short diffs pass through untouched",
   diffSnippet("diff --git a b\n+line\n") === "diff --git a b\n+line\n");
ck("long diffs are capped with a marker",
   diffSnippet("x".repeat(7000)).length === 6000 + "\n... (diff truncated)".length &&
   diffSnippet("x".repeat(7000)).endsWith("(diff truncated)"));
ck("every budget call site uses the setting",
   !src.includes("BEHAVIOR.context.sliceBudget") &&
   (src.match(/sliceBudget\(\)/g) || []).length >= 6);
ck("selection attach is gated by its setting",
   src.includes("settings.attachSelection !== false) {") && src.includes("const selNow = view.state.selection.main;"));
ck("diff attach fetches diff-all and appends the snippet",
   src.includes('fetch("/api/git/diff-all")') && src.includes("diffSnippet(dg.diff || \"\")"));
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("context controls exist in HTML",
   ["setSliceBudget", "setAttachSelection", "setAttachDiff"].every((i) => htmlIds.has(i)));
ck("wiring saves all three settings",
   src.includes('$("setSliceBudget").onchange') &&
   src.includes('$("setAttachSelection").onchange') &&
   src.includes('$("setAttachDiff").onchange'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
