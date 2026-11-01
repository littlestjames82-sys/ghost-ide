// Campaign batch 2 proof (v2.48, I6-I10): board run
// buttons + report openers, watch auto-reload of clean
// tabs, queue badge + bulk decide, terminal slicing.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@CAMPAIGN2@@*/"), b = src.indexOf("/*@@CAMPAIGN2-END@@*/");
ck("CAMPAIGN2 block markers present", a >= 0 && b > a);
const block = src.slice(a, b);
ck("board offers Verify, Verdict and Scope runs that refresh it",
   src.includes('["Verify", "/api/verify/run"]') &&
   src.includes('["Verdict", "/api/git/review"]') &&
   src.includes('["Scope", "/api/git/scope"]') &&
   src.includes("openBoardPanel();"));
ck("board cards open their source report in the editor",
   src.includes('open.textContent = "Open report"') &&
   src.includes("openFile(s.source)"));
ck("watch reloads only open, unmodified tabs",
   src.includes("async function reloadOpenTab(p)") &&
   src.includes("const isDirty = p === currentFile ? dirty") &&
   src.includes("if (isOpen && !isDirty && await reloadOpenTab(p))") &&
   src.includes('watchNote = "↻ Reloaded "'));
ck("reload swaps the editor state and clears the dirty flag",
   src.includes("tabStates.set(p, EditorState.create({") &&
   src.includes("tabDirty.set(p, false);"));
ck("queue badge counts pending items on the Tools entry",
   block.includes("async function queueBadgeTick()") &&
   block.includes('b.textContent = n ? "Approve queue (" + n + ")"') &&
   block.includes("setInterval(queueBadgeTick, 20000)"));
ck("queue panel can decide the whole queue at once",
   src.includes('"Approve all"') &&
   src.includes('postJson("/api/approve/decide",'));
ck("terminal pane slices and asks like the run pane",
   html.includes('id="termSlice"') &&
   html.includes('id="termAsk"') &&
   block.includes('postJson("/api/eco/slicelog", { text })') &&
   block.includes('$("termOut").textContent'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
