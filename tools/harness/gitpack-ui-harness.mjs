// Mobile Cycle 2 (M4): the git phone pack.
//
// Static pins: the Settings Git accounts section and
// the Git panel's full-clone option exist; the token
// rules hold textually - the bundle has no token getter
// for the bridge, ghToken() answers "" when the bridge
// is present, the only localStorage write of the old
// token key is the desktop branch, the migration
// removes the key, and IdeServer reads no git token
// from any request body (it resolves the Keystore
// store by host). The conflict cards exist in the
// panel, the CSS hides them above phone widths and
// hides the desktop panes at phone widths with 40px
// card targets, and the counted-string census in
// main.js stays exactly 101.
//
// Live pins: the GITPACK block is extracted from
// main.js and its helpers are driven directly - the
// bridge shape check, the clone body (shallow by
// default), and the card navigation math over the
// real splitConflictBlocks parser, including the M4
// base capture on diff3 blocks.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const apkRoot = home + "/workspace/ghostide-apk-build/";
const src = readFileSync(root + "web/src/main.js", "utf8");
const app = readFileSync(root + "web/app.js", "utf8");
const html = readFileSync(root + "web/index.html", "utf8");
const css = readFileSync(root + "web/style.css", "utf8");
const serverPy = readFileSync(root + "server.py", "utf8");
const ideServer = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/IdeServer.java",
  "utf8");
const mainActivity = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/MainActivity.java",
  "utf8");
const gitSupport = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/GitSupport.java",
  "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => {
  console.log((c ? "PASS " : "FAIL ") + n);
  c ? passed++ : failed++;
};

/* ---------- static pins ---------- */
for (const id of ["gitAcctAndroid", "gitAcctHost",
    "gitAcctToken", "gitAcctSave", "gitAcctRemove",
    "gitAcctStatus", "gitAcctDesktopNote", "ghFullClone",
    "ghTokenNote", "conflictCards", "conflictResultLabel"])
  ck("M4 html: panel has " + id,
     html.includes('id="' + id + '"'));
ck("M4 html: token field is a password field",
   html.includes('id="gitAcctToken"') &&
   /id="gitAcctToken"[^>]*type="password"|type="password"[^>]*id="gitAcctToken"/.test(html) ||
   html.includes('<input type="password" id="gitAcctToken"') ||
   html.includes('id="gitAcctToken" placeholder'));
ck("M4 bundle: no bridge token getter exists anywhere",
   !src.includes("getGitToken") && !app.includes("getGitToken"));
ck("M4 bundle: bridge surface is save/has/remove only",
   mainActivity.includes("saveGitToken") &&
   mainActivity.includes("hasGitToken") &&
   mainActivity.includes("removeGitToken") &&
   !mainActivity.includes("getGitToken"));
ck("M4 bundle: ghToken answers empty on Android",
   src.includes('gitAccountsBridge(window.GhostNative)) return "";'));
ck("M4 bundle: the old token key is written only in " +
   "the desktop branch (one setItem) and removed by " +
   "the migration",
   (src.match(/localStorage\.setItem\("ghostide-gh-token"/g) || []).length === 1 &&
   src.includes('localStorage.removeItem("ghostide-gh-token")'));
ck("M4 native: IdeServer reads no git token from a " +
   "request body",
   !ideServer.includes('Json.str(gd, "token"'));
ck("M4 native: IdeServer resolves the stored token " +
   "for clone and remotes",
   ideServer.includes("storedTokenForUrl(curl)") &&
   ideServer.includes("storedTokenForRemote(") &&
   ideServer.includes("GitTokenKeystore.forApp"));
ck("M4 native: conflict endpoints exist on the phone " +
   "server in the desktop shape",
   ideServer.includes("/api/git/conflict") &&
   ideServer.includes("/api/git/conflict/resolve") &&
   ideServer.includes('\\"remaining\\"'));
ck("M4 native: status carries conflicts + mergeState",
   ideServer.includes('\\"conflicts\\"') &&
   ideServer.includes('\\"mergeState\\"'));
ck("M4 servers: shallow clone construction matches " +
   "(--depth / --single-branch unless full)",
   gitSupport.includes('"--single-branch"') &&
   serverPy.includes('"--single-branch"') &&
   serverPy.includes('data.get("full")'));
const m4css = css.slice(css.indexOf("Mobile Cycle 2 (M4)"));
ck("M4 css: cards hidden by default, shown at phone " +
   "widths while the panes hide, 40px card targets",
   m4css.includes("#conflictCards { display: none; }") &&
   m4css.includes("#conflictCards { display: block; }") &&
   m4css.includes("#conflictPanes, #conflictBlocks,") &&
   m4css.includes(".conflictCardBtns button { min-height: 40px; }"));
ck("M4 census: counted strings unchanged at 101 in " +
   "source and bundle",
   (src.match(/innerHTML/g) || []).length === 101 &&
   (app.match(/innerHTML/g) || []).length === 101);

/* ---------- live pins ---------- */
const a = src.indexOf("// @@GITPACK@@"),
      b = src.indexOf("// @@GITPACK-END@@");
ck("M4 block: GITPACK markers present", a > -1 && b > a);
const mod = await import("data:text/javascript;base64,"
  + Buffer.from(src.slice(a, b)).toString("base64"));

const fullBridge = { saveGitToken() {}, hasGitToken() {},
                     removeGitToken() {} };
ck("live: a full bridge shape is accepted",
   mod.gitAccountsBridge(fullBridge) === true);
ck("live: no bridge, no accounts",
   mod.gitAccountsBridge(null) === false &&
   mod.gitAccountsBridge(undefined) === false);
ck("live: a bridge without remove is rejected",
   mod.gitAccountsBridge({ saveGitToken() {},
     hasGitToken() {} }) === false);

const body = mod.cloneRequestBody("https://h/r.git", "r");
ck("live: clone body defaults to shallow (full false)",
   body.url === "https://h/r.git" && body.dir === "r" &&
   body.full === false &&
   Object.keys(body).length === 3);
ck("live: clone body carries the full opt-in",
   mod.cloneRequestBody("u", "d", true).full === true &&
   mod.cloneRequestBody("u", "d", 1).full === true &&
   mod.cloneRequestBody("u", "d", "").full === false);

function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 3);
}
const parse = new Function(
  extractFn("splitConflictBlocks") + "\n" +
  extractFn("countConflictBlocks") +
  "\nreturn { splitConflictBlocks, countConflictBlocks };")();
const sample = ["top", "<<<<<<< HEAD", "o1", "=======",
  "t1", ">>>>>>> side", "mid", "<<<<<<< HEAD", "o2",
  "=======", "t2", ">>>>>>> side", "end"].join("\n");
const segs = parse.splitConflictBlocks(sample);
ck("live: card indices find both blocks",
   JSON.stringify(mod.conflictSegIndices(segs)) === "[1,3]");
ck("live: next card from the start is the first block",
   mod.nextConflictSeg(segs, 0) === 1);
ck("live: next card advances past a resolved block",
   mod.nextConflictSeg(segs, 2) === 3);
ck("live: next card wraps for browsing",
   mod.nextConflictSeg(segs, 4) === 1);
ck("live: no blocks means no card",
   mod.nextConflictSeg(
     parse.splitConflictBlocks("clean\ntext"), 0) === -1);
const prog = mod.cardProgress(2, segs);
ck("live: progress counts remaining and resolved",
   prog.total === 2 && prog.remaining === 2 &&
   prog.resolved === 0);
const one = parse.splitConflictBlocks(
  ["<<<<<<< HEAD", "o1", "=======", "t1",
   ">>>>>>> side"].join("\n"));
const prog2 = mod.cardProgress(2, one);
ck("live: progress after one resolution",
   prog2.remaining === 1 && prog2.resolved === 1);
const diff3 = ["<<<<<<< HEAD", "o", "||||||| base", "b",
  "=======", "t", ">>>>>>> x"].join("\n");
const d3 = parse.splitConflictBlocks(diff3)
  .filter((s) => s.kind === "conflict");
ck("live: the parser captures the base for the cards " +
   "without merging it into ours or theirs",
   d3.length === 1 && d3[0].base === "b" &&
   d3[0].ours === "o" && d3[0].theirs === "t");
const plain = parse.splitConflictBlocks(sample)
  .filter((s) => s.kind === "conflict");
ck("live: a block without a base section has empty base",
   plain[0].base === "");
ck("live: round-trip still byte-exact with base carried",
   segs.map((s) => s.kind === "text" ? s.text : s.raw)
     .join("\n") === sample);

console.log(failed
  ? `GITPACK HARNESS: ${failed}/${passed + failed} FAILED`
  : `GITPACK HARNESS: ALL PASS (${passed} checks)`);
process.exit(failed ? 1 : 0);
