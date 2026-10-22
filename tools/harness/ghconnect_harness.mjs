// GHCONNECT block harness (v2.08).
import { readFileSync } from "fs";
const src = readFileSync(process.argv[2], "utf8");
const a = src.indexOf("// @@GHCONNECT@@"), b = src.indexOf("// @@GHCONNECT-END@@");
if (a < 0 || b < 0) { console.error("HARNESS FAIL: markers"); process.exit(1); }
let fails = 0, total = 0;
const ok = (c, l) => { total++; if (!c) { fails++; console.log("FAIL:", l); } };
const wire = readFileSync(process.argv[3], "utf8");
ok(wire.includes('id="ghToken"'), "token input in panel");
ok(wire.includes('id="ghRemoteUrl"'), "remote url input in panel");
for (const id of ["ghSaveRemote", "ghClone", "ghFetch",
                  "ghPull", "ghPush", "ghRemoteInfo", "ghOut"])
  ok(wire.includes('id="' + id + '"'), "panel has " + id);
const mod = await import("data:text/javascript;base64,"
  + Buffer.from(src.slice(a, b)).toString("base64"));
ok(mod.repoNameFromUrl("https://github.com/you/repo.git") === "repo", "name from https url");
ok(mod.repoNameFromUrl("https://github.com/you/repo") === "repo", "name without .git");
ok(mod.repoNameFromUrl("git@github.com:you/my-app.git") === "my-app", "name from ssh url");
ok(mod.repoNameFromUrl("/tmp/ghtest/remote.git") === "remote", "name from local path");
ok(mod.repoNameFromUrl("") === "", "empty url gives empty name");
ok(mod.repoNameFromUrl("https://github.com/you/repo.git/") === "repo", "trailing slash trimmed");
ok(mod.validRemoteUrl("https://github.com/you/repo.git") === true, "https url valid");
ok(mod.validRemoteUrl("git@github.com:you/repo.git") === true, "ssh url valid");
ok(mod.validRemoteUrl("") === false, "empty url invalid");
ok(mod.validRemoteUrl("-upload-pack=x") === false, "option injection invalid");
console.log(fails ? `GHCONNECT HARNESS: ${fails}/${total} FAILED`
  : `GHCONNECT HARNESS: ALL PASS (${total} checks)`);
process.exit(fails ? 1 : 0);
