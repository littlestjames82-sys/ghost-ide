// R23 v1.80.0 sessions pack 2 proof.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SESSIONS2@@*/")[1].split("/*@@SESSIONS2-END@@*/")[0];
const { dupSessionName, sessionOptionLabel, planDuplicate } =
  new Function("window", block + "; return { dupSessionName, sessionOptionLabel, planDuplicate };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("copy names read naturally",
   dupSessionName("Ideas") === "Ideas copy" && dupSessionName("") === "Chat copy");
ck("picker labels carry the count",
   sessionOptionLabel({ name: "Ideas" }, 12) === "Ideas (12)" &&
   sessionOptionLabel({ name: "New" }, 0) === "New (0)");
const L = [{ id: "s1", name: "Chat 1" }, { id: "s2", name: "Ideas" }];
ck("duplicate appends a copy of the active chat only",
   planDuplicate(L, "s2", "s9").copy.name === "Ideas copy" &&
   planDuplicate(L, "s2", "s9").list.length === 3 &&
   planDuplicate(L, "nope", "s9") === null);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("the Duplicate button exists in HTML", htmlIds.has("sessionDup"));
ck("the picker renders counts from stored history",
   src.includes("sessionOptionLabel(s, storedHistLen(s.id))") &&
   src.includes("function storedHistLen(sid)"));
ck("duplicate saves first, copies raw history, switches",
   src.includes('$("sessionDup").onclick') &&
   src.includes("saveHistory();") &&
   src.includes("sessionHistoryKey(historyScope, plan.copy.id), raw") &&
   src.includes("switchSession(plan.copy.id);"));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
