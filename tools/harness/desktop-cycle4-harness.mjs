// Desktop Cycle 2, D8 (v3.14.0): MCP polish. Static
// pins over the shipped sources, then a full HTTP
// end-to-end against a real server subprocess with a
// stdio fixture MCP server: tools listed with
// annotations and policy defaults, a disabled tool
// refused by the server (the fixture call log proves
// the call never arrived), approval mode persisted,
// status honesty, the catalog, paste-import errors,
// and header credentials that are stored but never
// echoed back by any route.
import { readFileSync, mkdtempSync, mkdirSync,
  writeFileSync, copyFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const py = readFileSync(root + "server.py", "utf8");
const src = readFileSync(root + "web/src/main.js", "utf8");
const bundle = readFileSync(root + "web/app.js", "utf8");
const vjson = JSON.parse(readFileSync(root + "VERSION.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

/* ---------- static pins ---------- */
ck("D8 version: desktop train agreement (3.14.0 at D8), phone train re-synced at M1",
   vjson.desktop && vjson.desktop.version !== "3.10.1" &&
   py.includes('APP_VERSION = "' + vjson.desktop.version + '"') &&
   vjson.version === vjson.desktop.version &&
   vjson.latest === vjson.desktop.version &&
   vjson.android && vjson.android.version === vjson.desktop.version);
ck("D8 route census re-derived: 194 (190 + 4 git depth routes in D9) (Mobile Cycle 3 S1: +3 desktop / +2 Java task-record routes)",
   (py.match(/parsed\.path ==/g) || []).length === 197);
ck("D8 server: policy store lives in the workspace .ghostide folder",
   py.includes('def mcp_policy_path():') &&
   py.includes('WORKSPACE / ".ghostide" / "mcp-policy.json"'));
ck("D8 server: refusal is enforced inside mcp_call and mcp_prompt",
   (py.match(/MCP server '%s' is disabled in this workspace/g) || []).length === 2 &&
   py.includes('"MCP tool \'%s\' on server \'%s\' is disabled in "'));
ck("D8 server: header values live in app data and are never in a view",
   py.includes('def mcp_secrets_path():') &&
   py.includes('"header_names"') &&
   py.includes('entry.get("headers")'));
ck("D8 server: OAuth is PKCE S256 with app-data token storage",
   py.includes('def mcp_oauth_start(server):') &&
   py.includes('"code_challenge_method": "S256",') &&
   py.includes('def mcp_oauth_refresh(server, rec):') &&
   py.includes('"/api/mcp/oauth/callback"'));
ck("D8 server: catalog entries carry honest labels and runtimes",
   py.includes('else "Runs commands on this computer"') &&
   py.includes('"label": "Remote server"') &&
   py.includes('"runtime": "Node.js (npx)"') &&
   py.includes('def mcp_catalog():'));
ck("D8 server: the new settings routes are host-only like /api/trust",
   py.includes('def _mcp_host_only(handler):') &&
   (py.match(/_mcp_host_only\(self\)/g) || []).length >= 5);
ck("D8 client: agent loop consults policy before the approval prompt",
   src.includes("await mcpRunRefusal(act)") &&
   src.includes("await mcpRunAllowed(act)") &&
   src.includes('if (policy === "queue")'));
ck("D8 client: the briefing only offers enabled tools",
   src.includes(".filter((x) => x.enabled !== false)"));
ck("D8 client: panel has per-tool toggles, approval select, manage section",
   src.includes("renderMcpManage(box)") &&
   src.includes('"always ask"') &&
   src.includes('"allow in this workspace"') &&
   bundle.includes("renderMcpManage"));
ck("D8 client: no new innerHTML (census holds at 101)",
   (src.match(/innerHTML/g) || []).length === 101);

/* ---------- HTTP end-to-end ---------- */
const td = mkdtempSync(tmpdir() + "/ghostide-d8-e2e-");
const app = td + "/app";
mkdirSync(app + "/web", { recursive: true });
mkdirSync(app + "/playground", { recursive: true });
for (const f of ["server.py", "ghost_paths.py", "updater.py",
    "workspace_trust.py", "lsp_manager.py", "embed_index.py", "debug_bridge.py",
    "VERSION.json"])
  copyFileSync(root + f, app + "/" + f);
writeFileSync(app + "/web/index.html", "<html></html>");
const ws = td + "/ws";
mkdirSync(ws, { recursive: true });
copyFileSync(root + "tests/fixtures/fake_mcp_server.py",
             ws + "/fake_mcp_server.py");
const callLog = td + "/calls.log";
writeFileSync(ws + "/.mcp.json", JSON.stringify({ mcpServers: {
  fx: { command: "python3", args: [ws + "/fake_mcp_server.py"],
        env: { FAKE_MCP_LOG: callLog } } } }));
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.method === "POST"
      ? { choices: [{ message: { role: "assistant", content: "ok" } }] }
      : { status: "ok" }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const llamaPort = stub.address().port;
const port = 26000 + Math.floor(Math.random() * 2000);
const proc = spawn("python3", [app + "/server.py"], {
  cwd: app,
  env: { ...process.env, HOME: td + "/home",
    GHOST_IDE_PORT: String(port),
    GHOST_IDE_WORKSPACE: ws,
    GHOSTIDE_ECO_HOME: home + "/workspace",
    LLAMA_BASE: "http://127.0.0.1:" + llamaPort,
    PYTHONDONTWRITEBYTECODE: "1" },
  stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
proc.stdout.on("data", (d) => serverLog += d);
proc.stderr.on("data", (d) => serverLog += d);
const base = "http://127.0.0.1:" + port;
async function call(method, path, body) {
  const r = await fetch(base + path, { method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
try {
  let up = false;
  for (let i = 0; i < 75 && !up; i++) {
    try {
      const h = await call("GET", "/api/health");
      up = h.status === 200;
    } catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!up) throw new Error("server did not come up:\n" + serverLog);
  const health = await call("GET", "/api/health");
  ck("E2E server reports the desktop version", health.data.version === vjson.desktop.version);

  const td8 = await call("POST", "/api/mcp/tools", { server: "fx" });
  const tools = Object.fromEntries(
    (td8.data.tools || []).map((t) => [t.name, t]));
  ck("E2E tools listed with annotations and policy defaults",
     td8.status === 200 &&
     tools.echo.annotations.readOnlyHint === true &&
     tools.write_note.annotations.destructiveHint === true &&
     tools.echo.enabled === true &&
     tools.echo.approval === "ask");

  const okCall = await call("POST", "/api/mcp/call",
    { server: "fx", tool: "echo", arguments: { text: "hi" } });
  ck("E2E enabled tool call lands",
     okCall.status === 200 &&
     (okCall.data.text || "").includes("echo: hi"));

  await call("POST", "/api/mcp/policy",
    { server: "fx", tool: "write_note", enabled: false });
  const refused = await call("POST", "/api/mcp/call",
    { server: "fx", tool: "write_note", arguments: { text: "x" } });
  const logLines = existsSync(callLog)
    ? readFileSync(callLog, "utf8").trim().split("\n") : [];
  ck("E2E disabled tool refused server-side; fixture never saw it",
     refused.status === 400 &&
     (refused.data.error || "").includes("disabled") &&
     logLines.length === 1 && logLines[0] === "call echo");

  const pol = await call("POST", "/api/mcp/policy",
    { server: "fx", tool: "echo", approval: "allow" });
  ck("E2E approval mode persists in the policy view and on disk",
     pol.data.servers.fx.tools.echo.approval === "allow" &&
     existsSync(ws + "/.ghostide/mcp-policy.json"));

  const status = await call("GET", "/api/mcp/status");
  const fxRow = (status.data.servers || [])
    .find((r) => r.name === "fx");
  ck("E2E status: fx connected, labelled, tool count shown",
     fxRow && fxRow.status === "connected" &&
     fxRow.label === "Runs commands on this computer" &&
     fxRow.tools === 2);

  const cat = await call("GET", "/api/mcp/catalog");
  const fsEntry = (cat.data.catalog || [])
    .find((c) => c.id === "filesystem");
  ck("E2E catalog: filesystem entry with the workspace substituted",
     !!fsEntry && fsEntry.entry.args.includes(ws));

  const imp = await call("POST", "/api/mcp/config/import",
    { text: JSON.stringify({ mcpServers: {
        imp: { command: "npx", args: ["-y", "p"] },
        bad: { args: [] } } }) });
  ck("E2E paste-import: valid merged, invalid reported by name",
     imp.status === 200 &&
     JSON.stringify(imp.data.imported) === '["imp"]' &&
     !!imp.data.errors.bad);

  const SECRET = "Bearer harness-secret-9";
  const saved = await call("POST", "/api/mcp/config/server",
    { name: "web", entry: { url: "https://api.example/mcp",
        headers: { Authorization: SECRET } } });
  const cfgView = await call("GET", "/api/mcp/config");
  ck("E2E header credential stored but never echoed by any route",
     saved.status === 200 &&
     !JSON.stringify(saved.data).includes(SECRET) &&
     !JSON.stringify(cfgView.data).includes(SECRET) &&
     JSON.stringify(cfgView.data).includes("Authorization"));

  const badOauth = await call("POST", "/api/mcp/oauth/start",
    { server: "imp" });
  ck("E2E OAuth start on a non-OAuth server is a plain error",
     badOauth.status === 400 &&
     (badOauth.data.error || "").length > 0);
} catch (e) {
  ck("E2E completed without harness error (" + e.message + ")", false);
} finally {
  proc.kill("SIGTERM");
  stub.close();
}
console.log("DESKTOP-CYCLE4 (D8 MCP POLISH): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
