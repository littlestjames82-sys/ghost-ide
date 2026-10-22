// R2 v1.59.0 chat sessions proof: pure steps between
// @@SESSIONS@@ markers + static wiring.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@SESSIONS@@*/")[1].split("/*@@SESSIONS-END@@*/")[0];
const { normalizeSessions, sessionHistoryKey, nextSessionName, removeSession } =
  new Function("window", block + "; return { normalizeSessions, sessionHistoryKey, nextSessionName, removeSession };")({});
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };
ck("empty/garbage lists fall back to the default chat",
   normalizeSessions([]).length === 1 && normalizeSessions(null)[0].id === "s1" &&
   normalizeSessions("junk")[0].name === "Chat 1");
ck("entries are deduped by id and names trimmed + capped",
   normalizeSessions([{ id: "a", name: "  Work  " }, { id: "a", name: "Dupe" },
     { id: "b", name: "x".repeat(60) }]).length === 2 &&
   normalizeSessions([{ id: "a", name: "  Work  " }])[0].name === "Work" &&
   normalizeSessions([{ id: "b", name: "x".repeat(60) }])[0].name.length === 40);
ck("entries without a usable id are dropped",
   normalizeSessions([{ name: "No id" }, { id: 7, name: "Num" }]).length === 1);
ck("default session keeps the legacy history key",
   sessionHistoryKey("on-device", "s1") === "ghostide-history:on-device" &&
   sessionHistoryKey("on-device", null) === "ghostide-history:on-device");
ck("later sessions suffix their history key",
   sessionHistoryKey("/home/x", "sabc") === "ghostide-history:/home/x:sabc");
ck("next name skips names already in use",
   nextSessionName([{ id: "s1", name: "Chat 1" }]) === "Chat 2" &&
   nextSessionName([{ id: "s1", name: "Chat 1" }, { id: "s9", name: "Chat 3" }]) === "Chat 4" &&
   nextSessionName([{ id: "s1", name: "Chat 2" }]) === "Chat 3");
ck("the last session cannot be removed",
   removeSession([{ id: "s1", name: "Chat 1" }], "s1").removed === false);
ck("other sessions can be removed",
   removeSession([{ id: "s1", name: "A" }, { id: "s2", name: "B" }], "s2").list.length === 1 &&
   removeSession([{ id: "s1", name: "A" }], "nope").removed === false);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
ck("session controls exist in HTML",
   ["sessionSel", "sessionNew", "sessionRename", "sessionDel"].every((i) => htmlIds.has(i)));
ck("historyKey routes through the session key",
   src.includes("return sessionHistoryKey(historyScope, activeSession);"));
ck("scope changes load sessions before history",
   src.includes("loadSessions();\n      loadHistory();"));
ck("switching saves, swaps and reloads",
   src.includes("function switchSession(id)") && src.includes('$("sessionSel").onchange'));
ck("new/rename/delete are wired",
   src.includes('$("sessionNew").onclick') && src.includes('$("sessionRename").onclick') &&
   src.includes('$("sessionDel").onclick'));
ck("drafts are per session too",
   src.includes('chatDraftKey(historyScope) + ":" + activeSession'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
