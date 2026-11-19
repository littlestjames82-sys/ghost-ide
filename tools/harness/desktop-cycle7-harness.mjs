// Desktop Cycle 3, D9 (v3.17.0 at build): git depth - hunk
// staging + the three-pane conflict editor.
// Static pins over the shipped sources, an extraction
// test that runs the client's REAL conflict-block
// parser (splitConflictBlocks / countConflictBlocks,
// lifted out of web/src/main.js and evaluated), then
// a full HTTP end-to-end against a real server
// subprocess over a real git repo: a two-hunk file
// staged one hunk at a time, the stale-selection
// refusal after the file moves, discard, and a real
// two-branch merge conflict resolved through the
// conflict endpoints and committed through the
// existing commit route.
import { readFileSync, mkdtempSync, mkdirSync,
  writeFileSync, copyFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
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
const appVer = (py.match(/APP_VERSION = "([^"]+)"/) || [])[1];
ck("D9 version: all trains agree on the shared version (M1 re-sync)",
   vjson.desktop && vjson.desktop.version === appVer &&
   py.includes('APP_VERSION = "' + appVer + '"') &&
   vjson.version === appVer &&
   vjson.latest === appVer &&
   vjson.android && vjson.android.version === appVer);
ck("D9 route census re-derived: 194 (190 + 4 git depth routes) (Mobile Cycle 3 S1: +3 desktop / +2 Java task-record routes) (Mobile Cycle 3 M10: +7 desktop supervision routes)",
   (py.match(/parsed\.path ==/g) || []).length === 204);
ck("D9 server: hunk endpoints and the apply discipline",
   py.includes('"/api/git/hunks"') &&
   py.includes('"/api/git/hunks/apply"') &&
   py.includes("def git_hunks(path, area):") &&
   py.includes("def git_apply_hunks(") &&
   py.includes("def _git_apply(") &&
   py.includes("input=patch") &&
   py.includes('"--cached"') && py.includes('"--reverse"'));
ck("D9 server: stale selections are refused, never applied blind",
   py.includes("the diff changed since you loaded it") &&
   py.includes('exp.get("headers") != ') &&
   py.includes('want_sel.get(str(i)) != hunks[i]["sha"]'));
ck("D9 server: conflict endpoints, stages and merge state",
   py.includes('"/api/git/conflict"') &&
   py.includes('"/api/git/conflict/resolve"') &&
   py.includes("def git_conflict(path):") &&
   py.includes("def git_conflict_resolve(path, content):") &&
   py.includes("def git_merge_state():") &&
   py.includes('["ls-files", "-u", "--", path]') &&
   py.includes('"conflicts": conflicts') &&
   py.includes('"mergeState": git_merge_state()'));
ck("D9 client: hunk controls in the diff view",
   src.includes("async function renderHunks(path)") &&
   src.includes("async function applyHunks(") &&
   src.includes('"/api/git/hunks/apply"') &&
   src.includes('"Stage hunk"') &&
   src.includes('"Unstage hunk"') &&
   src.includes('"Discard hunk"') &&
   bundle.includes("renderHunks"));
ck("D9 client: discard is confirmed in the exact words",
   src.includes('"Discard these changes? This "') &&
   src.includes('"cannot be undone from here"') &&
   src.includes('"Binary file: hunk staging "') &&
   src.includes('"does not apply. Use the file-level ' +
     'Stage "'));
ck("D9 client: conflict editor surface",
   html.includes('id="conflictPanel"') &&
   html.includes('id="gitMergeState"') &&
   html.includes('id="diffHunks"') &&
   src.includes("async function openConflict(path)") &&
   src.includes('"Use ours"') &&
   src.includes('"Use theirs"') &&
   src.includes('"Use both (ours first)"') &&
   src.includes('"Use both (theirs first)"') &&
   bundle.includes("openConflict"));
ck("D9 client: marker count, save block and ready-to-commit copy",
   src.includes('"Conflicts remaining: "') &&
   src.includes("Saving is blocked while conflict markers") &&
   src.includes("still in the result. Save anyway?") &&
   src.includes("all conflicts resolved, ready to commit") &&
   src.includes("git rebase --continue"));
ck("D9 client: no new innerHTML (census holds at 101)",
   (src.match(/innerHTML/g) || []).length === 101);

/* ---------- the client's real conflict parser ---------- */
function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return "";
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 3);
}
try {
  const parse = new Function(
    extractFn("splitConflictBlocks") + "\n" +
    extractFn("countConflictBlocks") +
    "\nreturn { splitConflictBlocks, countConflictBlocks };")();
  const sample = ["top", "<<<<<<< HEAD", "ours1", "=======",
    "theirs1", ">>>>>>> side", "mid", "<<<<<<< HEAD", "o2a",
    "o2b", "=======", "t2", ">>>>>>> side", "end"].join("\n");
  const segs = parse.splitConflictBlocks(sample);
  const blocks = segs.filter((s) => s.kind === "conflict");
  ck("parser: two blocks found, counter agrees",
     blocks.length === 2 &&
     parse.countConflictBlocks(sample) === 2);
  ck("parser: round-trip is byte-exact",
     segs.map((s) => s.kind === "text" ? s.text : s.raw)
       .join("\n") === sample);
  ck("parser: ours and theirs extracted per block",
     blocks[0].ours === "ours1" &&
     blocks[0].theirs === "theirs1" &&
     blocks[1].ours === "o2a\no2b" &&
     blocks[1].theirs === "t2");
  const rebuilt = segs.map((s, i) => {
    if (s.kind !== "conflict") return s.text;
    return s === blocks[0] ? s.ours : s.theirs;
  }).join("\n");
  ck("parser: resolving both blocks leaves no markers",
     parse.countConflictBlocks(rebuilt) === 0 &&
     rebuilt.includes("ours1") &&
     rebuilt.includes("t2") &&
     !rebuilt.includes("<<<<<<<"));
  const diff3 = ["<<<<<<< HEAD", "o", "||||||| base", "b",
    "=======", "t", ">>>>>>> x"].join("\n");
  const d3 = parse.splitConflictBlocks(diff3)
    .filter((s) => s.kind === "conflict");
  ck("parser: a diff3 base section is skipped, not merged in",
     d3.length === 1 && d3[0].ours === "o" &&
     d3[0].theirs === "t");
  ck("parser: an unterminated block stays plain text",
     parse.countConflictBlocks(
       "a\n<<<<<<< HEAD\nx") === 0);
} catch (e) {
  ck("parser extraction failed: " + e.message, false);
}

/* ---------- HTTP end-to-end over a real repo ---------- */
const td = mkdtempSync(tmpdir() + "/ghostide-d9-e2e-");
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
const git = (args, ok = true) => {
  try {
    return execFileSync("git", args,
      { cwd: ws, encoding: "utf8" });
  } catch (e) {
    if (ok) throw e;
    return (e.stdout || "") + (e.stderr || "");
  }
};
git(["init", "-q", "-b", "main", "."]);
git(["config", "user.email", "t@t.t"]);
git(["config", "user.name", "T"]);
const lines = [];
for (let i = 1; i <= 30; i++)
  lines.push("line " + String(i).padStart(2, "0"));
writeFileSync(ws + "/f.txt", lines.join("\n") + "\n");
git(["add", "f.txt"]);
git(["commit", "-qm", "init"]);
lines[2] = "CHANGED A";
lines[25] = "CHANGED B";
writeFileSync(ws + "/f.txt", lines.join("\n") + "\n");

const port = 26000 + Math.floor(Math.random() * 2000);
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
  ck("E2E server reports the shared version",
     health.data.version === appVer);

  const h = (await call("GET",
    "/api/git/hunks?path=f.txt&area=worktree")).data;
  ck("E2E hunks: two unstaged hunks, not binary",
     h.hunks.length === 2 && h.binary === false);
  const exp = (hh, idxs) => ({
    headers: hh.headers,
    selected: Object.fromEntries(
      idxs.map((i) => [i, hh.hunks[i].sha])) });
  const st1 = await call("POST", "/api/git/hunks/apply", {
    path: "f.txt", area: "worktree", action: "stage",
    hunks: [0], expect: exp(h, [0]) });
  const cached = git(["diff", "--cached"]);
  const wt = git(["diff"]);
  ck("E2E stage one hunk: the index holds exactly that hunk",
     st1.data.ok === true &&
     cached.includes("CHANGED A") &&
     !cached.includes("CHANGED B") &&
     wt.includes("CHANGED B") &&
     !wt.includes("CHANGED A"));

  const h2 = (await call("GET",
    "/api/git/hunks?path=f.txt&area=worktree")).data;
  writeFileSync(ws + "/f.txt",
    readFileSync(ws + "/f.txt", "utf8")
      .replace("line 10", "line TEN"));
  const st2 = await call("POST", "/api/git/hunks/apply", {
    path: "f.txt", area: "worktree", action: "stage",
    hunks: [0], expect: exp(h2, [0]) });
  ck("E2E stale selection: refused, nothing more staged",
     typeof st2.data.error === "string" &&
     st2.data.error.includes("diff changed") &&
     !git(["diff", "--cached"]).includes("line TEN"));

  const h3 = (await call("GET",
    "/api/git/hunks?path=f.txt&area=worktree")).data;
  const idxB = h3.hunks.findIndex(
    (x) => x.text.includes("CHANGED B"));
  const st3 = await call("POST", "/api/git/hunks/apply", {
    path: "f.txt", area: "worktree", action: "discard",
    hunks: [idxB], expect: exp(h3, [idxB]) });
  const body = readFileSync(ws + "/f.txt", "utf8");
  ck("E2E discard: exactly the chosen hunk's change is gone",
     st3.data.ok === true &&
     !body.includes("CHANGED B") &&
     body.includes("CHANGED A") &&
     body.includes("line 26"));

  /* A real merge conflict, resolved end to end. */
  git(["checkout", "-q", "--", "f.txt"]);
  git(["reset", "-q", "--hard", "HEAD"]);
  writeFileSync(ws + "/c.txt", "alpha\nbeta\ngamma\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "feature"]);
  writeFileSync(ws + "/c.txt", "alpha\nbeta FEATURE\ngamma\n");
  git(["commit", "-qam", "feature"]);
  git(["checkout", "-q", "main"]);
  writeFileSync(ws + "/c.txt", "alpha\nbeta MAIN\ngamma\n");
  git(["commit", "-qam", "main"]);
  git(["merge", "feature"], false);
  const status1 = (await call("GET", "/api/git/status")).data;
  ck("E2E status: conflict listed, merge state reported",
     JSON.stringify(status1.conflicts) === '["c.txt"]' &&
     status1.mergeState === "merge");
  const conf = (await call("GET",
    "/api/git/conflict?path=c.txt")).data;
  ck("E2E conflict: base, ours, theirs and the working file",
     JSON.stringify(conf.stages) === "[1,2,3]" &&
     conf.base === "alpha\nbeta\ngamma\n" &&
     conf.ours === "alpha\nbeta MAIN\ngamma\n" &&
     conf.theirs === "alpha\nbeta FEATURE\ngamma\n" &&
     conf.working.includes("<<<<<<<"));
  const resolved = conf.working.replace(
    "<<<<<<< HEAD\nbeta MAIN\n=======\n" +
    "beta FEATURE\n>>>>>>> feature", "beta FEATURE");
  const rs = await call("POST", "/api/git/conflict/resolve",
    { path: "c.txt", content: resolved });
  const status2 = (await call("GET", "/api/git/status")).data;
  ck("E2E resolve: staged, none remain, merge still open",
     rs.data.ok === true && rs.data.remaining === 0 &&
     status2.conflicts.length === 0 &&
     status2.mergeState === "merge");
  const cm = await call("POST", "/api/git/commit",
    { message: "merge feature" });
  const status3 = (await call("GET", "/api/git/status")).data;
  const parents = git(["cat-file", "-p", "HEAD"])
    .split("\n").filter((l) => l.startsWith("parent ")).length;
  ck("E2E commit: the merge lands with two parents, tree clean",
     cm.data.ok === true && parents === 2 &&
     status3.mergeState === null &&
     status3.changes.length === 0);
} catch (e) {
  ck("E2E exception: " + e.message, false);
} finally {
  proc.kill();
}
console.log("DESKTOP-CYCLE7 (D9 GIT DEPTH): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
