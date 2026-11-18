// Mobile Cycle 2 (M7): voice-to-prompt in the chat
// composer.
//
// Static pins: the VOICEPROMPT block exists with its
// census unchanged, the composer mic is wired to it
// (and no longer to the G13 command path), the legacy
// editor dictation is intact, the block itself holds
// no send path and no command table, the honest state
// copy is present, the native composer recogniser is
// wired (on-device where the platform offers it,
// partial results on, the VoiceSupport mapping in
// use), the manifest still carries exactly the 7
// permissions with RECORD_AUDIO among them, and the
// viewport gate carries the three composer states.
//
// Live pins: the VOICEPROMPT block is extracted from
// main.js and driven with fixture window/elements -
// mic visibility follows the platform context, the
// light cleanup tidies whitespace and sentence
// spacing without rewriting words, partials assemble
// over the text already in the box, the final result
// replaces them cleaned, an end state restores the
// box to exactly what it held before dictating, a
// second tap asks the recogniser to stop, and a full
// session lands its transcript in the box unsent.
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
const mainActivity = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/MainActivity.java",
  "utf8");
const voiceSupport = readFileSync(apkRoot +
  "app/src/main/java/com/ghostide/app/VoiceSupport.java",
  "utf8");
const manifestXml = readFileSync(apkRoot +
  "app/src/main/AndroidManifest.xml", "utf8");
let passed = 0, failed = 0;
const ck = (n, c) => {
  console.log((c ? "PASS " : "FAIL ") + n);
  c ? passed++ : failed++;
};

const block = src.split("/*@@VOICEPROMPT@@*/")[1]
  .split("/*@@VOICEPROMPT-END@@*/")[0];

/* ---------- static pins ---------- */
ck("M7 bundle: block markers, hook, and the census " +
   "unchanged at 101",
   src.includes("/*@@VOICEPROMPT@@*/") &&
   src.includes("/*@@VOICEPROMPT-END@@*/") &&
   (src.match(/innerHTML/g) || []).length === 101 &&
   (app.match(/innerHTML/g) || []).length === 101 &&
   app.includes("__ghostVoicePrompt"));
ck("M7 wiring: the composer mic runs the voice " +
   "prompt flow, not the G13 command path",
   block.includes("mic.onclick = () => toggleVoicePrompt();") &&
   !src.includes('$("chatMic").onclick') &&
   !src.includes('startDictation("chat")'));
ck("M7 legacy: editor dictation and its result " +
   "handler are intact",
   src.includes('$("voiceBtn").onclick = () => startDictation("editor");') &&
   src.includes("window.__ghostVoiceResult") &&
   src.includes("VOICE_COMMANDS"));
ck("M7 invariant: the composer block holds no send " +
   "path, no agent run, and no command handling",
   !block.includes("sendChat") &&
   !block.includes("runAgent") &&
   !block.includes("VOICE_COMMANDS") &&
   !block.includes("__ghostVoiceResult") &&
   block.includes("REVIEW BEFORE SEND, ALWAYS"));
ck("M7 copy: the honest recogniser states are " +
   "written out in plain words",
   block.includes("On-device recognition: your") &&
   block.includes("may use the network") &&
   block.includes("Microphone permission is off") &&
   block.includes("Android Settings, Apps, GhostIDE") &&
   block.includes("Nothing was sent.") &&
   block.includes("Edit ") &&
   !block.includes("—"));
ck("M7 html/css: the status line sits with the " +
   "composer and the mic has a listening state and " +
   "a 40px phone target",
   html.includes('id="voiceStatus"') &&
   html.includes('id="chatMic"') &&
   css.includes("#voiceStatus") &&
   css.includes("#chatMic.listening") &&
   css.includes(".chat-input button { min-height: 40px; }"));
ck("M7 native: the composer recogniser is wired " +
   "with partials, the offline request, and the " +
   "on-device path where offered",
   mainActivity.includes("startComposerDictation()") &&
   mainActivity.includes("stopComposerDictation()") &&
   mainActivity.includes("createOnDeviceSpeechRecognizer") &&
   mainActivity.includes("isOnDeviceRecognitionAvailable") &&
   mainActivity.includes("EXTRA_PARTIAL_RESULTS, true") &&
   mainActivity.includes("EXTRA_PREFER_OFFLINE, true") &&
   mainActivity.includes("VoiceSupport.errorState(error)") &&
   mainActivity.includes(
     'deliverVoicePromptState("denied", null)') &&
   mainActivity.includes("__ghostVoicePromptPartial") &&
   mainActivity.includes("__ghostVoicePromptFinal"));
ck("M7 native: the error and device decisions live " +
   "in the pure VoiceSupport class",
   voiceSupport.includes("public static String errorState(int error)") &&
   voiceSupport.includes("ON_DEVICE_API = 31") &&
   voiceSupport.includes('return "denied";') &&
   voiceSupport.includes('return "network";') &&
   voiceSupport.includes('return "nomatch";') &&
   voiceSupport.includes('return "busy";'));
ck("M7 manifest: still exactly 7 permissions, " +
   "RECORD_AUDIO among them, nothing added",
   (manifestXml.match(/uses-permission/g) || []).length
     === 7 &&
   manifestXml.includes(
     'android.permission.RECORD_AUDIO'));
ck("M7 gate: the three composer states are measured",
   gate.includes("voice-composer") &&
   gate.includes("voice-listening") &&
   gate.includes("voice-denied") &&
   gate.includes("__ghostVoicePrompt"));

/* ---------- live block, fixture contexts ---------- */
function makeEl() {
  const el = {
    value: "", textContent: "", title: "",
    classes: new Set(), focused: false, sel: null,
    onclick: null,
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      toggle: (c, force) => {
        if (force === undefined)
          force = !el.classes.has(c);
        if (force) el.classes.add(c);
        else el.classes.delete(c);
        return force;
      },
      contains: (c) => el.classes.has(c),
    },
    focus() { el.focused = true; },
    setSelectionRange(a, b) { el.sel = [a, b]; },
  };
  return el;
}
const load = (win, els) => {
  const $ = (id) => els[id] || (els[id] = makeEl());
  return new Function("window", "$",
    block + "; return { voicePromptAvailable, " +
    "voicePromptForced, voiceCleanup, voiceJoin, " +
    "voicePartialText, voiceFinalText, " +
    "voiceStateMessage, toggleVoicePrompt };")(win, $);
};
const elOf = (els, id) => els[id] || (els[id] = makeEl());
const bridge = () => {
  const calls = { start: 0, stop: 0 };
  return { calls,
    startComposerDictation() { calls.start++; },
    stopComposerDictation() { calls.stop++; } };
};

/* visibility by platform context */
let els = {};
let g = load({}, els);
ck("M7 live: no bridge, no mic (desktop context)",
   g.voicePromptAvailable() === false &&
   els.chatMic.classes.has("hidden"));
els = {};
g = load({ GhostVoice: bridge() }, els);
ck("M7 live: the phone bridge shows the mic",
   g.voicePromptAvailable() === true &&
   !els.chatMic.classes.has("hidden"));
els = {};
g = load({}, els);
g.voicePromptForced(true);
const forcedShown = g.voicePromptAvailable() === true &&
  !els.chatMic.classes.has("hidden");
g.voicePromptForced(false);
ck("M7 live: the gate force hook flips visibility " +
   "and back",
   forcedShown && g.voicePromptAvailable() === false &&
   els.chatMic.classes.has("hidden"));

/* the light cleanup */
ck("M7 live: cleanup tidies whitespace and trims",
   g.voiceCleanup("  fix   the\t bug  ") === "fix the bug" &&
   g.voiceCleanup("") === "" &&
   g.voiceCleanup(null) === "");
ck("M7 live: cleanup restores sentence spacing " +
   "without rewriting words",
   g.voiceCleanup("hello.world") === "hello. world" &&
   g.voiceCleanup("wait...what happened?") ===
     "wait... what happened?" &&
   g.voiceCleanup("version 3.5 is out") ===
     "version 3.5 is out" &&
   g.voiceCleanup("Fix The BUG") === "Fix The BUG");
ck("M7 live: joins respect the text already present",
   g.voiceJoin("", "fix it") === "fix it" &&
   g.voiceJoin("please", "fix it") === "please fix it" &&
   g.voiceJoin("please ", "fix it") === "please fix it" &&
   g.voiceJoin("please", "") === "please");

/* state messages */
ck("M7 live: the listening message names the " +
   "recognition in use, honestly",
   g.voiceStateMessage("listening", "device")
     .includes("On-device recognition") &&
   g.voiceStateMessage("listening", "device")
     .includes("stays on this phone") &&
   g.voiceStateMessage("listening", "service")
     .includes("may use the network") &&
   !g.voiceStateMessage("listening", "service")
     .includes("stays on this phone"));
ck("M7 live: every end state has its own plain " +
   "message",
   g.voiceStateMessage("denied")
     .includes("Android Settings, Apps, GhostIDE") &&
   g.voiceStateMessage("network").includes("network") &&
   g.voiceStateMessage("unavailable")
     .includes("No speech recogniser") &&
   g.voiceStateMessage("nomatch")
     .includes("Nothing was added") &&
   g.voiceStateMessage("busy").includes("busy") &&
   g.voiceStateMessage("error")
     .includes("Nothing was sent.") &&
   g.voiceStateMessage("done").includes("tap Send"));

/* a full session: partials stream, the final lands
   cleaned, and nothing is sent */
els = {};
const br = bridge();
const win = { GhostVoice: br };
g = load(win, els);
elOf(els, "chatText").value = "please ";
g.toggleVoicePrompt();
ck("M7 live: a tap starts one native session",
   br.calls.start === 1 && br.calls.stop === 0 &&
   els.chatMic.textContent === "⏹");
win.__ghostVoicePromptState("listening", "device");
ck("M7 live: listening states the on-device kind",
   els.voiceStatus.textContent.includes("On-device") &&
   !els.voiceStatus.classes.has("hidden"));
win.__ghostVoicePromptPartial("fix   the");
ck("M7 live: a partial streams over the existing text",
   els.chatText.value === "please fix the");
win.__ghostVoicePromptPartial("fix the crash");
win.__ghostVoicePromptFinal("fix the crash.now");
ck("M7 live: the final replaces the partial, cleaned, " +
   "in the box, unsent",
   els.chatText.value === "please fix the crash. now" &&
   els.chatText.focused === true &&
   els.chatMic.textContent === "🎤" &&
   els.voiceStatus.textContent.includes("tap Send"));

/* a second tap stops; the heard text still lands */
els = {};
const br2 = bridge();
const win2 = { GhostVoice: br2 };
g = load(win2, els);
g.toggleVoicePrompt();
g.toggleVoicePrompt();
ck("M7 live: a second tap asks the recogniser to stop",
   br2.calls.start === 1 && br2.calls.stop === 1);
win2.__ghostVoicePromptFinal("stop here");
ck("M7 live: a stopped session still lands its text",
   els.chatText.value === "stop here");

/* an end state restores the box exactly */
els = {};
const win3 = { GhostVoice: bridge() };
g = load(win3, els);
elOf(els, "chatText").value = "keep me";
g.toggleVoicePrompt();
win3.__ghostVoicePromptState("listening", "service");
win3.__ghostVoicePromptPartial("draft words");
const midShown = els.chatText.value === "keep me draft words";
win3.__ghostVoicePromptState("denied");
ck("M7 live: a denied session drops its partial and " +
   "restores the box",
   midShown && els.chatText.value === "keep me" &&
   els.voiceStatus.textContent
     .includes("Microphone permission is off") &&
   els.chatMic.textContent === "🎤");
win3.__ghostVoicePromptPartial("late words");
ck("M7 live: a partial with no live session is ignored",
   els.chatText.value === "keep me");

console.log("VOICEPROMPT (M7): " + passed +
  " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
