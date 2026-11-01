// MCP proof (v2.44): the MCP panel lists servers and tools
// and calls them through /api/mcp/*; the agent gained the
// MCP action, a briefing that names the available tools,
// and a Plan-mode refusal (tools can have side effects).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const srv = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@MCPGIT@@*/"), b = src.indexOf("/*@@MCPGIT-END@@*/");
ck("MCPGIT block markers present", a >= 0 && b > a);
const block = src.slice(a, b);
ck("panel walks servers -> tools -> call",
   block.includes('fetch("/api/mcp/servers")') &&
   block.includes('postJson("/api/mcp/tools"') &&
   block.includes('postJson("/api/mcp/call"'));
ck("call arguments are parsed JSON, never eval'd text",
   block.includes("args = JSON.parse(raw)") &&
   block.includes("That was not valid JSON"));
ck("Tools menu has the MCP entry",
   html.includes('id="toolMcp"') &&
   block.includes('toolMcpBtn.onclick'));
const a3 = src.slice(src.indexOf("/*@@AGENT3@@*/"),
                     src.indexOf("/*@@AGENT3-END@@*/"));
ck("agent MCP action parses server, tool and JSON args",
   a3.includes('return { type: "mcp", server: m[1], tool: m[2], args }') &&
   a3.includes('postJson("/api/mcp/call"'));
ck("bad JSON args are reported back to the model",
   a3.includes("argsError: true") &&
   a3.includes("the arguments were not valid JSON"));
ck("MCP blocks batching (side effects are not batchable)",
   a3.includes("VERIFY|TEST|MCP"));
ck("ACT loop runs the MCP action",
   src.includes('"mcp"].includes(act.type))'));
ck("Plan mode refuses MCP calls",
   src.includes('"test", "mcp"].includes(act.type))'));
ck("agent briefing lists configured MCP tools",
   src.includes("MCP tools available in this") &&
   src.includes('postJson("/api/mcp/tools",'));
ck("rules teach the MCP action",
   src.includes("MCP <server> <tool> <json-args> - call a tool on a"));
ck("desktop server exposes the MCP routes",
   srv.includes('"/api/mcp/servers"') &&
   srv.includes('"/api/mcp/tools"') &&
   srv.includes('"/api/mcp/call"') &&
   srv.includes("no MCP config found"));
ck("desktop delegates to the GhostMCP tool, not a rewrite",
   srv.includes('eco_src_dir(tool_id)') &&
   srv.includes('"ghostmcp"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
