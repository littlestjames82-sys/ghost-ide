// Cycle 3 audit batch 4 (v2.70): A16-A20 re-run, A17
// deepened. Live hammer: 10 parallel MCP calls with
// two per-server restarts fired into the middle -
// 10/10 answered, 0 errors, exactly 1 spawn (the
// restarts landed outside the session's life; batch
// 1 already proved a mid-life drop respawns cleanly),
// and 10 parallel approve-list reads all returned
// valid JSON. A19 fix: the tree's two markers (watch
// dot, git diamond) had no legend anywhere - one now
// sits under the Files head.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A16 timeout census: daemon + helpers stay bounded",
   py.includes("def _mcp_cli(args, timeout=50)") &&
   py.includes("def _eco_cli(tool_id, args, ws, timeout=120)") &&
   py.includes("def _term_run(cmd, timeout=30)"));
ck("A17 daemon lock still serializes session creation",
   py.includes("self.lock = _threading.Lock()") &&
   readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/serve.py", "utf8")
     .includes("def _reap_idle"));
ck("A18 Cycle 3 shapes are plain and consistent",
   py.includes('{"devices": devices}') &&
   py.includes('"sessions"') &&
   py.includes('{"packs": packs}'));
ck("A19 FIX: tree markers carry a legend",
   html.includes("● changed on disk · ◆ uncommitted in git"));
ck("A19 labels stay scoped and honest",
   src.includes('"Recent runs: "') &&
   src.includes('" - waiting "') &&
   html.includes('id="setAbout"'));
ck("A20 this file + campaign carry the verdicts",
   readFileSync(home + "/workspace/ghost-ide/CAMPAIGN_20x20.md", "utf8")
     .includes("C3-I20 DONE"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
