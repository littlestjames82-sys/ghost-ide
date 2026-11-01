// Git proof + evidence contract (v2.44, E7/E8/E9): the Git
// panel's Verdict and Scope buttons run GhostReview and
// GhostScope through both servers, and the verify report
// carries the GhostVerify contract (executed / claimed /
// gaps) instead of a bare pass.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const srv = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("Git panel has Verdict and Scope buttons",
   html.includes('id="gitGhostReview"') &&
   html.includes('id="gitGhostScope"'));
ck("buttons call the proof routes and render into gitLog",
   src.includes('gitProofRun("/api/git/review"') &&
   src.includes('gitProofRun("/api/git/scope"') &&
   src.includes('$("gitLog").textContent = d.error ||'));
ck("desktop review runs the tool itself",
   srv.includes('"ghostreview"') &&
   srv.includes('["review", str(ws), "-o", str(out_dir), "--json"]'));
ck("desktop scope feeds the working-tree diff to the tool",
   srv.includes('"ghostscope"') &&
   srv.includes('"pack", str(ws), "-o", str(out_dir),') &&
   srv.includes('git_out(["diff", "HEAD"])'));
ck("empty diff is a plain refusal, not an empty pack",
   srv.includes("no changes against HEAD to scope"));
ck("verify report carries the evidence contract",
   srv.includes("## Evidence contract (GhostVerify)") &&
   srv.includes('"contract": {"executed": contract_executed,'));
ck("contract separates executed, claimed and gaps",
   srv.includes("contract_claimed") && srv.includes("contract_gaps") &&
   srv.includes("Claimed, not executed:"));
ck("gaps name the real limits (cap, unchecked types, no tests)",
   srv.includes("pipeline caps at 100 files per run") &&
   srv.includes("were counted, not verified") &&
   srv.includes("No tests exist in this workspace"));
ck("check counter tracks seen/skipped/capped for the contract",
   srv.includes('"skippedType": skipped_type') &&
   srv.includes('"capped": capped'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
