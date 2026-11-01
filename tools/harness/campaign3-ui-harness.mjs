// Campaign batch 3 proof (v2.49, I11-I15): replay
// Re-run, Git Last Scope line, eco board-state chips,
// data Pack button, agent CONTEXT action.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@CAMPAIGN3@@*/"), b = src.indexOf("/*@@CAMPAIGN3-END@@*/");
ck("CAMPAIGN3 block markers present", a >= 0 && b > a);
ck("replay sessions can seed a re-run through the chat box",
   src.includes('rerun.textContent = "Re-run"') &&
   src.includes('if (tg) tg.checked = true;') &&
   src.includes("ta.value = s.task || \"\""));
ck("git status carries the last scope headline on both servers",
   py.includes('"scope_line": scope_line') &&
   java.includes('\\"scope_line\\":'));
ck("git panel renders the scope line",
   html.includes('id="gitScopeLine"') &&
   src.includes('"Last Scope: " + d.scope_line'));
ck("eco panel chips carry ids and get board states",
   src.includes('chip.id = "ecoState-" + t.id;') &&
   src.includes("annotateEcoStates();") &&
   src.slice(a, b).includes('"board: verified"') &&
   src.slice(a, b).includes('"board: no report"'));
ck("data pane tracks its file and offers a pack build",
   html.includes('id="dataPack"') &&
   src.includes("dataPanePath = path;") &&
   src.includes('postJson("/api/eco/datapack",'));
ck("datapack endpoint exists on both servers and reads PROMPT.md",
   py.includes("def eco_datapack(path, ws)") &&
   py.includes('"/api/eco/datapack"') &&
   java.includes('"/api/eco/datapack"') &&
   java.includes('"PROMPT.md"'));
ck("agent CONTEXT action parses, batches and fetches the repo map",
   src.includes('return { type: "context" }') &&
   src.includes('"stepdone", "reverse", "eco", "git", "context"]') &&
   src.includes('map = await getRepoMap()') &&
   src.includes('"CONTEXT - fetch the repo map (GhostAtlas)'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
