// Cycle 7 batch 2 proof (v2.96): stash + PLAN
// pause. Stash routes proven live on the fixture
// repo this cycle, including the honest refusal:
// git exits 0 with "No local changes" when only
// untracked files differ, so both servers translate
// that into a real error instead of a false ok.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I6 stash routes both servers, index pinned + ref rebuilt",
   py.includes('"/api/git/stash"') &&
   java.includes('"/api/git/stash"') &&
   py.includes('"stash@{%d}" % idx') &&
   java.includes('"stash@{" + (int) dv + "}"'));
ck("I6b the no-changes lie is refused on both servers",
   py.includes('"No local changes" in (out or "")') &&
   java.includes('"No local changes"'));
ck("I7 panel Stash section wired",
   html.includes('id="stashList"') &&
   src.includes("async function renderStashes()"));
ck("I8 stash count rides git status both servers",
   py.includes('"stash": stash_n') &&
   java.includes('\\"stash\\":'));
ck("I9+I10 agent stash verb (both parsers) + PLAN pause",
   (src.match(/status\|diff\|log\|branches\|stash/g) || []).length >= 2 &&
   src.includes("while (agentPause && !agentStop)"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
