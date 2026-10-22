// Roadmap ECO E6 proof (headless part): the pure state
// steps behind the Context lab's GhostConvert export -
// parseLosses turns the tool's LOSSES.md into the named
// loss list the UI renders per format, and convertState
// normalizes a convert response into per-format rows
// (artifacts + losses). Extracted from main.js between
// the @@E6@@ markers, the same pattern as E4/E5. The
// full click-through (real DOM, real fetch) is beyond
// this stub and stays with the device pass; wiring is
// asserted statically below.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const src = readFileSync(
  home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(
  home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@E6@@*/")[1]
  .split("/*@@E6-END@@*/")[0];
const { parseLosses, convertState } = new Function(
  "window", block + "; return { parseLosses, convertState };")({});

let passed = 0, failed = 0;
const ck = (name, cond) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  cond ? passed++ : failed++;
};

// --- parseLosses ---
const lossesMd = [
  "# Conversion losses: agents",
  "",
  "Source bundle: /x/.ghostide/slice",
  "Project: demo",
  "",
  "## Per-file sha256 hashes",
  "",
  "2 hash value(s) from the manifest are not carried.",
  "",
  "## Per-file token estimates",
  "",
  "Per-file counts for 2 file(s) are not carried;",
  "only the bundle totals appear.",
].join("\n");
const losses = parseLosses(lossesMd);
ck("parseLosses finds each named loss",
   losses.length === 2
   && losses[0].name === "Per-file sha256 hashes"
   && losses[1].name === "Per-file token estimates");
ck("parseLosses keeps the detail text",
   losses[0].detail.includes("2 hash value(s)")
   && losses[1].detail.includes("only the bundle totals"));
ck("parseLosses ignores the title and preamble",
   losses.every((l) => !l.name.startsWith("#")));
ck("parseLosses of empty input is empty",
   parseLosses("").length === 0
   && parseLosses(null).length === 0);

// --- convertState ---
const resp = {
  ok: true, target: "all", bundle: ".ghostide/slice",
  slice: { mode: "signatures", files: 4, tokens: 36 },
  verify: { code: 0, output: "[agents] OK" },
  outputs: [
    { target: "agents", dir: ".ghostide/convert/all/agents",
      artifacts: [
        { path: "AGENTS.md", content: "# AGENTS\n" },
        { path: "LOSSES.md", content: lossesMd }],
      losses: lossesMd,
      losses_names: ["Per-file sha256 hashes",
        "Per-file token estimates"] },
    { target: "cursor", dir: ".ghostide/convert/all/cursor",
      artifacts: [
        { path: ".cursor/rules/ghostconvert-src.mdc",
          content: "rule\n" },
        { path: "LOSSES.md", content: "" }],
      losses: "", losses_names: [] },
  ],
};
const st = convertState(resp);
ck("convertState carries target, bundle, slice, verify",
   !!st && st.target === "all"
   && st.bundle === ".ghostide/slice"
   && st.slice.files === 4 && st.verify.code === 0);
ck("convertState keeps both formats' artifacts",
   !!st && st.outputs.length === 2
   && st.outputs[0].artifacts[0].path === "AGENTS.md"
   && st.outputs[1].artifacts[0].path
     === ".cursor/rules/ghostconvert-src.mdc");
ck("convertState parses the losses list per format",
   !!st && st.outputs[0].lossesList.length === 2
   && st.outputs[1].lossesList.length === 0);
const namesOnly = convertState({
  ok: true, outputs: [{ target: "agents", dir: "d",
    artifacts: [], losses: "",
    losses_names: ["Mode reasons"] }] });
ck("convertState falls back to losses_names",
   !!namesOnly
   && namesOnly.outputs[0].lossesList.length === 1
   && namesOnly.outputs[0].lossesList[0].name
     === "Mode reasons");
ck("convertState rejects errors and empties",
   convertState({ error: "x" }) === null
   && convertState({ ok: true }) === null
   && convertState(null) === null);

// --- static wiring ---
ck("export controls exist in the Context lab",
   html.includes('id="ctxExportTarget"')
   && html.includes('id="ctxExportBtn"')
   && html.includes('id="ctxExportOut"'));
ck("export button has a handler",
   src.includes('$("ctxExportBtn").onclick'));
ck("convert endpoint is called",
   src.includes('"/api/eco/convert"'));
ck("target picker offers all five choices",
   ["agents", "cursor", "copilot", "generic", "all"]
     .every((t) => html.includes('value="' + t + '"')));
ck("slice mode + budget ride from the existing settings",
   /* v1.66: the budget now comes from the slice-budget
      setting via sliceBudget(), not the fixed constant */
   src.includes("sliceBudget()")
   && src.includes('$("ctxMode").value'));
ck("save uses the Blob download route",
   src.includes("downloadConverted")
   && src.includes("URL.createObjectURL(new Blob"));

console.log("\nE6 UI HARNESS: " + passed + " passed, "
  + failed + " failed");
process.exit(failed ? 1 : 0);
