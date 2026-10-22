// Roadmap ECO E5 proof (headless part): the pure state steps
// behind the Atlas view and the Recall chat action - atlas
// totals are the tool's own per-file estimates summed, recall
// modes normalize to one row shape with provenance, and a
// context response is usable exactly when it carries the
// bundle's PROMPT.md. Extracted from main.js between the
// @@E5@@ markers, the same pattern as the E4 harness. The
// full click-through (real DOM, real fetch) is beyond this
// stub and stays with the device pass; wiring is asserted
// statically below.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const src = readFileSync(
  home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(
  home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@E5@@*/")[1].split("/*@@E5-END@@*/")[0];
const { atlasState, recallRows, recallContextState } = new Function(
  "window", block + "; return { atlasState, recallRows, recallContextState };")({});

let passed = 0, failed = 0;
const ck = (name, cond) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  cond ? passed++ : failed++;
};

// --- atlas state ---
const atlasResp = {
  ok: true, title: "fixture", audience: "onboarding",
  files: [
    { path: "src/a.py", tokens: 100, symbols: ["f"], importer_count: 2 },
    { path: "docs/n.md", tokens: 40, symbols: [], importer_count: 0 },
  ],
  packages: [{ path: "src", label: "src", files: 1, tokens: 100, share: 71.4 }],
  dead_candidates: [{ path: "src/a.py", reason: "no importers", tokens: 100 }],
  git: { available: true, total_commits: 2, window: "last 200 commits" },
};
const at = atlasState(atlasResp);
ck("atlas state carries the tool's files", !!at && at.files.length === 2);
ck("atlas total is the sum of the tool's estimates",
   !!at && at.totalTokens === 140);
ck("atlas packages + dead candidates pass through",
   !!at && at.packages.length === 1 && at.dead.length === 1);
ck("atlas git section passes through",
   !!at && at.git && at.git.total_commits === 2);
ck("atlas error is not usable",
   atlasState({ error: "could not run" }) === null);
ck("atlas response without files is not usable",
   atlasState({ ok: true }) === null && atlasState(null) === null);

// --- recall rows: ranked mode ---
const recResp = {
  ok: true, mode: "recall", task: "How does local storage work?",
  selected: [
    { id: "decision-d-001", title: "D-001", score: 0.5, pinned: true,
      tokens_estimate: 53,
      provenance: { path: "DECISIONS.md", line: 3, commit: null, date: "2026-01-15" } },
    { id: "commit-abc", title: "add storage", score: 0.9, pinned: false,
      tokens_estimate: 6,
      provenance: { path: "git:abc1234567", line: null, commit: "abc1234567ff", date: "2026-03-01" } },
  ],
  not_selected: [{ id: "decision-d-003", reason: "superseded" }],
  conflicts: [],
};
const rr = recallRows(recResp);
ck("recall mode normalizes rows", !!rr && rr.mode === "recall" && rr.rows.length === 2);
ck("recall row keeps the tool's estimate + provenance",
   !!rr && rr.rows[0].tokens === 53 && rr.rows[0].path === "DECISIONS.md" && rr.rows[0].line === 3);
ck("recall row keeps pinned + score",
   !!rr && rr.rows[0].pinned === true && rr.rows[0].score === 0.5);
ck("recall git row keeps the commit provenance",
   !!rr && rr.rows[1].commit === "abc1234567ff");
ck("recall not-selected passes through with reasons",
   !!rr && rr.notSelected.length === 1 && rr.notSelected[0].reason === "superseded");
ck("recall task label passes through",
   !!rr && rr.task === "How does local storage work?");

// --- recall rows: scan mode ---
const scanResp = {
  ok: true, mode: "scan",
  items: [
    { id: "decision-d-002", title: "D-002", source_type: "decision",
      path: "DECISIONS.md", line: 10, date: "2026-02-01",
      status: "active", blocked: false, tokens_estimate: 57 },
    { id: "note-x", title: "Secret note", source_type: "note",
      path: "notes.md", line: 1, date: null,
      status: "active", blocked: true, tokens_estimate: 12 },
  ],
};
const sr = recallRows(scanResp);
ck("scan mode normalizes rows", !!sr && sr.mode === "scan" && sr.rows.length === 2);
ck("scan row keeps type, status and blocked flags",
   !!sr && sr.rows[1].sourceType === "note" && sr.rows[1].blocked === true);
ck("scan rows have no score", !!sr && sr.rows[0].score === null);
ck("recall error is not usable",
   recallRows({ error: "x" }) === null && recallRows({}) === null
   && recallRows(null) === null);

// --- context state ---
const ctxResp = { ok: true, mode: "context",
  context: "# Project memory (GhostRecall)\n",
  totals: { memory_items: 3, prompt_tokens_estimate: 172 },
  bundle: ".ghostide/recall" };
const cs = recallContextState(ctxResp);
ck("context state carries PROMPT.md + totals",
   !!cs && cs.context.startsWith("# Project memory")
   && cs.totals.memory_items === 3);
ck("context error is not usable",
   recallContextState({ error: "x" }) === null
   && recallContextState({ ok: true }) === null);

// --- static wiring ---
ck("recall button exists in the chat aside",
   html.includes('id="recallBtn"'));
ck("recall button has a handler",
   src.includes('$("recallBtn").onclick'));
ck("atlas + recall endpoints are called",
   src.includes('"/api/eco/atlas"') && src.includes('"/api/eco/recall"'));
ck("recall context rides in sendChat like the primer",
   src.includes("if (recallContext)") && src.includes("Project memory (GhostRecall selection"));
ck("clear chat drops the recall context",
   src.includes("recallContext = null"));
ck("atlas view is a tab in the repo map panel",
   src.includes("showAtlas") && src.includes("renderAtlas"));
ck("recall add-to-context uses the bundle route",
   src.includes("context: true") && src.includes("addRecallToContext"));
ck("no closeOverlays anywhere in the source",
   !src.includes("closeOverlays"));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
