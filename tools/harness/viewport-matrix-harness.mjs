// Mobile Cycle 1 (M1): the viewport-matrix gate.
//
// Static pins: the gate script carries the full matrix
// and the three bug-class checks; the M1 hardening is
// present in the CSS/JS; the version trains agree (the
// M1 re-sync). Live pins: the gate itself runs in a
// real Firefox (Playwright) - full matrix green, and
// the --selftest reintroduction of the 3.10.1 no-wrap
// commit row is caught. A layout claim needs a real
// engine; the DOM-stub cannot measure layout and is
// not used here.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const css = readFileSync(root + "web/style.css", "utf8");
const src = readFileSync(root + "web/src/main.js", "utf8");
const py = readFileSync(root + "server.py", "utf8");
const gate = readFileSync(root + "tools/viewport_gate.py",
  "utf8");
const vjson = JSON.parse(readFileSync(root + "VERSION.json",
  "utf8"));
const clog = JSON.parse(readFileSync(root +
  "web/changelog.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => {
  console.log((c ? "PASS " : "FAIL ") + n);
  c ? passed++ : failed++;
};

/* ---------- static pins ---------- */
const appVer = (py.match(/APP_VERSION = "([^"]+)"/) || [])[1];
ck("M1 version: every train agrees on the shared version",
   vjson.version === appVer && vjson.latest === appVer &&
   vjson.desktop.version === appVer &&
   vjson.android.version === appVer &&
   clog.entries[0].version === appVer);
ck("M1 gate: full viewport matrix present",
   ["(320, 568)", "(360, 740)", "(390, 844)", "(412, 915)",
    "(740, 360)", "(568, 320)", "(1440, 900)"]
     .every((v) => gate.includes(v)));
ck("M1 gate: the three bug-class checks present",
   gate.includes("document scrollWidth") &&
   gate.includes("control outside viewport") &&
   gate.includes("nowrap flex row spills"));
ck("M1 gate: selftest reintroduces the 3.10.1 bug",
   gate.includes("--selftest") &&
   gate.includes("flex-wrap: nowrap"));
ck("M1 gate: fixtures are real git workspaces (hunks + conflict)",
   gate.includes("make_fixtures") &&
   gate.includes('"merge", "side"') &&
   gate.includes("states_wsB"));
ck("M1 CSS: run-head and find buttons wrap",
   css.includes(".run-head { flex-wrap: wrap;") &&
   css.includes(".find-btns { flex-wrap: wrap; }"));
ck("M1 CSS: conflict panes cannot blow out the grid",
   css.includes("repeat(3, minmax(0, 1fr))") &&
   css.includes("#conflictPanes { grid-template-columns: minmax(0, 1fr); }"));
ck("M1 CSS: toggle labels wrap their controls (agentPolicySel)",
   css.includes(".ctx-toggle {") &&
   css.includes("flex-wrap: wrap;"));
ck("M1 CSS: editor keeps a usable minimum on phones",
   css.includes("#editorRow { min-height: 180px; }"));
ck("M1 JS: one overlay panel at a time on phone widths",
   src.includes("function closeOverlayPanels(exceptId)") &&
   src.includes("OVERLAY_PANEL_IDS") &&
   src.includes("if (open) closeOverlayPanels(null);"));

/* ---------- live gate ---------- */
const venvPy = home + "/workspace/ghostide-demo/venv/bin/python";
const python = process.env.GHOSTIDE_GATE_PYTHON ||
  (existsSync(venvPy) ? venvPy : "python3");
const probe = spawnSync(python, ["-c", "import playwright"],
  { encoding: "utf8", timeout: 30000 });
ck("M1 live: a Playwright Python is available (" + python + ")",
   probe.status === 0);
if (probe.status === 0) {
  const run = spawnSync(python,
    [root + "tools/viewport_gate.py"],
    /* M2 (3.25.0): the gate grew by 12 states (the
       interrupted and waiting-approval details at
       every phone width), and the full matrix now
       measures ~115s standalone, past the old 112s
       budget, so the harness killed a green gate at
       the timeout. Budget follows the measured
       truth, move recorded here. */
    { encoding: "utf8", timeout: 240000 });
  const out = (run.stdout || "") + (run.stderr || "");
  const finalLine = out.trim().split("\n")
    .filter((l) => l.startsWith("VIEWPORT GATE:")).pop() || "";
  console.log(finalLine || out.trim().split("\n").pop());
  ck("M1 live: full matrix green in a real Firefox",
     run.status === 0 && finalLine.endsWith("0 failures"));
  const self = spawnSync(python,
    [root + "tools/viewport_gate.py", "--selftest"],
    { encoding: "utf8", timeout: 60000 });
  const sout = (self.stdout || "") + (self.stderr || "");
  ck("M1 live: gate catches the reintroduced 3.10.1 bug",
     self.status === 0 &&
     sout.includes("SELFTEST PASS"));
}

console.log("VIEWPORT-MATRIX (M1): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
