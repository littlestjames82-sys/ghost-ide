// Agent v3 proof (v2.43, Track A): the toolbelt actions
// parse, batching accepts read-only batches and refuses
// mixed ones, memory priming + handoff are wired into the
// ACT loop, and the RUN policy pack is a real setting.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@AGENT3@@*/"), b = src.indexOf("/*@@AGENT3-END@@*/");
ck("AGENT3 block markers present", a >= 0 && b > a);
const block = src.slice(a, b);
ck("toolbelt parser covers REVERSE/ECO/VERIFY/TEST/GIT",
   block.includes('return { type: "reverse", path: m[1] }') &&
   block.includes('return { type: "eco", tool: m[1].toLowerCase() }') &&
   block.includes('return { type: "verify" }') &&
   block.includes('return { type: "git", what: m[1].toLowerCase() }'));
ck("full parser tries agent3 before agent2",
   block.includes("parseAgent3Action(reply) || parseAgent2Action(reply)"));
ck("toolbelt calls the real endpoints",
   block.includes('postJson("/api/ghostre/run"') &&
   block.includes('postJson("/api/eco/run"') &&
   block.includes('fetch("/api/git/status")') &&
   block.includes('fetch("/api/git/diff-all")') &&
   block.includes('postJson("/api/verify/run", {})') &&
   block.includes('postJson("/api/tests/run"'));
ck("ECO from the agent is limited to the runnable pair",
   block.includes('act.tool !== "ghostindex" && act.tool !== "ghostdeps"'));
ck("batching exists and fences disqualify a batch",
   block.includes("function parseAgentBatch(reply, allowed)") &&
   block.includes('if (text.includes("```")) return [];'));
ck("writes block a batch",
   block.includes("AGENT_BATCH_BLOCK") &&
   block.includes("(WRITE|EDIT|RUN|DELETE|DONE|ASK|CHECK|VERIFY|TEST|MCP)"));
ck("ACT loop runs batches and the toolbelt",
   src.includes("const batch = parseAgentBatch(reply);") &&
   src.includes("await runBatch(batch)") &&
   src.includes('["reverse", "eco", "git", "verify", "test"') &&
   src.includes('} else if (act.type === "mcp") {'));
ck("plan loop batches read-only research",
   src.includes("const pBatch = parseAgentBatch(reply,"));
ck("agent memory primes ACT runs with recall + error memory",
   src.includes('postJson("/api/eco/recall",') &&
   src.includes("Object.entries(emStore())") &&
   src.includes("Project memory for this task:"));
ck("finished runs save a GhostHandoff pack",
   src.includes('postJson("/api/eco/handoff", {})') &&
   src.includes("Session handoff saved"));
ck("RUN policy pack gates auto-approval",
   src.includes('localStorage.getItem("ghostide-agent-policy")') &&
   src.includes('policy === "plan" && !!opts.plan'));
ck("policy select lives next to the agent toggles",
   html.includes('id="agentPolicySel"') &&
   html.includes("Auto-approve when following an approved plan"));
ck("rules teach the toolbelt and batching",
   src.includes("REVERSE <path> - inspect a file or binary with GhostRE") &&
   src.includes("You may BATCH several read-only actions"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
