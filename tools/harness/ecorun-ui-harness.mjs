// Track B proof (v2.43): the Ecosystem panel offers the
// generic tool runner for the wired tools, file tools ask
// for a workspace path, and runs go to /api/eco/toolrun.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@ECORUN@@*/"), b = src.indexOf("/*@@ECORUN-END@@*/");
ck("ECORUN block markers present", a >= 0 && b > a);
const block = src.slice(a, b);
for (const t of ["ghostenv", "ghostlogs", "ghostdata",
    "ghostschema", "ghostledger", "ghostmcpdoctor",
    "ghostconsole", "ghostreplay", "ghostexposure"])
  ck("runner offered for " + t, block.includes(t + ":"));
ck("file tools are marked as path tools",
   block.includes('ghostlogs: { path: true') &&
   block.includes('ghostdata: { path: true') &&
   block.includes('ghostschema: { path: true'));
ck("workspace tools need no path",
   block.includes('ghostenv: { path: false }') &&
   block.includes('ghostconsole: { path: false }'));
ck("panel runs through /api/eco/toolrun",
   src.includes('postJson("/api/eco/toolrun"'));
ck("file tools prompt with the open file as default",
   src.includes('currentFile || ""') && src.includes("tr.hint"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
