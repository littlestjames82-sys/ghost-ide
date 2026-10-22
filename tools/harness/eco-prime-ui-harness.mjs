// Roadmap ECO E4 proof (headless part): the pure chat-state
// step behind "Prime this project" - a successful prime
// starts a NEW chat whose first context is the bundle - and
// the handoff response check. Extracted from main.js between
// the @@E4@@ markers, the same pattern as the chip harness.
// The full click-through (real DOM, real fetch, model
// context on send) is beyond this stub and stays with the
// device pass; wiring is asserted statically below.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const src = readFileSync(
  home + "/workspace/ghost-ide/web/src/main.js", "utf8");
const html = readFileSync(
  home + "/workspace/ghost-ide/web/index.html", "utf8");
const block = src.split("/*@@E4@@*/")[1].split("/*@@E4-END@@*/")[0];
const { primerChatState, handoffText } = new Function(
  "window", block + "; return { primerChatState, handoffText };")({});

let passed = 0, failed = 0;
const ck = (name, cond) => {
  console.log((cond ? "PASS " : "FAIL ") + name);
  cond ? passed++ : failed++;
};

const okResp = {
  ok: true, check_code: 0,
  check: { ok: true, errors: [], files_checked: 3,
           total_sliced_tokens: 120 },
  primer: "# PRIMER\nfixture facts\n", bundle: ".ghostide/primer",
};
const st = primerChatState(okResp);
ck("prime starts a new chat (empty history)",
   !!st && Array.isArray(st.history) && st.history.length === 0);
ck("the bundle is the new chat's first context",
   !!st && st.primerContext === okResp.primer);
ck("check verdict carried through (passed, 3 files)",
   !!st && st.passed === true && st.filesChecked === 3);

const failResp = { ok: true, check_code: 1,
  check: { ok: false, errors: ["hash drift"], files_checked: 2 },
  primer: "# PRIMER\n" };
const stf = primerChatState(failResp);
ck("a failed check still primes, verdict shown as FAILED",
   !!stf && stf.passed === false && stf.errors.length === 1);

ck("error response is not a prime",
   primerChatState({ error: "the tool could not run" }) === null);
ck("empty response is not a prime",
   primerChatState({}) === null && primerChatState(null) === null);
ck("response without PRIMER.md is not a prime",
   primerChatState({ ok: true, check: { ok: true } }) === null);

ck("handoff text passes through",
   handoffText({ ok: true, handoff: "# Handoff\n" }) === "# Handoff\n");
ck("handoff error is not usable",
   handoffText({ error: "could not build" }) === null
   && handoffText({}) === null);

// Static wiring: handlers, endpoints, send-path context.
ck("prime button exists in the chat panel",
   html.includes('id="primeBtn"'));
ck("handoff button exists in the chat panel",
   html.includes('id="handoffBtn"'));
ck("prime handler posts to /api/eco/prime",
   src.includes('$("primeBtn").onclick')
   && src.includes('postJson("/api/eco/prime", {})'));
ck("handoff handler posts to /api/eco/handoff",
   src.includes('$("handoffBtn").onclick')
   && src.includes('postJson("/api/eco/handoff", {})'));
ck("prime handler installs the bundle as primerContext",
   src.includes("primerContext = st.primerContext"));
ck("sendChat carries primerContext in the system message",
   src.includes("if (primerContext)")
   && src.includes("Project primer (GhostPrimer starter"));
ck("clearing the chat drops the primer context",
   /\$\("clearChatBtn"\)\.onclick = \(\) => \{[^}]*primerContext = null/
     .test(src));
ck("no closeOverlays anywhere (v1.51.1 lesson)",
   !src.includes("closeOverlays"));

console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
