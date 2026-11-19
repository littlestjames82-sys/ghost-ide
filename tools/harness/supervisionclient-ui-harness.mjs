// Mobile Cycle 3 (M10): desktop pairing and the
// supervision client.
//
// Static pins: the SUPERVISIONCLIENT block and its
// hook, the census unchanged, the server's pairing
// core (off by default, hash-only token storage at
// 0600 in the D8 posture, the one-time code's TTL
// and attempt limit, the supervision route set and
// the gate's honoring of it, the seven new routes
// moving the route census 197 -> 204 with the Java
// census unmoved), the token's hygiene (never in
// web storage, never in a URL: the block contains
// no localStorage and builds no query string with
// it), the desktop receiving side (pairRec in
// runAgent: live record only when the server says
// pairing is on, follow-ups read and surfaced at
// step boundaries, the final write carrying them),
// the Pair panel section, the Tasks detail's
// follow-up lines, the panel markup and overlay
// list, the native half (Pairing rules, the bridge
// quartet, the pairing store file, the manifest
// still at 7 permissions), and the documents (the
// task format's followups convention, PAIRING.md's
// supervision section).
//
// Live pins: the block's pure rules are driven
// directly: the transport wording for HTTPS, for a
// Tailscale address, and for a plain LAN address
// (and the 100.64/10 boundary), the remote derived
// states (fresh running is live, stale running is
// interrupted, waiting carries its flag), the code
// shape and follow-up cleaning, the token adapter
// (Keystore bridge when present, memory-only when
// not, cleared on unpair), and the header carriage
// through a fake fetch (the token rides in
// X-Supervision-Token, and only there).
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const apkRoot = home + "/workspace/ghostide-apk-build/";
const src = readFileSync(root + "web/src/main.js", "utf8");
const app = readFileSync(root + "web/app.js", "utf8");
const html = readFileSync(root + "web/index.html", "utf8");
const server = readFileSync(root + "server.py", "utf8");
const gate = readFileSync(root + "tools/viewport_gate.py",
  "utf8");
const doc = readFileSync(root + "docs/TASK_FORMAT.md",
  "utf8");
const pairingDoc = readFileSync(root + "PAIRING.md",
  "utf8");
const mainActivity = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/MainActivity.java",
  "utf8");
const pairingJava = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/Pairing.java",
  "utf8");
const keystoreJava = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/GitTokenKeystore.java",
  "utf8");
const ideServer = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/IdeServer.java",
  "utf8");
const manifest = readFileSync(apkRoot +
  "app/src/main/AndroidManifest.xml", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => {
  console.log((c ? "PASS " : "FAIL ") + n);
  c ? passed++ : failed++;
};

const block = src.split("/*@@SUPERVISIONCLIENT@@*/")[1]
  .split("/*@@SUPERVISIONCLIENT-END@@*/")[0];
const supSection = server.split(
  "Mobile Cycle 3, M10: phone supervision pairing")[1]
  .split("def _lan_ips")[0];

/* ---------- static pins ---------- */
ck("M10 bundle: block markers, hook, and the census " +
   "unchanged at 101",
   src.includes("/*@@SUPERVISIONCLIENT@@*/") &&
   src.includes("/*@@SUPERVISIONCLIENT-END@@*/") &&
   (src.match(/innerHTML/g) || []).length === 101 &&
   (app.match(/innerHTML/g) || []).length === 101 &&
   app.includes("__ghostSupervisionClient"));
ck("M10 hygiene: the token never touches web " +
   "storage and the block builds no URL with it",
   !block.includes("localStorage") &&
   block.includes('"X-Supervision-Token"') &&
   !/supHttp\("[^"]*\?[^"]*"[^)]*token/i.test(block) &&
   block.includes("_rawFetch"));
ck("M10 server: pairing is off by default, the " +
   "code is single-use with a five minute life " +
   "and a five attempt limit, and only token " +
   "hashes are stored, at 0600 in app data",
   supSection.includes('SUP_STATE_FILE = ' +
     '"supervision-pairing.json"') &&
   supSection.includes("SUP_CODE_TTL = 300") &&
   supSection.includes("SUP_CODE_MAX_ATTEMPTS = 5") &&
   supSection.includes("_sup_token_hash") &&
   supSection.includes("secret=True") &&
   server.includes('"enabled": False, "devices": []') &&
   server.includes("_sup_code = None"));
ck("M10 server: the supervision route set is the " +
   "whole paired surface, and the gate honors the " +
   "token only inside it",
   supSection.includes('("GET", "/api/tasks")') &&
   supSection.includes('("GET", "/api/agent-runs")') &&
   supSection.includes('("GET", "/api/approve/list")') &&
   supSection.includes(
     '("POST", "/api/approve/decide")') &&
   supSection.includes(
     '("POST", "/api/supervision/followup")') &&
   server.includes("(self.command, path) in " +
     "SUPERVISION_ROUTES") &&
   server.includes('path == "/api/supervision/join"'));
ck("M10 census: seven new desktop routes move the " +
   "route census 197 -> 204, the Java census " +
   "unmoved at 138",
   (server.match(/parsed\.path ==/g) || []).length
     === 204 &&
   (ideServer.match(/path\.equals\("\/api/g) || [])
     .length === 138 &&
   server.includes('"/api/supervision/status"') &&
   server.includes('"/api/supervision/enable"') &&
   server.includes('"/api/supervision/code"') &&
   server.includes('"/api/supervision/join"') &&
   server.includes('"/api/supervision/unpair"') &&
   server.includes('"/api/supervision/followup"') &&
   server.includes('"/api/supervision/review"'));
ck("M10 receiving side: a desktop run keeps a live " +
   "record only when pairing is on, follow-ups " +
   "surface at step boundaries, and the final " +
   "write carries them",
   src.includes("if (pairRec) await pairSync();") &&
   src.includes('pairSync("waiting-approval")') &&
   src.includes("const liveRec = sup ? sup.rec") &&
   src.includes("followups: liveRec.payload" +
     ".followups") &&
   src.includes('"Note from your paired "') &&
   src.includes("st.paired") &&
   src.includes('platform: "desktop"'));
ck("M10 surfaces: the Pair panel section, the " +
   "Tasks detail follow-up lines, the panel " +
   "markup, and the overlay list",
   src.includes("renderSupPairSection(box);") &&
   src.includes('"Follow-up",') &&
   src.includes("payload.followups") &&
   html.includes('id="supervisionPanel"') &&
   html.includes('id="toolSupervision"') &&
   src.includes('"supervisionPanel"]') &&
   src.includes('$("toolSupervision")'));
ck("M10 native: the Pairing rules, the bridge " +
   "quartet, the pairing store file, and the " +
   "manifest still at 7 permissions",
   pairingJava.includes('"X-Supervision-Token"') &&
   pairingJava.includes("GitTokenStore.normHost") &&
   mainActivity.includes("savePairToken") &&
   mainActivity.includes("pairToken") &&
   mainActivity.includes("hasPairToken") &&
   mainActivity.includes("removePairToken") &&
   keystoreJava.includes("forPairing") &&
   keystoreJava.includes('"pair-tokens.dat"') &&
   (manifest.match(/uses-permission/g) || [])
     .length === 7);
ck("M10 docs and gate: the followups convention, " +
   "the PAIRING.md supervision section, and the " +
   "viewport gate's supervision states",
   doc.includes("payload.followups") &&
   pairingDoc.includes("Phone supervision pairing") &&
   gate.includes("supervision-pair") &&
   gate.includes("supervision-tasks") &&
   gate.includes("supervision-detail"));

/* ---------- live pins ---------- */
const sent = [];
const fakeFetch = (url, opts) => {
  sent.push({ url, opts });
  return Promise.resolve({
    status: 200, ok: true,
    json: () => Promise.resolve({ ok: true }) });
};
function drive(win, loc) {
  return new Function("window", "location",
    "_rawFetch",
    "/*@@SUPERVISIONCLIENT@@*/" + block +
    "; return { supTransportLine, supIsTailscaleHost,"
    + " remoteTaskDisplayState, supValidCode,"
    + " supCleanFollowup, supStoredToken,"
    + " supStoreToken, supClearToken,"
    + " supHasNativeStore, supHttp,"
    + " SUP_REMOTE_FRESH_MS };"
  )(win, loc, fakeFetch);
}
const loc = { hostname: "192.168.1.20",
  host: "192.168.1.20:5173", protocol: "http:" };
const plain = drive({}, loc);
ck("M10 live: transport wording is honest per " +
   "path (HTTPS, Tailscale, plain LAN, and the " +
   "100.64/10 boundary)",
   plain.supTransportLine({ protocol: "https:",
     hostname: "192.168.1.20" })
     .includes("HTTPS") &&
   plain.supTransportLine({ protocol: "https:",
     hostname: "192.168.1.20" })
     .includes("fingerprint") &&
   plain.supTransportLine({ protocol: "http:",
     hostname: "100.100.1.2" })
     .includes("Tailscale") &&
   plain.supTransportLine({ protocol: "http:",
     hostname: "192.168.1.20" })
     .includes("plain HTTP") &&
   plain.supTransportLine({ protocol: "http:",
     hostname: "100.200.1.2" })
     .includes("plain HTTP") &&
   plain.supIsTailscaleHost("100.64.0.1") &&
   plain.supIsTailscaleHost("100.127.9.9") &&
   !plain.supIsTailscaleHost("100.128.0.1") &&
   !plain.supIsTailscaleHost("100.63.0.1") &&
   !plain.supIsTailscaleHost("192.168.1.1"));
const now = Date.parse("2026-11-18T20:00:00Z");
const fresh = new Date(now - 30000).toISOString();
const stale = new Date(now - 600000).toISOString();
ck("M10 live: the remote derived states (fresh " +
   "running is live, stale running is interrupted, " +
   "waiting keeps its flag, ended stays ended)",
   plain.remoteTaskDisplayState(
     { status: "running", updatedAt: fresh }, now)
     .live === true &&
   plain.remoteTaskDisplayState(
     { status: "running", updatedAt: fresh }, now)
     .word === "running" &&
   plain.remoteTaskDisplayState(
     { status: "running", updatedAt: stale }, now)
     .word === "interrupted" &&
   plain.remoteTaskDisplayState(
     { status: "waiting-approval",
       updatedAt: fresh }, now)
     .word === "waiting for approval" &&
   plain.remoteTaskDisplayState(
     { status: "waiting-approval",
       updatedAt: stale }, now)
     .wasWaiting === true &&
   plain.remoteTaskDisplayState(
     { status: "done", updatedAt: stale }, now)
     .word === "done");
ck("M10 live: the code shape and the follow-up " +
   "cleaning",
   plain.supValidCode("123456") &&
   plain.supValidCode(" 123456 ") &&
   !plain.supValidCode("12345") &&
   !plain.supValidCode("12345a") &&
   plain.supCleanFollowup("  fix  the\n parser  ")
     === "fix the parser" &&
   plain.supCleanFollowup("x".repeat(3000)).length
     === 2000);
ck("M10 live: without a native store the token " +
   "lives in memory only and clears",
   plain.supHasNativeStore() === false &&
   plain.supStoreToken("192.168.1.20:5173", "tok1")
     === "memory" &&
   plain.supStoredToken("192.168.1.20:5173")
     === "tok1" &&
   (plain.supClearToken("192.168.1.20:5173"),
    plain.supStoredToken("192.168.1.20:5173")
      === ""));
const backing = {};
const nativeWin = { GhostNative: {
  savePairToken: (a, t) => { backing[a] = t;
    return true; },
  pairToken: (a) => backing[a] || null,
  hasPairToken: (a) => !!backing[a],
  removePairToken: (a) => { delete backing[a]; } } };
const withNative = drive(nativeWin, loc);
ck("M10 live: with the native bridge the token " +
   "lives in the Keystore store",
   withNative.supHasNativeStore() === true &&
   withNative.supStoreToken("192.168.1.20:5173",
     "tok2") === "keystore" &&
   backing["192.168.1.20:5173"] === "tok2" &&
   withNative.supStoredToken("192.168.1.20:5173")
     === "tok2" &&
   (withNative.supClearToken("192.168.1.20:5173"),
    withNative.supStoredToken("192.168.1.20:5173")
      === ""));
const carriage = drive(nativeWin, loc);
await carriage.supHttp("/api/tasks");
const bare = sent[sent.length - 1];
carriage.supStoreToken("192.168.1.20:5173", "tok3");
await carriage.supHttp("/api/tasks");
const carried = sent[sent.length - 1];
ck("M10 live: the token rides in the " +
   "X-Supervision-Token header, and only there",
   !("X-Supervision-Token" in
     (bare.opts.headers || {})) &&
   carried.opts.headers["X-Supervision-Token"]
     === "tok3" &&
   !carried.url.includes("tok3"));

console.log("supervisionclient-ui-harness: " +
  passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
