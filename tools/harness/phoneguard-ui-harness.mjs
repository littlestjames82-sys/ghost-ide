// Mobile Cycle 2 (M6): the phone model guards.
//
// Static pins: the 7B caution lives in the native
// Models matrix and nowhere on the desktop (not in
// server.py's catalog, not in the bundle), the native
// warning gate is wired at exactly the download start
// and the 7B load, the readouts and the RAM-based
// recommendation are wired into the native store
// screens, the manifest gains no permission, the
// bundle's PHONEGUARD block exists with its census
// unchanged, the run loop and the Chat options select
// both read the one agentStepCap(), and the viewport
// gate carries the two phone states.
//
// Live pins: the PHONEGUARD block is extracted from
// main.js and driven with fixture window/settings -
// the burst default is 50 on the desktop and 25 on
// the phone, a LAN (pair) origin keeps desktop
// behaviour, a chosen budget wins on both platforms
// and clamps to the historical 10..120, and the
// gate's force hook flips the context and back.
import { readFileSync } from "node:fs";

const home = process.env.HOME;
const root = home + "/workspace/ghost-ide/";
const apkRoot = home + "/workspace/ghostide-apk-build/";
const src = readFileSync(root + "web/src/main.js", "utf8");
const app = readFileSync(root + "web/app.js", "utf8");
const html = readFileSync(root + "web/index.html", "utf8");
const gate = readFileSync(root + "tools/viewport_gate.py",
  "utf8");
const serverPy = readFileSync(root + "server.py", "utf8");
const modelsJava = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/Models.java", "utf8");
const guardJava = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/PhoneGuard.java",
  "utf8");
const mainActivity = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/MainActivity.java",
  "utf8");
const manifestXml = readFileSync(apkRoot +
  "app/src/main/AndroidManifest.xml", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => {
  console.log((c ? "PASS " : "FAIL ") + n);
  c ? passed++ : failed++;
};

/* ---------- static pins ---------- */
ck("M6 caution: the 7B caution text lives in the " +
   "native matrix only (absent from the desktop " +
   "catalog and from the bundle)",
   modelsJava.includes(
     '"Large for a phone: expect heat and fast battery drain."') &&
   modelsJava.includes("PHONE_LARGE_CAUTION") &&
   !serverPy.includes("Large for a phone") &&
   !src.includes("Large for a phone") &&
   !app.includes("Large for a phone"));
ck("M6 native: fit bands, recommendation and the " +
   "RAM-based default are in Models",
   modelsJava.includes("fitClass(double ramGB") &&
   modelsJava.includes("0.6 * totalGB") &&
   modelsJava.includes("0.9 * totalGB") &&
   modelsJava.includes("recommended(long totalRamBytes)") &&
   modelsJava.includes("if (v == V7) continue;") &&
   modelsJava.includes(
     'getString("modelVariant", null)') &&
   modelsJava.includes("totalRamBytes(Context c)") &&
   modelsJava.includes("getMemoryInfo(mi)"));
ck("M6 native: the warning decision is pure and " +
   "thresholded like the G40 guard",
   guardJava.includes("THERMAL_WARN_AT = 3") &&
   guardJava.includes("BATTERY_LOW_PCT = 20") &&
   guardJava.includes("stateWarning(int thermalStatus") &&
   guardJava.includes("isLargeModel(Models.Variant v)"));
ck("M6 native: the warning gate is wired at the " +
   "download start and at the 7B load, nowhere else",
   (mainActivity.match(/confirmDeviceWarning\(/g) || [])
     .length === 3 &&
   mainActivity.includes('"Before you download"') &&
   mainActivity.includes('"Before you load this model"') &&
   mainActivity.includes('"Download anyway"') &&
   mainActivity.includes('"Load anyway"') &&
   mainActivity.includes(
     "PhoneGuard.stateWarning(thermalNow()"));
ck("M6 native: battery and storage read with no " +
   "new permission (sticky intent + StatFs)",
   mainActivity.includes("Intent.ACTION_BATTERY_CHANGED") &&
   mainActivity.includes("registerReceiver(null") &&
   mainActivity.includes("new StatFs(getFilesDir()") &&
   (manifestXml.match(/uses-permission/g) || []).length
     === 7 &&
   !manifestXml.includes("BATTERY_STATS"));
ck("M6 native: readouts and marks on the store " +
   "screens",
   mainActivity.includes("deviceReadout()") &&
   (mainActivity.match(/deviceReadout\(\)/g) || [])
     .length >= 3 &&
   mainActivity.includes("RECOMMENDED") &&
   mainActivity.includes("Fits this phone.") &&
   mainActivity.includes("Models.PHONE_LARGE_CAUTION"));
ck("M6 bundle: block markers, the phone store note, " +
   "and the census unchanged at 101",
   src.includes("/*@@PHONEGUARD@@*/") &&
   src.includes("/*@@PHONEGUARD-END@@*/") &&
   src.includes("native Models store: open the app menu") &&
   src.includes("PHONE_AGENT_DEFAULT_STEPS = 25") &&
   (src.match(/innerHTML/g) || []).length === 101 &&
   (app.match(/innerHTML/g) || []).length === 101 &&
   app.includes("__ghostPhoneGuard"));
ck("M6 bundle: one budget source for the briefing, " +
   "the loop and the select; choosing marks the flag",
   src.includes("const stepCap = agentStepCap();") &&
   src.includes(
     "agentStepsSel.value = String(agentStepCap());") &&
   src.includes("settings.agentStepsChosen = true;") &&
   src.includes("agentStepsChosen: false") &&
   html.includes('id="agentStepsPhoneNote"'));
ck("M6 gate: the two phone states are measured",
   gate.includes("store-phone-note") &&
   gate.includes("chat-opts-phone") &&
   gate.includes("__ghostPhoneGuard"));

/* ---------- live block, fixture contexts ---------- */
const block = src.split("/*@@PHONEGUARD@@*/")[1]
  .split("/*@@PHONEGUARD-END@@*/")[0];
const load = (win, settings) => new Function(
  "window", "settings", "AGENT_MAX_STEPS", "$",
  block + "; return { phoneGuardOnAndroid, " +
  "phoneGuardForced, agentStepDefault, agentStepCap, " +
  "PHONE_AGENT_DEFAULT_STEPS };")(
  win, settings, 50, () => null);
const desktopWin = { location: { hostname: "" } };
const phoneWin = { GhostNative: {},
  location: { hostname: "127.0.0.1" } };
const pairWin = { GhostNative: {},
  location: { hostname: "192.168.1.20" } };
const fresh = { agentMaxSteps: 50, agentStepsChosen: false };

let g = load(desktopWin, { ...fresh });
ck("M6 live: desktop context, desktop default",
   g.phoneGuardOnAndroid() === false &&
   g.agentStepDefault() === 50 && g.agentStepCap() === 50);
g = load(phoneWin, { ...fresh });
ck("M6 live: phone context defaults to the 25-step burst",
   g.phoneGuardOnAndroid() === true &&
   g.agentStepDefault() === 25 && g.agentStepCap() === 25 &&
   g.PHONE_AGENT_DEFAULT_STEPS === 25);
g = load(pairWin, { ...fresh });
ck("M6 live: a LAN pair origin is not the phone context",
   g.phoneGuardOnAndroid() === false &&
   g.agentStepCap() === 50);
g = load({ GhostNative: {},
  location: { hostname: "localhost" } }, { ...fresh });
ck("M6 live: the localhost origin is the phone context",
   g.phoneGuardOnAndroid() === true &&
   g.agentStepCap() === 25);
g = load(phoneWin, { agentMaxSteps: 75,
  agentStepsChosen: true });
ck("M6 live: a chosen budget wins on the phone",
   g.agentStepCap() === 75);
g = load(desktopWin, { agentMaxSteps: 25,
  agentStepsChosen: true });
ck("M6 live: a chosen budget wins on the desktop too",
   g.agentStepCap() === 25);
g = load(phoneWin, { agentMaxSteps: 500,
  agentStepsChosen: true });
ck("M6 live: a chosen budget clamps to the historical cap",
   g.agentStepCap() === 120);
g = load(phoneWin, { agentMaxSteps: 5,
  agentStepsChosen: true });
ck("M6 live: a chosen budget clamps to the historical floor",
   g.agentStepCap() === 10);
g = load(desktopWin, { ...fresh });
g.phoneGuardForced(true);
const forced = g.phoneGuardOnAndroid() === true &&
  g.agentStepCap() === 25;
g.phoneGuardForced(false);
ck("M6 live: the gate force hook flips the context and back",
   forced && g.phoneGuardOnAndroid() === false &&
   g.agentStepCap() === 50);
g = load(phoneWin, { agentMaxSteps: 0,
  agentStepsChosen: false });
ck("M6 live: an unset stored budget falls back to the " +
   "platform default, never to zero",
   g.agentStepCap() === 25);

console.log("PHONEGUARD (M6): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
