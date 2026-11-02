// Cycle 3 I20: one command runs the whole harness
// directory and prints a single summary. Each harness
// is a child process; ghconnect takes the web sources
// as arguments (its historical contract). A harness
// passes when its last line matches the house pass
// shapes ("... 0 failed" or "ALL PASS"). Exit code is
// nonzero when anything fails, so CI and release
// scripts can gate on it.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs")
  .sort();
let passed = 0;
const failed = [];
for (const f of files) {
  const args = [here + "/" + f];
  if (f === "ghconnect_harness.mjs")
    args.push(root + "/web/src/main.js",
              root + "/web/index.html");
  const r = spawnSync(process.execPath, args,
    { encoding: "utf8", timeout: 120000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const last = out.trim().split("\n").pop() || "";
  if (last.includes(" 0 failed") || last.includes("ALL PASS"))
    passed++;
  else
    failed.push(f + " -> " + (last || ("exit " + r.status)));
}
console.log("HARNESS SUMMARY: " + passed + "/" +
  files.length + " files pass");
for (const f of failed) console.log("FAILED: " + f);
process.exit(failed.length ? 1 : 0);
