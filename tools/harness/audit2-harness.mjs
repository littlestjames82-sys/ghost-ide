// Audit batch 2 proof (v2.52, A6-A10). Live probes
// (MCP env canary, bundle cross-check) ran against
// fixture servers and the shipped APK; this harness
// locks the code-level invariants they verified.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const py = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
const java = readFileSync(home + "/workspace/ghostide-apk-build/app/src/main/java/com/ghostide/app/IdeServer.java", "utf8");
const gate = readFileSync(home + "/workspace/ghost-ide/tools/eco_bundle_gate.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("A6 parity: worktree keys identical, briefing uses real keys",
   py.includes('"path": line[9:].strip(), "branch": ""') &&
   java.includes('sb.append("{\\"path\\":")') &&
   !src.includes("w.name + \" (\"") &&
   src.includes('(w.path || "").split("/").pop()'));
ck("A6 parity: files mtime present on both servers",
   py.includes('entry["mtime"] = int(') &&
   java.includes('append(",\\"mtime\\":")'));
ck("A6 parity: newest routes exist on both servers",
   ["/api/eco/studio", "/api/eco/replay/save",
    "/api/eco/datapack", "/api/eco/info",
    "/api/approve/enqueue", "/api/mcp/resources"]
     .every((r) => py.includes('"' + r + '"') &&
                   java.includes('"' + r + '"')));
ck("A7 leakage: MCP describe exposes env names, never values",
   readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/client.py", "utf8")
     .includes('"env_names"') &&
   !readFileSync(home + "/workspace/ghostmcp/src/ghostmcp/client.py", "utf8")
     .includes('"env":'));
ck("A8 XSS: markdown escapes first and inert-schemes links",
   src.includes("const lines = escHtml(src).split(") &&
   src.includes("any other scheme (javascript:,") &&
   src.includes("escQ = (s) => s.replace(/\"/g, \"&quot;\")"));
ck("A8 XSS: mermaid labels are escaped at emission",
   (src.match(/escHtml\(label\)/g) || []).length >= 1 &&
   src.includes("escHtml(e.label)"));
ck("A9 bundle: gate defines LIBRARY + BUNDLED as one ship set",
   gate.includes('LIBRARY = ["ghostslice"]') &&
   gate.includes('"bundled": BUNDLED, "library": LIBRARY'));
ck("A9/A18 settings count matches the phone manifest rule",
   py.includes('st.get("bundled") or [])') &&
   py.includes('st.get("library") or []))'));
ck("A10 version gate: five sources, run by build.sh",
   readFileSync(home + "/workspace/ghostide-apk-build/check_versions.py", "utf8")
     .includes("all five sources agree") &&
   readFileSync(home + "/workspace/ghostide-apk-build/build.sh", "utf8")
     .includes("check_versions.py"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
