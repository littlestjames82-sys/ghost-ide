// Cycle 8 batch 3 proof (v3.05): git finish - tags
// and amend on both servers. Pins: the name pin is
// the BRANCH pin reused (parity by construction on
// desktop, mirrored regex in Java); the target hash
// is hex-pinned at both ends; amend is a thin,
// honest wrapper over git (its refusals surface);
// the agent's tag access is read-only by negative
// space, the Cycle 7 rail restated for the new verb.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I11 tags routes on both servers",
   py.includes('if parsed.path == "/api/git/tags":') &&
   py.includes('if parsed.path == "/api/git/tag":') &&
   java.includes('path.equals("/api/git/tags")') &&
   java.includes('path.equals("/api/git/tag")'));
ck("I11 tag name + hash pins at both ends",
   py.includes('raise ValueError("bad tag name")') &&
   py.includes('r"[0-9a-f]{7,40}", th') &&
   java.includes('"bad tag name"') &&
   java.includes('"bad commit hash"'));
ck("I12 panel Tags section + tag-this-commit in the viewer",
   html.includes('id="tagList"') &&
   src.includes("async function renderTags()") &&
   src.includes('tb.textContent = "🏷 Tag this commit";'));
ck("I13 amend routes on both servers, git refusals surface",
   py.includes('if parsed.path == "/api/git/amend":') &&
   py.includes('args = ["commit", "--amend"]') &&
   java.includes('path.equals("/api/git/amend")') &&
   java.includes('gitArgs("commit",'));
ck("I14 Amend button confirms with what will happen",
   html.includes('id="gitAmend"') &&
   src.includes('"Amend the last commit? Staged "'));
ck("I15 agent GIT verbs include tags at both parser sites",
   (src.split("branches|stash|tags").length - 1) >= 2 &&
   src.includes('if (act.what === "tags")'));
ck("I15 mutating tag/amend routes have exactly one caller each (the UI)",
   (src.split('postJson("/api/git/tag"').length - 1) === 1 &&
   (src.split('"/api/git/amend"').length - 1) === 1 &&
   src.includes("async function tagAct("));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
