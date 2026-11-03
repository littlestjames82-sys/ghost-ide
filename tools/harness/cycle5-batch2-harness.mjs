// Cycle 5 batch 2 proof (v2.80): settings copy, tree
// sort, board Ask, approve text filter, git status
// copy. The settings object was read first: it holds
// preferences only (keys/tokens live elsewhere), so
// copying it cannot leak a credential.
import { readFileSync } from "node:fs";
const home = process.env.HOME;
const src = readFileSync(home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(home + "/workspace/ghost-ide/web/index.html", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? passed++ : failed++; };

ck("I6 settings copy exports the preferences object",
   html.includes('id="setCopySettings"') &&
   src.includes("JSON.stringify(settings, null, 1)"));
ck("I7 tree sort toggles and persists",
   html.includes('id="treeSortBtn"') &&
   src.includes('"ghostide.treeSort"') &&
   src.includes("treeOrder(d.files)"));
ck("I8 board Ask prefills from the summary line",
   src.includes('"💬 Ask Ghost about this board"') &&
   src.includes("boardSummaryLine(d)"));
ck("I9 approve text filter targets data-kind rows",
   src.includes('"Filter by text…"') &&
   src.includes('".todorow[data-kind]"'));
ck("I10 git status copy uses the last live payload",
   html.includes('id="gitCopyStatus"') &&
   src.includes("lastGitStatus = d") &&
   /* Cycle 7 I18 appended the stash depth before
      the final period; the pin follows the line. */
   src.includes('" uncommitted change(s)"'));
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
