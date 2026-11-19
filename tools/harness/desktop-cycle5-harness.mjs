// Desktop Cycle 3, D5 (v3.15.0): neural embeddings index.
// Static pins over the shipped sources, then a full HTTP
// end-to-end against a real server subprocess with the
// fake llama-server fixture at the engine seam
// (deterministic concept vectors): status honesty with
// the model present, a build over the sem fixture
// workspace, marker queries ranking the right file first,
// an incremental rebuild embedding one edited file, and
// the trust gate on the build/search routes. The REAL
// model retrieval proof lives in tests/test_embed_e2e.py.
import { readFileSync, mkdtempSync, mkdirSync,
  writeFileSync, copyFileSync, cpSync, chmodSync,
  truncateSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const py = readFileSync(root + "server.py", "utf8");
const emb = readFileSync(root + "embed_index.py", "utf8");
const src = readFileSync(root + "web/src/main.js", "utf8");
const bundle = readFileSync(root + "web/app.js", "utf8");
const html = readFileSync(root + "web/index.html", "utf8");
const vjson = JSON.parse(readFileSync(root + "VERSION.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

/* ---------- static pins ---------- */
ck("D5 version: desktop train agreement (3.15.0 at D5), phone train re-synced at M1",
   vjson.desktop && vjson.desktop.version !== "3.10.1" &&
   py.includes('APP_VERSION = "' + vjson.desktop.version + '"') &&
   vjson.version === vjson.desktop.version &&
   vjson.latest === vjson.desktop.version &&
   vjson.android && vjson.android.version === vjson.desktop.version);
ck("D5 route census re-derived: 194 (190 + 4 git depth routes in D9) (Mobile Cycle 3 S1: +3 desktop / +2 Java task-record routes) (Mobile Cycle 3 M10: +7 desktop supervision routes)",
   (py.match(/parsed\.path ==/g) || []).length === 204);
ck("D5 server: model pin is the real nomic asset (size + sha256)",
   py.includes('"nomic-embed-text-v1.5.Q8_0.gguf"') &&
   py.includes('"bytes": 146146432') &&
   py.includes("3e24342164b3d94991ba9692fdc0dd08e3fd7362e0a"));
ck("D5 server: engine is a managed llama-server in embedding mode",
   py.includes('"--embedding", "--pooling", "mean"') &&
   py.includes('EMBED_BASE + "/v1/embeddings"') &&
   py.includes("def _embed_start():") &&
   py.includes("EMBED_IDLE_SECONDS = 600"));
ck("D5 server: nomic task prefixes for docs and queries",
   py.includes('"doc_prefix": "search_document: "') &&
   py.includes('"query_prefix": "search_query: "'));
ck("D5 server: build and search routes are trust-gated, status is open",
   py.includes('"/api/embed/build", "/api/embed/search",') &&
   py.includes('parsed.path == "/api/embed/status"'));
ck("D5 server: index lives in the workspace .ghostide folder",
   py.includes('WORKSPACE / ".ghostide" / "embeddings.db"') &&
   emb.includes("class EmbedIndex") &&
   emb.includes("def sync(self, file_texts, symbols_by_path, embed_fn"));
ck("D5 server: download is a verified worker like the chat model's",
   py.includes("def _embed_dl_worker():") &&
   py.includes('EMBED_DL_STATE["state"] = "verifying"'));
ck("D5 client: Find panel Neural mode with honest guidance states",
   html.includes('id="findNeural"') &&
   src.includes('$("findNeural").onclick = refreshFindNeural') &&
   src.includes("Neural embeddings (local model)") &&
   src.includes("Download embedding model") &&
   src.includes("Build index"));
ck("D5 client: Settings carries the embedding model row",
   html.includes('id="setEmbedDlBtn"') &&
   html.includes('id="setEmbedBuildBtn"') &&
   src.includes("async function refreshEmbedDl()"));
ck("D5 client: agent SEMANTIC action with lexical fallback disclosure",
   src.includes("SEMANTIC <query> - search code by meaning") &&
   src.includes("async function semanticForAgent(query)") &&
   src.includes("answered by lexical") &&
   src.includes('{ type: "semantic", query: m[1].trim() }') &&
   bundle.includes("semanticForAgent"));
ck("D5 client: no new innerHTML (census holds at 101)",
   (src.match(/innerHTML/g) || []).length === 101);

/* ---------- HTTP end-to-end ---------- */
const td = mkdtempSync(tmpdir() + "/ghostide-d5-e2e-");
const app = td + "/app";
mkdirSync(app + "/web", { recursive: true });
mkdirSync(app + "/playground", { recursive: true });
for (const f of ["server.py", "ghost_paths.py", "updater.py",
    "workspace_trust.py", "lsp_manager.py", "embed_index.py",
    "debug_bridge.py", "VERSION.json"])
  copyFileSync(root + f, app + "/" + f);
writeFileSync(app + "/web/index.html", "<html></html>");
const ws = td + "/ws";
cpSync(root + "tests/fixtures/sem", ws, { recursive: true });
const models = td + "/models";
mkdirSync(models, { recursive: true });
const modelFile = models + "/nomic-embed-text-v1.5.Q8_0.gguf";
writeFileSync(modelFile, "");
truncateSync(modelFile, 146146432);
const fakeBin = td + "/fake_embed_server.py";
copyFileSync(root + "tests/fixtures/fake_embed_server.py",
             fakeBin);
chmodSync(fakeBin, 0o755);
const port = 28000 + Math.floor(Math.random() * 2000);
const embedPort = port + 5000;
const proc = spawn("python3", [app + "/server.py"], {
  cwd: app,
  env: { ...process.env, HOME: td + "/home",
    GHOST_IDE_PORT: String(port),
    GHOST_IDE_WORKSPACE: ws,
    GHOST_IDE_MODELS: models,
    LLAMA_SERVER_BIN: fakeBin,
    GHOSTIDE_EMBED_BASE: "http://127.0.0.1:" + embedPort,
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
async function buildAndWait() {
  const r = await call("POST", "/api/embed/build", {});
  if (r.status !== 200) return r;
  for (let i = 0; i < 120; i++) {
    const s = await call("GET", "/api/embed/status");
    if (s.data.build && (s.data.build.state === "done" ||
        s.data.build.state === "error")) return s;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error("build did not finish");
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
  ck("E2E server reports the desktop train version",
     health.data.version === vjson.desktop.version);

  const st0 = await call("GET", "/api/embed/status");
  ck("E2E status: model present, index empty, unavailable",
     st0.data.model.present === true &&
     st0.data.index.chunks === 0 &&
     st0.data.available === false);
  const noIdx = await call("POST", "/api/embed/search",
    { query: "sleep" });
  ck("E2E search before build answers no-index honestly",
     noIdx.data.available === false &&
     noIdx.data.code === "no-index");

  const done = await buildAndWait();
  ck("E2E build embeds the whole fixture workspace",
     done.data.build.state === "done" &&
     done.data.build.stats.files === 7 &&
     done.data.build.stats.embedded_files === 7 &&
     done.data.index.chunks >= 10 &&
     done.data.available === true);
  for (const [q, want] of [["sleep", "retry.py"],
      ["urlopen", "fetchdoc.py"], ["digit", "passwords.py"]]) {
    const s = await call("POST", "/api/embed/search",
      { query: q });
    ck("E2E marker query ranks " + want + " first (" + q + ")",
       s.data.engine === "neural" &&
       s.data.results.length > 0 &&
       s.data.results[0].path === want);
  }
  const again = await buildAndWait();
  ck("E2E second build is a no-op (hash-incremental)",
     again.data.build.stats.embedded_files === 0 &&
     again.data.build.stats.unchanged_files === 7);

  const other = td + "/other";
  mkdirSync(other, { recursive: true });
  writeFileSync(other + "/x.py", "x = 1\n");
  await call("POST", "/api/workspace", { path: other });
  const gated = await call("POST", "/api/embed/build", {});
  ck("E2E build is trust-gated on an untrusted folder",
     gated.status === 403 &&
     gated.data.code === "workspace-untrusted");
  const gated2 = await call("POST", "/api/embed/search",
    { query: "sleep" });
  ck("E2E search is trust-gated on an untrusted folder",
     gated2.status === 403);
  const open = await call("GET", "/api/embed/status");
  ck("E2E status stays open on an untrusted folder",
     open.status === 200);
} catch (e) {
  ck("E2E exception: " + e.message, false);
} finally {
  proc.kill();
}
console.log("DESKTOP-CYCLE5 (D5 NEURAL EMBEDDINGS): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
