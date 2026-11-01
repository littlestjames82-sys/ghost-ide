// REA bridge + GhostRE panel proof (v2.42): the panel is
// wired to both engines, the REA side goes through the
// bridge allowlist endpoint, and GhostRE is the default
// (it is the engine that exists on every build).
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const srv = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@REA@@*/"), b = src.indexOf("/*@@REA-END@@*/");
ck("REA block markers present", a >= 0 && b > a);
const block = src.slice(a, b);
ck("panel loads REA status from the bridge",
   block.includes('fetch("/api/rea/status")'));
ck("REA runs go through the allowlist endpoint",
   block.includes('postJson("/api/rea/run"'));
ck("GhostRE is a panel engine",
   block.includes('postJson("/api/ghostre/run"'));
ck("panel names the saved Evidence file",
   block.includes("evidenceFile"));
ck("tools panel has the Reverse button",
   html.includes('id="toolReverse"'));
ck("reverse panel has path, tool select and output",
   html.includes('id="reaPath"') && html.includes('id="reaTool"') &&
   html.includes('id="reaOut"'));
ck("GhostRE is the default tool in the select",
   html.includes('<option value="ghostre">'));
ck("desktop server has the REA status + run routes",
   srv.includes('"/api/rea/status"') && srv.includes('"/api/rea/run"'));
ck("desktop server allowlist refuses live capture commands",
   srv.includes("REA_COMMANDS") && !srv.includes('"capture-process"') &&
   !srv.includes('"instrument-with-frida"'));
ck("desktop server saves Evidence under .ghostide/rea",
   srv.includes('".ghostide" / "rea"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
