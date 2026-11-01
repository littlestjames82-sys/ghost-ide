// Board + data openers + log slice proof (v2.46,
// E17/E14/E13): the board renders GhostConsole's model,
// data files open with the tools' own reports, and the
// Run pane slices output into a GhostLogs incident pack.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const srv = readFileSync(home + "/workspace/ghost-ide/server.py", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
const a = src.indexOf("/*@@BOARDDATA@@*/"), b = src.indexOf("/*@@BOARDDATA-END@@*/");
ck("BOARDDATA block markers present", a >= 0 && b > a);
const block = src.slice(a, b);
ck("board panel posts to /api/eco/board and groups by state",
   block.includes('postJson("/api/eco/board", {})') &&
   block.includes('"Verified": []') &&
   block.includes('s.state === "ok" ? "Verified"') &&
   block.includes('s.state === "absent" ? "Stale" : "Attention"'));
ck("board leads with the console's own column verdict",
   block.includes("proj.column_reason"));
ck("Tools menu has the board entry",
   html.includes('id="toolBoard"') &&
   block.includes("toolBoardBtn.onclick"));
ck("data opener picks GhostData for csv/tsv and plain json",
   block.includes('if (/\\.(csv|tsv)$/.test(lower)) tool = "ghostdata"') &&
   block.includes('postJson("/api/eco/toolrun",'));
ck("schema sniff covers openapi, swagger and $schema",
   block.includes('"openapi"|"swagger"|"\\$schema"|"jsonschema"') &&
   block.includes('"ghostschema" : "ghostdata"'));
ck("openFile hooks the data view on both paths",
   src.includes("maybeDataView(path, null);") &&
   src.includes("maybeDataView(path, d.content);"));
ck("data pane lives in the editor wrap with Ask + Close",
   html.includes('id="dataPane"') &&
   html.includes('id="dataAsk"') &&
   html.includes('id="dataClose"'));
ck("Ask Ghost prefills the chat box, never fakes a message",
   block.includes('box.value = lead + "\\n\\n"') &&
   block.includes('$("chatText")'));
ck("run pane slice posts the output and renders the pack",
   html.includes('id="runSlice"') &&
   block.includes('postJson("/api/eco/slicelog", { text })') &&
   block.includes("Incident pack (GhostLogs)"));
ck("desktop board delegates to GhostConsole summary --json",
   srv.includes('"ghostconsole",') &&
   srv.includes('["summary", str(ws), "--json"]'));
ck("desktop slicelog saves then packs via the ghostlogs runner",
   srv.includes("def eco_slicelog(") &&
   srv.includes('eco_toolrun("ghostlogs", ws,') &&
   srv.includes("nothing to slice - run something "));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
