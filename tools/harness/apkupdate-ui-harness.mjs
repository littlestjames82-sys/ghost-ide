// Mobile Cycle 1 (M5): the in-app APK update check.
//
// Static pins: the banner lives in the app chrome
// next to the trust banner with Download / Later /
// Dismiss, the CSS gives it the same floating-card
// shape one z-step below trust, the Settings check
// button branches to the APK check on Android, the
// native side reports the installed versionCode in
// /api/health and carries the https-only
// openExternal bridge method, the repo carries the
// android-latest.json template whose facts match
// the version sources, and the counted-string
// census in main.js stays exactly 101.
//
// Live pins: the APKUPDATE block is extracted from
// main.js and driven with fixture manifests through
// an injected fetchText - higher versionCode raises
// a notice carrying the manifest's version and URL,
// equal and lower stay silent, 404 / malformed JSON
// / a thrown fetch are errors with no notice, the
// once-a-day throttle skips without fetching, a
// manual check bypasses the throttle, and a snoozed
// versionCode stays silent while the next one
// notifies again.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const apkRoot = home + "/workspace/ghostide-apk-build/";
const src = readFileSync(root + "web/src/main.js", "utf8");
const app = readFileSync(root + "web/app.js", "utf8");
const html = readFileSync(root + "web/index.html", "utf8");
const css = readFileSync(root + "web/style.css", "utf8");
const gate = readFileSync(root + "tools/viewport_gate.py",
  "utf8");
const ideServer = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/IdeServer.java",
  "utf8");
const mainActivity = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/MainActivity.java",
  "utf8");
const manifestXml = readFileSync(apkRoot +
  "app/src/main/AndroidManifest.xml", "utf8");
const versionJson = JSON.parse(
  readFileSync(root + "VERSION.json", "utf8"));
const androidLatest = JSON.parse(
  readFileSync(root + "android-latest.json", "utf8"));
let passed = 0, failed = 0;
const ck = (n, c) => {
  console.log((c ? "PASS " : "FAIL ") + n);
  c ? passed++ : failed++;
};

/* ---------- static pins ---------- */
const iTrust = html.indexOf('id="trustBanner"');
const iUpd = html.indexOf('id="updateBanner"');
ck("M5 html: update banner sits in the chrome after " +
   "the trust banner, with body + three buttons",
   iTrust > -1 && iUpd > iTrust &&
   html.includes('id="updateBanner" class="hidden"') &&
   html.includes('id="updateBannerBody"') &&
   html.includes('id="updateDownloadBtn"') &&
   html.includes('id="updateLaterBtn"') &&
   html.includes('id="updateDismissBtn"'));
const m5css = css.split("Mobile Cycle 1 (M5)")[1] || "";
ck("M5 css: banner is the trust card shape, fixed " +
   "and hidden until shown",
   m5css.includes("#updateBanner {") &&
   m5css.includes("position: fixed") &&
   m5css.includes("z-index: 74") &&
   m5css.includes("#updateBanner.hidden { display: none; }"));
ck("M5 src: block markers, one URL constant, the " +
   "Android branch on the Settings button",
   src.includes("/*@@APKUPDATE@@*/") &&
   src.includes("/*@@APKUPDATE-END@@*/") &&
   src.includes('APK_UPDATE_MANIFEST_URL =\n' +
     '  "https://downloads.ghostdeveloperstudio.com' +
     '/ghostide/android-latest.json"') &&
   src.includes('APK_UPDATE_KEY = "ghostide-apkupdate"') &&
   src.includes("if (apkUpdateOnAndroid()) {") &&
   src.includes("apkUpdateManualCheck();") &&
   src.includes("setTimeout(() => { apkUpdateCheckNow(false); }, 5000);"));
ck("M5 src: census unchanged at 101 in source and " +
   "built bundle",
   (src.match(/innerHTML/g) || []).length === 101 &&
   (app.match(/innerHTML/g) || []).length === 101 &&
   app.includes("android-latest.json") &&
   app.includes("ghostide-apkupdate"));
ck("M5 gate: the banner is a measured state",
   gate.includes("update-banner") &&
   gate.includes("showApkUpdateNotice"));
ck("M5 native: health reports the installed " +
   "versionCode from the package manager",
   ideServer.includes("installedVersionCode()") &&
   ideServer.includes("getLongVersionCode()") &&
   ideServer.includes('",\\"versionCode\\":" + installedVersionCode()'));
ck("M5 native: openExternal is https-only " +
   "ACTION_VIEW, nothing downloads in-app",
   mainActivity.includes("public void openExternal(final String url)") &&
   mainActivity.includes('!url.startsWith("https://")') &&
   mainActivity.includes("Intent.ACTION_VIEW"));
const xmlCode = Number(
  (manifestXml.match(/android:versionCode="(\d+)"/) || [])[1]);
ck("M5 manifest template: fields complete and in " +
   "step with the version sources",
   androidLatest.version === versionJson.android.version &&
   androidLatest.versionCode === xmlCode &&
   /^https:\/\/downloads\.ghostdeveloperstudio\.com\/ghostide\//.test(androidLatest.apkUrl) &&
   /^[0-9a-f]{64}$/.test(androidLatest.sha256) &&
   androidLatest.sizeBytes > 1000000 &&
   typeof androidLatest.publishedAt === "string" &&
   androidLatest.publishedAt.length > 0);

/* ---------- live block, fixture manifests ---------- */
const block = src.split("/*@@APKUPDATE@@*/")[1]
  .split("/*@@APKUPDATE-END@@*/")[0];
const store = new Map();
const fakeLS = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const fakeWindow = { GhostNative: { openExternal() {} } };
const api = new Function("localStorage", "window",
  block + "; return { APK_UPDATE_MANIFEST_URL, " +
  "APK_UPDATE_INTERVAL_MS, apkUpdateOnAndroid, " +
  "apkUpdateManifestUrl, apkUpdateState, " +
  "saveApkUpdateState, apkUpdateEvaluate, " +
  "apkUpdateManualMessage, apkUpdateRun };")(
  fakeLS, fakeWindow);
const { apkUpdateOnAndroid, apkUpdateManifestUrl,
  apkUpdateState, saveApkUpdateState, apkUpdateEvaluate,
  apkUpdateManualMessage, apkUpdateRun } = api;

ck("M5 signal: GhostNative presence is the Android " +
   "signal", apkUpdateOnAndroid() === true);
const apiWeb = new Function("localStorage", "window",
  block + "; return { apkUpdateOnAndroid };")(
  fakeLS, {});
ck("M5 signal: no bridge, no APK check (desktop " +
   "stays silent)", apiWeb.apkUpdateOnAndroid() === false);
ck("M5 url: the constant is the downloads host " +
   "manifest, and a stored override wins",
   apkUpdateManifestUrl() ===
     "https://downloads.ghostdeveloperstudio.com/ghostide/android-latest.json");
store.set("ghostide-apkupdate-url",
  "http://127.0.0.1:9999/fixture.json");
const overrideUrl = apkUpdateManifestUrl();
store.set("ghostide-apkupdate-url", "javascript:x");
const junkUrl = apkUpdateManifestUrl();
store.delete("ghostide-apkupdate-url");
ck("M5 url: loopback override honoured, junk " +
   "override refused",
   overrideUrl === "http://127.0.0.1:9999/fixture.json" &&
   junkUrl === api.APK_UPDATE_MANIFEST_URL);

const CUR = 225;
const manifest = (code, extra) => JSON.stringify(
  Object.assign({ version: "3.27.0", versionCode: code,
    apkUrl: "https://downloads.ghostdeveloperstudio.com/ghostide/ghostide-v3.27.0.apk",
    sizeBytes: 20513387, sha256: "a".repeat(64),
    publishedAt: "2026-11-18T00:00:00Z" }, extra || {}));
ck("M5 evaluate: a higher code is a notice with " +
   "the manifest's version and URL",
   (() => { const n = apkUpdateEvaluate(
     JSON.parse(manifest(226)), CUR);
     return !!n && n.version === "3.27.0" &&
       n.versionCode === 226 &&
       n.apkUrl.endsWith("ghostide-v3.27.0.apk"); })());
ck("M5 evaluate: equal and lower codes are silent",
   apkUpdateEvaluate(JSON.parse(manifest(225)), CUR) === null &&
   apkUpdateEvaluate(JSON.parse(manifest(200)), CUR) === null);
ck("M5 evaluate: malformed manifests are silent",
   apkUpdateEvaluate(null, CUR) === null &&
   apkUpdateEvaluate({}, CUR) === null &&
   apkUpdateEvaluate(JSON.parse(manifest("225")), CUR) === null &&
   apkUpdateEvaluate(JSON.parse(manifest(222,
     { apkUrl: "http://example.com/x.apk" })), CUR) === null &&
   apkUpdateEvaluate(JSON.parse(manifest(227)), 0) === null);

let fetches = 0;
const fx = (resp) => async () => { fetches++; return resp; };
const T0 = 1763424000000;
store.clear();
let r = await apkUpdateRun({ manual: false, now: T0,
  currentCode: CUR, currentVersion: "3.26.0",
  fetchText: fx({ status: 200, text: manifest(226) }) });
ck("M5 run: higher fixture notifies and stamps " +
   "the check time",
   !!r.notice && r.notice.versionCode === 226 &&
   fetches === 1 && apkUpdateState().lastCheck === T0);
r = await apkUpdateRun({ manual: false, now: T0 + 3600000,
  currentCode: CUR, currentVersion: "3.26.0",
  fetchText: fx({ status: 200, text: manifest(227) }) });
ck("M5 run: an automatic check inside a day is " +
   "skipped without fetching",
   r.skipped === true && fetches === 1);
r = await apkUpdateRun({ manual: true, now: T0 + 3600000,
  currentCode: CUR, currentVersion: "3.26.0",
  fetchText: fx({ status: 200, text: manifest(225) }) });
ck("M5 run: a manual check bypasses the throttle; " +
   "equal is up to date",
   !r.skipped && !r.notice && !r.error && fetches === 2 &&
   apkUpdateManualMessage(r, "3.26.0") ===
     "You are up to date (3.26.0).");
r = await apkUpdateRun({ manual: true, now: T0 + 7200000,
  currentCode: CUR, currentVersion: "3.26.0",
  fetchText: fx({ status: 404, text: "not found" }) });
ck("M5 run: 404 is an error with no notice (silent " +
   "automatically, plain when manual)",
   !!r.error && !r.notice &&
   apkUpdateManualMessage(r, "3.26.0").startsWith(
     "Could not reach the update server."));
r = await apkUpdateRun({ manual: true, now: T0 + 10800000,
  currentCode: CUR, currentVersion: "3.26.0",
  fetchText: fx({ status: 200, text: "{not json" }) });
ck("M5 run: malformed JSON is an error, no notice",
   !!r.error && !r.notice);
r = await apkUpdateRun({ manual: true, now: T0 + 14400000,
  currentCode: CUR, currentVersion: "3.26.0",
  fetchText: async () => { throw new Error("offline"); } });
ck("M5 run: a thrown fetch is an error, no notice",
   !!r.error && !r.notice);
const st = apkUpdateState();
st.snoozedCode = 226;
saveApkUpdateState(st);
r = await apkUpdateRun({ manual: true, now: T0 + 18000000,
  currentCode: CUR, currentVersion: "3.26.0",
  fetchText: fx({ status: 200, text: manifest(226) }) });
const snoozedSilent = !r.notice && !r.error;
r = await apkUpdateRun({ manual: true, now: T0 + 21600000,
  currentCode: CUR, currentVersion: "3.26.0",
  fetchText: fx({ status: 200, text: manifest(227) }) });
ck("M5 run: the snoozed version stays silent, " +
   "the next one notifies",
   snoozedSilent && !!r.notice &&
   r.notice.versionCode === 227);
ck("M5 message: a notice reads as an update with " +
   "its version",
   apkUpdateManualMessage(r, "3.26.0") ===
     "Update available: GhostIDE v3.27.0 is ready to download.");

console.log("APKUPDATE (M5): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
