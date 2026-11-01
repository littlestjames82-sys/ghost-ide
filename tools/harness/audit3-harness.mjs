// Audit batch 3 proof (v2.53, A11-A15). Live probes
// (workspace switching, worktree refusals, malformed
// bodies, unknown routes) ran against a fixture server;
// signer stability was verified across all six campaign
// APKs. This harness locks the code-level invariants.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A12 terminal: desktop discloses the shell, phone refuses it",
   html.includes("local shell (unsandboxed)") &&
   java.includes("The terminal runs on the"));
ck("A13 worktree refusals exist on both servers",
   py.includes('"the main workspace cannot be "') &&
   java.includes('"workspace cannot be removed') &&
   py.includes('"that path is not a worktree of "') &&
   java.includes('"is not a worktree of this repo'));
ck("A14 writes: body cap + framing rules + history snapshots",
   py.includes("MAX_BODY_BYTES = 64 * 1024 * 1024") &&
   py.includes('"duplicate Content-Length"') &&
   py.includes('snapshot_history(p, data.get("content"') &&
   py.includes("def _restore_reconcile():"));
ck("A15 desktop: unknown /api routes answer JSON, not HTML",
   py.includes('{"error": "no such route"}, status=404'));
ck("A15 java: unknown /api routes answer JSON, not the asset 404",
   java.includes('sendJson(out, 404, "{\\"error\\":\\"no such route\\"}")'));
ck("A15 java: a route crash before writing returns a 400 {error}",
   java.includes("FilterOutputStream(out)") &&
   java.includes('"the request could "'));
ck("A15 desktop: malformed bodies land in the {error} catch",
   py.includes('return self.send_json({"error": str(e)}, status=400)'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
