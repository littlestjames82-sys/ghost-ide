// Desktop Cycle 3, D6 (v3.16.0): model store UX.
// Static pins over the shipped sources, then a full HTTP
// end-to-end against a real server subprocess: the store
// listing carries the catalog pins with no drift, a stub
// GGUF (header + padding; NOT a runnable model, and the
// loader is never asked to run it) imports from a local
// path, appears in the store, is accepted by the switch
// path as the active model (picker data proves it), a
// non-GGUF file is refused with the reason, and delete
// removes file + registry entry and resets the picker.
import { readFileSync, mkdtempSync, mkdirSync,
  writeFileSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const py = readFileSync(root + "server.py", "utf8");
const src = readFileSync(root + "web/src/main.js", "utf8");
const bundle = readFileSync(root + "web/app.js", "utf8");
const html = readFileSync(root + "web/index.html", "utf8");
const vjson = JSON.parse(readFileSync(root + "VERSION.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

/* ---------- static pins ---------- */
ck("D6 version: desktop train agreement (3.16.0 at D6), phone train re-synced at M1",
   vjson.desktop && vjson.desktop.version !== "3.10.1" &&
   py.includes('APP_VERSION = "' + vjson.desktop.version + '"') &&
   vjson.version === vjson.desktop.version &&
   vjson.latest === vjson.desktop.version &&
   vjson.android && vjson.android.version === vjson.desktop.version);
ck("D6 route census re-derived: 194 (190 + 4 git depth routes in D9) (Mobile Cycle 3 S1: +3 desktop / +2 Java task-record routes) (Mobile Cycle 3 M10: +7 desktop supervision routes)",
   (py.match(/parsed\.path ==/g) || []).length === 204);
ck("D6 server: catalog pins for the full Qwen2.5-Coder family",
   py.includes('"bytes": 491400064') &&
   py.includes("1d9614638d18024d0fbb36575a15f1302a3adf044") &&
   py.includes('"bytes": 1117320768') &&
   py.includes("cc324af070c2ecbfd324a30884d2f951a7ff756ab") &&
   py.includes('"bytes": 2104932800') &&
   py.includes("724fb256bec1ff062b2f65e4569e871ad2e95ab2a3") &&
   py.includes('"bytes": 4683073536'));
ck("D6 server: store joins catalog, embedding and imported models",
   py.includes("def models_store():") &&
   py.includes('IMPORTED_MODELS_FILE = DATA_DIR / "imported-models.json"') &&
   py.includes('"role": "embedding"') &&
   py.includes('"kind": "imported"'));
ck("D6 server: machine fit is guidance with an unknown case",
   py.includes("def _machine_ram_bytes():") &&
   py.includes("def _fit_class(ram_gb, total_bytes):") &&
   py.includes('return "unknown"') &&
   py.includes("the number is never"));
ck("D6 server: pause keeps the part file, cancel deletes it",
   py.includes("DL_CONTROL = {\"pause\": False, \"cancel\": False}") &&
   py.includes("raise _DlStop(\"pause\")") &&
   py.includes("raise _DlStop(\"cancel\")") &&
   py.includes('DL_STATE.update({"state": "paused"})'));
ck("D6 server: import checks the GGUF header and records the hash",
   py.includes('GGUF_MAGIC = b"GGUF"') &&
   py.includes("def _gguf_ok(path):") &&
   py.includes("def _import_local(path_str, name=None):") &&
   py.includes("def _import_url_worker(url, fname, disp):"));
ck("D6 server: delete guard for the loaded active model",
   py.includes('"code": "model-loaded"') &&
   py.includes("def _delete_model(mid, stop=False):") &&
   py.includes("started outside GhostIDE"));
ck("D6 server: import and delete are host-only like MCP settings",
   py.includes("def _models_host_only(handler):") &&
   py.includes('"/api/models/import"') &&
   py.includes('"/api/models/delete"'));
ck("D6 client: store entry points in Tools and Settings",
   html.includes('id="toolModels"') &&
   html.includes('id="modelStoreBtn"') &&
   src.includes("async function openModelsPanel()"));
ck("D6 client: cards, fit guidance and honest import labelling",
   src.includes("Recommended for this machine") &&
   src.includes("Fits this machine") &&
   src.includes("Too big for this machine") &&
   src.includes("Imported by you") &&
   src.includes("not verified") &&
   bundle.includes("openModelsPanel"));
ck("D6 client: download controls with the honest pause label",
   src.includes("The partial file is kept; Download resumes") &&
   src.includes('"/api/models/pause"') &&
   src.includes('"/api/models/cancel"') &&
   src.includes('"/api/models/delete"'));
ck("D6 client: no new innerHTML (census holds at 101)",
   (src.match(/innerHTML/g) || []).length === 101);

/* ---------- HTTP end-to-end ---------- */
const td = mkdtempSync(tmpdir() + "/ghostide-d6-e2e-");
const app = td + "/app";
mkdirSync(app + "/web", { recursive: true });
mkdirSync(app + "/playground", { recursive: true });
for (const f of ["server.py", "ghost_paths.py", "updater.py",
    "workspace_trust.py", "lsp_manager.py", "embed_index.py",
    "debug_bridge.py", "VERSION.json"])
  copyFileSync(root + f, app + "/" + f);
writeFileSync(app + "/web/index.html", "<html></html>");
writeFileSync(app + "/playground/hello.txt", "seeded");
const ws = td + "/ws";
mkdirSync(ws, { recursive: true });
const models = td + "/models";
mkdirSync(models, { recursive: true });
const port = 24000 + Math.floor(Math.random() * 2000);
const proc = spawn("python3", [app + "/server.py"], {
  cwd: app,
  env: { ...process.env, HOME: td + "/home",
    GHOST_IDE_PORT: String(port),
    GHOST_IDE_WORKSPACE: ws,
    GHOST_IDE_MODELS: models,
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
  ck("E2E server reports the desktop train version",
     health.data.version === vjson.desktop.version);

  const st = await call("GET", "/api/models/store");
  const cards = {};
  for (const c of st.data.models || []) cards[c.id] = c;
  ck("E2E store: family cards carry the pinned sizes (no drift)",
     st.status === 200 &&
     cards["0.5b"] && cards["0.5b"].bytes === 491400064 &&
     cards["1.5b"] && cards["1.5b"].bytes === 1117320768 &&
     cards["3b"] && cards["3b"].bytes === 2104932800 &&
     cards["7b"] && cards["7b"].bytes === 4683073536);
  ck("E2E store: embedding card and machine/disk blocks",
     cards["embed"] && cards["embed"].role === "embedding" &&
     typeof st.data.machine.ramBytes !== "undefined" &&
     st.data.disk.modelsBytes === 0 &&
     Array.isArray(st.data.models));
  const recs = (st.data.models || []).filter((c) => c.recommended);
  ck("E2E store: at most one Recommended badge, on a fitting chat model",
     recs.length <= 1 &&
     (recs.length === 0 || (recs[0].role === "chat" && recs[0].fit === "fits")));

  const stub = td + "/stub.gguf";
  writeFileSync(stub, Buffer.concat(
    [Buffer.from("GGUF"), Buffer.alloc(4096, 0x73)]));
  const imp = await call("POST", "/api/models/import",
    { path: stub });
  ck("E2E import: stub GGUF imports and registers",
     imp.status === 200 && imp.data.ok === true &&
     typeof imp.data.model.id === "string" &&
     imp.data.model.sha256.length === 64);
  const impId = imp.data.model.id;
  const st2 = await call("GET", "/api/models/store");
  const icard = (st2.data.models || []).find((c) => c.id === impId);
  ck("E2E import: card is labelled imported and unverified",
     !!icard && icard.kind === "imported" &&
     icard.verified === false && icard.installed === true);

  const act = await call("POST", "/api/models/active",
    { id: impId });
  const info = await call("GET", "/api/model/info");
  ck("E2E set active: switch path accepts it, picker data shows it",
     act.data.ok === true &&
     info.data.modelPath === models + "/stub.gguf" &&
     info.data.exists === true);

  const bad = td + "/bad.gguf";
  writeFileSync(bad, "plain text, not a model");
  const imp2 = await call("POST", "/api/models/import",
    { path: bad });
  const st3 = await call("GET", "/api/models/store");
  ck("E2E import: a non-GGUF file is refused and registers nothing",
     typeof imp2.data.error === "string" &&
     imp2.data.error.includes("GGUF") &&
     (st3.data.models || []).filter(
       (c) => c.kind === "imported").length === 1);

  const del = await call("POST", "/api/models/delete",
    { id: impId });
  const st4 = await call("GET", "/api/models/store");
  ck("E2E delete: file and registry entry go, picker resets",
     del.data.ok === true &&
     (st4.data.models || []).filter(
       (c) => c.kind === "imported").length === 0 &&
     st4.data.active.id === null);
} catch (e) {
  ck("E2E exception: " + e.message, false);
} finally {
  proc.kill();
}
console.log("DESKTOP-CYCLE6 (D6 MODEL STORE): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
