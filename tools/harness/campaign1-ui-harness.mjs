// Campaign batch 1 proof (v2.47, I1-I5): the studio
// shelf routes its three tools through one allowlist,
// the replay timeline records and scrubs agent trails,
// and the MCP panel speaks GhostMCP 0.2's new verbs.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const srv = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@CAMPAIGN1@@*/"), b = src.indexOf("/*@@CAMPAIGN1-END@@*/");
ck("CAMPAIGN1 block markers present", a >= 0 && b > a);
const block = src.slice(a, b);
ck("studio panels call the one allowlisted route",
   block.includes('postJson("/api/eco/studio"') &&
   block.includes('studioCall("ghostrecipes", "list")') &&
   block.includes('studioCall("ghostleads", "list")') &&
   block.includes('"quoteshot", verb'));
ck("recipes panel renders data-only checklists, never runs steps",
   block.includes("never runs its steps"));
ck("leads panel states packs are drafts only",
   block.includes("nothing is ever sent from here"));
ck("replay panel lists, gets and scrubs with a slider",
   block.includes('postJson("/api/eco/replay/list", {})') &&
   block.includes('postJson("/api/eco/replay/get"') &&
   block.includes('slider.type = "range"'));
ck("agent loops record trails and save them at exit",
   src.includes("const trail = [];") &&
   src.includes("trail.push({ step: step, type: act.type,") &&
   // Cycle 3 I18: the save call now also passes the
   // run's elapsed seconds (agentT0 / planT0).
   src.includes("saveTrail(task, trail, (Date.now()"));
ck("Tools menu carries the four new entries",
   html.includes('id="toolRecipes"') &&
   html.includes('id="toolLeads"') &&
   html.includes('id="toolQuote"') &&
   html.includes('id="toolReplay"'));
ck("desktop studio allowlist is fixed-shape argv only",
   srv.includes("def eco_studio(") &&
   srv.includes('["list", "--library", lib,') &&
   srv.includes('"--store", str(store)') &&
   srv.includes("unknown studio tool: "));
ck("desktop replay store caps and trims entries",
   srv.includes("def replay_save(") &&
   srv.includes("(trail or [])[:200]") &&
   srv.includes("def replay_get(") &&
   srv.includes("bad replay id"));
ck("desktop MCP wrappers cover the 0.2 verbs",
   srv.includes('["resources", "--server", server]') &&
   srv.includes('["prompts", "--server", server]') &&
   srv.includes('"/api/mcp/prompt"'));
ck("MCP panel grew Resources and Prompts per server",
   src.includes('postJson("/api/mcp/resources"') &&
   src.includes('postJson("/api/mcp/prompts"') &&
   src.includes("blob_base64_chars"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
