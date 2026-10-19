import { EditorView, keymap, Decoration, WidgetType,
  highlightWhitespace } from "@codemirror/view";
import { EditorState, StateEffect, StateField, Prec, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { indentWithTab, toggleComment, copyLineDown, moveLineUp,
  moveLineDown, deleteLine } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { openSearchPanel, selectNextOccurrence } from "@codemirror/search";
import { foldAll, unfoldAll, indentUnit } from "@codemirror/language";
import { BEHAVIOR } from "./behavior.js";

const $ = (id) => document.getElementById(id);

/* ---------------- ghost text (inline autocomplete) ---------------- */
const setGhost = StateEffect.define();

class GhostWidget extends WidgetType {
  constructor(text, onTap) { super(); this.text = text; this.onTap = onTap; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "ghost-text";
    s.textContent = this.text;
    // Tap-to-accept (Phase 1.1): phones have no Tab key.
    s.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.onTap) this.onTap();
    });
    return s;
  }
  ignoreEvent() { return false; }
}

const ghostField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhost)) {
        if (!e.value) return Decoration.none;
        const w = Decoration.widget({
          widget: new GhostWidget(e.value.text, e.value.onTap), side: 1 });
        return Decoration.set([w.range(e.value.from)]);
      }
    }
    return tr.docChanged ? Decoration.none : deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

let ghost = null;        // {from, text}
let accepting = false;

function showGhost(view, from, text) {
  ghost = { from, text };
  view.dispatch({ effects: setGhost.of({
    from, text, onTap: () => acceptGhost(view) }) });
  $("acceptChip").classList.remove("hidden");
  $("autocompleteState").textContent =
    "autocomplete: suggestion ready - tap it or press Tab";
}
function clearGhost(view) {
  $("acceptChip").classList.add("hidden");
  if (!ghost) return;
  ghost = null;
  view.dispatch({ effects: setGhost.of(null) });
}

/* ---------------- settings (persisted locally) ---------------- */
const settings = Object.assign(
  { temperature: 0.3, autocomplete: true, infillTokens: 48,
    formatOnSave: false, ctxMode: "file", wrap: false,
    shortAnswers: false, fontSize: "14px", infillDelay: 750,
    autosave: "off", trimOnSave: false, indent: 2,
    whitespace: false },
  JSON.parse(localStorage.getItem("ghostide-settings") || "{}"));
function saveSettings() {
  localStorage.setItem("ghostide-settings", JSON.stringify(settings));
}

/* ---------------- editor ---------------- */
function langFor(path) {
  if (/\.tsx?$/.test(path)) return javascript({ typescript: true });
  if (/\.jsx?$/.test(path)) return javascript({ jsx: true });
  if (/\.py$/.test(path)) return python();
  if (/\.html?$/.test(path)) return html();
  if (/\.css$/.test(path)) return css();
  if (/\.json$/.test(path)) return json();
  if (/\.md$/.test(path)) return markdown();
  return null;
}

let currentFile = null;
let dirty = false;
let modelUp = false;

/* wrapComp MUST be initialized before the EditorView below:
   baseExtensions() runs during view creation and calls
   wrapComp.of(...). Declaring it after the view put it in the
   temporal dead zone - a ReferenceError that killed the whole
   bundle at startup (v1.5.0/v1.6.0 dead-on-arrival bug). */
const wrapComp = new Compartment();
function wrapExt() {
  return settings.wrap ? EditorView.lineWrapping : [];
}
/* Same TDZ rule as wrapComp: these compartments are read by
   baseExtensions() during view creation, so they live up here. */
const indentComp = new Compartment();
function indentExt() {
  return indentUnit.of(settings.indent === 4 ? "    " : "  ");
}
const wsComp = new Compartment();
function wsExt() {
  return settings.whitespace ? highlightWhitespace() : [];
}

const view = new EditorView({
  parent: $("editor"),
  state: EditorState.create({
    doc: "// Open a file from the left, or create a new one.\n",
    extensions: baseExtensions(null),
  }),
});

function baseExtensions(path) {
  const lang = langFor(path || "");
  return [
    basicSetup,
    oneDark,
    ghostField,
    keymap.of([indentWithTab]),
    Prec.high(keymap.of([
      { key: "Tab", run: acceptGhost },
      { key: "Escape", run: (v) => { clearGhost(v); return !!ghost; } },
      { key: "Mod-s", run: () => { saveFile(); return true; } },
    ])),
    /* VS Code keymap pack (Phase 8): comment toggle, move/copy/
       delete line, select next occurrence. Commands are imported
       at the top of the module - safe to reference here. */
    keymap.of([
      { key: "Mod-/", run: toggleComment },
      { key: "Alt-ArrowUp", run: moveLineUp },
      { key: "Alt-ArrowDown", run: moveLineDown },
      { key: "Shift-Alt-ArrowDown", run: copyLineDown },
      { key: "Mod-Shift-k", run: deleteLine },
      { key: "Mod-d", run: selectNextOccurrence },
    ]),
    wrapComp.of(wrapExt()),
    indentComp.of(indentExt()),
    wsComp.of(wsExt()),
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        $("cursorPos").textContent =
          `Ln ${line.number}, Col ${head - line.from + 1}` +
          ` · ${u.state.doc.lines} lines · ${u.state.doc.length} chars`;
        updateCrumbs();
      }
      if (u.docChanged) {
        if (!accepting) { clearGhost(u.view); scheduleInfill(u.view); }
        if (currentFile && !dirty) { dirty = true; setSaveState("unsaved changes"); }
        if (currentFile && dirty) setSaveState("unsaved changes");
        if (currentFile && !tabDirty.get(currentFile)) {
          tabDirty.set(currentFile, true);
          renderTabs();
        }
        if (currentFile) queueDraftSave();
        if (currentFile) queueAutosave();
      }
    }),
  ];
}

function acceptGhost(v) {
  if (!ghost) return false;
  accepting = true;
  const { from, text } = ghost;
  ghost = null;
  v.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
    effects: setGhost.of(null),
  });
  accepting = false;
  $("acceptChip").classList.add("hidden");
  $("autocompleteState").textContent = "autocomplete: accepted";
  return true;
}

/* ---------------- autocomplete via /api/infill ---------------- */
let infillTimer = null;
let infillSeq = 0;

function scheduleInfill(v) {
  if (!modelUp) return;
  if (!settings.autocomplete) return;
  clearTimeout(infillTimer);
  $("autocompleteState").textContent = "autocomplete: thinking…";
  infillTimer = setTimeout(() => runInfill(v), settings.infillDelay);
}

async function runInfill(v) {
  const seq = ++infillSeq;
  const state = v.state;
  const pos = state.selection.main.head;
  if (state.selection.main.from !== state.selection.main.to) return;
  const doc = state.doc.toString();
  const prefix = doc.slice(
    Math.max(0, pos - BEHAVIOR.infill.prefixChars), pos);
  const suffix = doc.slice(pos, pos + BEHAVIOR.infill.suffixChars);
  if (prefix.trim().length < 3) return;
  try {
    const r = await fetch("/api/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, suffix,
        max_tokens: settings.infillTokens }),
    });
    const d = await r.json();
    if (seq !== infillSeq) return;
    let text = (d.content || "").replace(/\s+$/, "");
    if (!text) {
      $("autocompleteState").textContent = "autocomplete: no suggestion";
      return;
    }
    // Show at most 3 lines; drop anything after a blank line.
    text = text.split("\n\n")[0].split("\n")
      .slice(0, BEHAVIOR.infill.maxLines).join("\n");
    if (v.state.doc.toString() !== doc ||
        v.state.selection.main.head !== pos) return;
    showGhost(v, pos, text);
  } catch (e) {
    $("autocompleteState").textContent = "autocomplete: model unreachable";
  }
}

/* ---------------- files ---------------- */
function setSaveState(t) { $("saveState").textContent = t; }

/* Autosave drafts (Phase 1.7): edits are stashed locally every few
   seconds; if the app dies before Save, the draft is offered back. */
let draftTimer = null;
let pendingDraft = null;
function draftKey(path) { return "ghostide-draft:" + path; }
function queueDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem(draftKey(currentFile), JSON.stringify({
        content: view.state.doc.toString(), ts: Date.now() }));
    } catch (e) { /* storage blocked/full - drafts are best-effort */ }
  }, 3000);
}

/* Autosave (Phase 8, VS Code files.autoSave="afterDelay"): when
   the setting is on, edits save for real 2 s after typing stops.
   saveFile() is a hoisted function declaration, safe to call. */
let autosaveTimer = null;
function queueAutosave() {
  if (settings.autosave !== "delay") return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (currentFile && dirty) saveFile();
  }, 2000);
}
function checkDraft(path, diskContent) {
  pendingDraft = null;
  $("draftBar").classList.add("hidden");
  let raw = null;
  try { raw = localStorage.getItem(draftKey(path)); } catch (e) { return; }
  if (!raw) return;
  let d = null;
  try { d = JSON.parse(raw); } catch (e) { return; }
  if (!d || d.content === diskContent) return;
  pendingDraft = d;
  $("draftText").textContent = "Unsaved draft from " +
    new Date(d.ts).toLocaleTimeString() + " differs from the saved file.";
  $("draftBar").classList.remove("hidden");
}

let fileFilterText = "";
$("fileFilter").addEventListener("input", (e) => {
  fileFilterText = e.target.value.trim().toLowerCase();
  loadFiles();
});

/* Collapsible folders (Phase 9): collapsed dir paths persist
   locally; children of collapsed dirs are skipped in the list. */
let collapsedDirs = new Set();
try {
  collapsedDirs = new Set(JSON.parse(
    localStorage.getItem("ghostide-collapsed") || "[]"));
} catch (e) { /* fresh start */ }
function saveCollapsed() {
  try {
    localStorage.setItem("ghostide-collapsed",
      JSON.stringify([...collapsedDirs]));
  } catch (e) { /* best-effort */ }
}
function isHiddenByCollapse(path) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (collapsedDirs.has(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

async function loadFiles() {
  const r = await fetch("/api/files");
  const d = await r.json();
  const tree = $("fileTree");
  tree.innerHTML = "";
  for (const f of d.files) {
    if (fileFilterText) {
      /* Filter mode (Phase 10): matching files only, flat. */
      if (f.type !== "file") continue;
      if (!f.path.toLowerCase().includes(fileFilterText)) continue;
    } else if (isHiddenByCollapse(f.path)) continue;
    const row = document.createElement("div");
    row.className = "fileRow";
    const el = document.createElement("div");
    const depth = f.path.split("/").length - 1;
    el.style.paddingLeft = (6 + depth * 14) + "px";
    el.className = f.type;
    const baseName = f.path.split("/").pop();
    if (f.type === "dir") {
      const closed = collapsedDirs.has(f.path);
      el.textContent = (closed ? "▸ 📁 " : "▾ 📂 ") + baseName;
      el.onclick = () => {
        if (closed) collapsedDirs.delete(f.path);
        else collapsedDirs.add(f.path);
        saveCollapsed();
        loadFiles();
      };
    } else {
      el.textContent = "📄 " + baseName;
      if (f.path === currentFile) el.classList.add("active");
      el.onclick = () => openFile(f.path);
    }
    const menu = document.createElement("button");
    menu.className = "fileMenuBtn";
    menu.textContent = "⋯";
    menu.title = "Rename or delete";
    menu.onclick = (e) => { e.stopPropagation(); showFileMenu(f, e); };
    row.appendChild(el);
    row.appendChild(menu);
    tree.appendChild(row);
  }
  refreshGit();
}

/* Per-file menu: rename/move + delete (Phase 1.5). */
let menuTarget = null;
function showFileMenu(f, e) {
  menuTarget = f;
  const m = $("fileMenu");
  m.classList.remove("hidden");
  const r = e.target.getBoundingClientRect();
  m.style.top = (r.bottom + 4) + "px";
  m.style.left = Math.max(8, r.left - 110) + "px";
}
document.addEventListener("click", (e) => {
  const m = $("fileMenu");
  if (!m.classList.contains("hidden") && !m.contains(e.target) &&
      !e.target.classList.contains("fileMenuBtn"))
    m.classList.add("hidden");
});
$("menuRename").onclick = async () => {
  $("fileMenu").classList.add("hidden");
  if (!menuTarget) return;
  if (menuTarget.path === splitFile) closeSplit();
  const to = prompt("Rename / move to:", menuTarget.path);
  if (!to || to === menuTarget.path) return;
  const r = await fetch("/api/file/rename", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: menuTarget.path, to }) });
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  if (currentFile === menuTarget.path) {
    currentFile = to;
    $("currentFile").textContent = to;
    try { localStorage.removeItem(draftKey(menuTarget.path)); } catch (e) {}
  }
  const ti = tabOrder.indexOf(menuTarget.path);
  if (ti >= 0) {
    tabOrder[ti] = to;
    if (tabStates.has(menuTarget.path)) {
      tabStates.set(to, tabStates.get(menuTarget.path));
      tabStates.delete(menuTarget.path);
    }
    if (tabDirty.has(menuTarget.path)) {
      tabDirty.set(to, tabDirty.get(menuTarget.path));
      tabDirty.delete(menuTarget.path);
    }
    renderTabs();
  }
  loadFiles();
};
$("menuDelete").onclick = async () => {
  $("fileMenu").classList.add("hidden");
  if (!menuTarget) return;
  if (menuTarget.path === splitFile) closeSplit();
  const what = menuTarget.type === "dir"
    ? "folder and everything in it" : "file";
  if (!confirm("Delete this " + what + "?\n" + menuTarget.path)) return;
  const r = await fetch("/api/file/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: menuTarget.path }) });
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  if (currentFile === menuTarget.path) {
    currentFile = null;
    $("currentFile").textContent = "(no file open)";
    view.dispatch({ changes: {
      from: 0, to: view.state.doc.length, insert: "" } });
    setSaveState("");
  }
  const ti2 = tabOrder.indexOf(menuTarget.path);
  if (ti2 >= 0) {
    tabOrder.splice(ti2, 1);
    tabStates.delete(menuTarget.path);
    tabDirty.delete(menuTarget.path);
    renderTabs();
  }
  loadFiles();
};

/* Tabs (Phase 2.5): every open file keeps its own editor state, so
   switching tabs never loses edits, cursor position, or undo. */
const tabOrder = [];
const closedStack = [];
const tabStates = new Map();
const tabDirty = new Map();

function stashTab() {
  if (!currentFile) return;
  tabStates.set(currentFile, view.state);
  tabDirty.set(currentFile, dirty);
}

function renderTabs() {
  const bar = $("tabBar");
  bar.innerHTML = "";
  for (const p of tabOrder) {
    const t = document.createElement("div");
    t.className = "tab" + (p === currentFile ? " active" : "");
    const name = document.createElement("span");
    const isDirty = p === currentFile ? dirty : !!tabDirty.get(p);
    name.textContent = (isDirty ? "● " : "") + p.split("/").pop();
    name.title = p;
    name.onclick = () => {
      if (p === splitFile) {
        if (splitView) splitView.focus();
        return;
      }
      if (p !== currentFile) { stashTab(); activateTab(p); }
    };
    const x = document.createElement("button");
    x.className = "tabClose";
    x.textContent = "✕";
    x.title = "Close tab";
    x.onclick = (e) => { e.stopPropagation(); closeTab(p); };
    t.appendChild(name);
    t.appendChild(x);
    bar.appendChild(t);
  }
  saveSession();
}

function activateTab(path) {
  currentFile = path;
  view.setState(tabStates.get(path));
  dirty = !!tabDirty.get(path);
  $("currentFile").textContent = path;
  setSaveState(dirty ? "unsaved changes" : "saved");
  renderTabs();
  loadFiles();
  noteRecentFile(path);
  updateCrumbs();
}

function closeTab(p) {
  const i = tabOrder.indexOf(p);
  if (i < 0) return;
  if (p === splitFile) closeSplit();
  const isDirty = p === currentFile ? dirty : !!tabDirty.get(p);
  if (isDirty && !confirm("Close " + p + " with unsaved changes?")) return;
  tabOrder.splice(i, 1);
  closedStack.push(p);
  tabStates.delete(p);
  tabDirty.delete(p);
  try { localStorage.removeItem(draftKey(p)); } catch (e) {}
  if (p === currentFile) {
    currentFile = null;
    const next = tabOrder[Math.min(i, tabOrder.length - 1)];
    if (next) { activateTab(next); return; }
    dirty = false;
    view.setState(EditorState.create({
      doc: "", extensions: baseExtensions(null) }));
    $("currentFile").textContent = "no file open";
    setSaveState("");
    $("draftBar").classList.add("hidden");
  }
  renderTabs();
  loadFiles();
}

async function openFile(path, skipGuard) {
  if (path === currentFile) return;
  if (path === splitFile) {
    if (splitView) splitView.focus();
    return;
  }
  stashTab();
  if (tabStates.has(path)) { activateTab(path); return; }
  const r = await fetch("/api/file?path=" + encodeURIComponent(path));
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  if (!skipGuard && d.content && d.content.length > 200000 &&
      !confirm(path + " is " + Math.round(d.content.length / 1024) +
        " KB - large files can make the editor sluggish, especially " +
        "on the phone. Open it anyway?")) return;
  tabOrder.push(path);
  tabStates.set(path, EditorState.create({
    doc: d.content, extensions: baseExtensions(path) }));
  tabDirty.set(path, false);
  activateTab(path);
  checkDraft(path, d.content);
  checkQuiet();
}

function postJson(url, obj) {
  return fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj) }).then((r) => r.json());
}

async function saveFile() {
  if (!currentFile) return;
  if (settings.trimOnSave) {
    const doc = view.state.doc.toString();
    const trimmed = doc.split("\n")
      .map((l) => l.replace(/\s+$/, "")).join("\n")
      .replace(/\n*$/, "\n");
    if (trimmed !== doc) {
      accepting = true;
      view.dispatch({ changes: {
        from: 0, to: view.state.doc.length, insert: trimmed } });
      accepting = false;
    }
  }
  await fetch("/api/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: currentFile, content: view.state.doc.toString() }),
  });
  dirty = false;
  tabDirty.set(currentFile, false);
  renderTabs();
  try { localStorage.removeItem(draftKey(currentFile)); } catch (e) {}
  setSaveState("saved ✓ " + new Date().toLocaleTimeString());
  if (settings.formatOnSave) {
    const d = await postJson("/api/format", { path: currentFile });
    if (d.formatted) {
      const r = await fetch("/api/file?path=" +
        encodeURIComponent(currentFile));
      const fd = await r.json();
      if (!fd.error && fd.content !== view.state.doc.toString()) {
        const pos = Math.min(view.state.selection.main.head,
                             fd.content.length);
        accepting = true;
        view.dispatch({ changes: {
          from: 0, to: view.state.doc.length, insert: fd.content },
          selection: { anchor: pos } });
        accepting = false;
        dirty = false;
        tabDirty.set(currentFile, false);
        tabStates.set(currentFile, view.state);
        renderTabs();
        try { localStorage.removeItem(draftKey(currentFile)); }
        catch (e) {}
      }
      setSaveState("saved + formatted ✓ " +
        new Date().toLocaleTimeString());
    }
  }
  refreshTodoChip();
  checkQuiet();
}

$("saveBtn").onclick = saveFile;
$("newFileBtn").onclick = async () => {
  const name = prompt(
    "New file name (e.g. notes.py, src/app.js).\n" +
    "End with / to create a folder instead:");
  if (!name) return;
  if (name.endsWith("/")) {
    const r = await fetch("/api/dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: name.slice(0, -1) }),
    });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    loadFiles();
    return;
  }
  const r = await fetch("/api/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: name, content: "" }),
  });
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  await loadFiles();
  openFile(name);
};

/* Draft bar + accept chip */
$("draftRestore").onclick = () => {
  if (!pendingDraft) return;
  view.dispatch({ changes: {
    from: 0, to: view.state.doc.length, insert: pendingDraft.content } });
  dirty = true;
  setSaveState("unsaved changes (draft restored)");
  pendingDraft = null;
  $("draftBar").classList.add("hidden");
};
$("draftDiscard").onclick = () => {
  if (currentFile) {
    try { localStorage.removeItem(draftKey(currentFile)); } catch (e) {}
  }
  pendingDraft = null;
  $("draftBar").classList.add("hidden");
};
$("acceptChip").onclick = () => acceptGhost(view);

/* Settings panel (Phase 1.6) */
$("settingsBtn").onclick = () =>
  $("settingsPanel").classList.toggle("hidden");
$("settingsClose").onclick = () =>
  $("settingsPanel").classList.add("hidden");
{
  const tempEl = $("setTemp");
  tempEl.value = settings.temperature;
  $("setTempVal").textContent = settings.temperature;
  tempEl.oninput = () => {
    settings.temperature = parseFloat(tempEl.value);
    $("setTempVal").textContent = tempEl.value;
    saveSettings();
  };
  $("setAuto").checked = settings.autocomplete;
  $("setAuto").onchange = (e) => {
    settings.autocomplete = e.target.checked;
    saveSettings();
  };
  $("setTokens").value = settings.infillTokens;
  $("setTokens").onchange = (e) => {
    const n = parseInt(e.target.value, 10);
    if (n >= 16 && n <= 256) {
      settings.infillTokens = n;
      saveSettings();
    }
  };
  $("setFormat").checked = settings.formatOnSave;
  $("setFormat").onchange = (e) => {
    settings.formatOnSave = e.target.checked;
    saveSettings();
  };
}
$("ctxMode").value = settings.ctxMode;
$("ctxMode").onchange = (e) => {
  settings.ctxMode = e.target.value;
  saveSettings();
};
$("modelSwitch").onclick = async () => {
  const p = $("modelPath").value.trim();
  if (!p) { alert("Paste a model file path first."); return; }
  const d = await postJson("/api/model/switch", { path: p });
  if (d.error) { alert(d.error); return; }
  $("modelPath").value = "";
  alert("Model switched to " + d.modelName +
    " - use Start model to load it.");
  pollHealth();
};

/* ---------------- model status ---------------- */
async function pollHealth() {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    modelUp = d.model === "up";
    $("modelInfo").textContent =
      "Model: " + d.modelName + " · status: " + d.model;
    const pill = $("modelPill");
    pill.textContent = "model: " + (modelUp ? "up · " + d.modelName : "down");
    pill.className = "pill " + (modelUp ? "up" : "down");
    $("startModelBtn").classList.toggle("hidden", modelUp);
  } catch (e) { /* backend hiccup; next poll retries */ }
}
$("startModelBtn").onclick = async () => {
  $("modelPill").textContent = "model: starting… (about a minute)";
  $("modelPill").className = "pill loading";
  $("startModelBtn").classList.add("hidden");
  await fetch("/api/model/start", { method: "POST" });
};
setInterval(pollHealth, 4000);
pollHealth();

/* ---------------- chat ---------------- */
const history = [];

/* Session continuity (Phase 3.4): chat history is saved per project
   (keyed by workspace path; the phone's scope is "on-device") and
   restored when you come back to that project. */
const GREETING =
  "Hey - I'm your offline coding partner, running on the local " +
  "Qwen2.5-Coder. Open a file, ask me anything about it, and pause " +
  "while typing to get inline suggestions (tap the suggestion or " +
  "press Tab to accept). Nothing leaves this device.";
let historyScope = null;
function historyKey() { return "ghostide-history:" + historyScope; }
function saveHistory() {
  if (!historyScope) return;
  try {
    localStorage.setItem(historyKey(),
      JSON.stringify(history.slice(-60)));
  } catch (e) { /* best-effort */ }
}
function loadHistory() {
  history.length = 0;
  $("chatLog").innerHTML = "";
  let items = [];
  try {
    items = JSON.parse(localStorage.getItem(historyKey()) || "[]");
  } catch (e) { items = []; }
  for (const m of items) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    history.push(m);
    if (m.role === "user") {
      addMsg("YOU", m.content);
    } else {
      renderRich(addMsg("GHOST", ""), m.content);
    }
  }
  if (!items.length) addMsg("GHOST", GREETING);
}

function renderRich(el, text) {
  el.innerHTML = "";
  const parts = text.split("```");
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const lines = part.split("\n");
      const code = lines.slice(1).join("\n").replace(/\n$/, "");
      const wrap = document.createElement("div");
      const pre = document.createElement("pre");
      pre.textContent = code;
      const btn = document.createElement("button");
      btn.textContent = "Insert at cursor";
      btn.onclick = () => {
        const pos = view.state.selection.main.head;
        view.dispatch({
          changes: { from: pos, insert: code },
          selection: { anchor: pos + code.length },
        });
        view.focus();
      };
      wrap.appendChild(pre);
      wrap.appendChild(btn);
      el.appendChild(wrap);
    } else if (part.trim()) {
      const div = document.createElement("div");
      div.style.whiteSpace = "pre-wrap";
      div.textContent = part;
      el.appendChild(div);
    }
  });
}

function addMsg(who, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  const w = document.createElement("div");
  w.className = "who";
  w.textContent = who;
  const body = document.createElement("div");
  body.textContent = text;
  wrap.appendChild(w);
  wrap.appendChild(body);
  $("chatLog").appendChild(wrap);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  return body;
}

async function sendChat() {
  const ta = $("chatText");
  const text = ta.value.trim();
  if (!text) return;
  if (!modelUp) { addMsg("SYSTEM", "Model is down - hit Start model first."); return; }

  /* Context (Phase 2.2): current file, or a GhostSlice project bundle
     with a token meter. Built BEFORE the message enters history, so an
     over-budget slice can hard-stop the send honestly. */
  const SYS = BEHAVIOR.systemPrompt;
  let sysContent = SYS;
  if ($("ctxToggle").checked) {
    const mode = $("ctxMode").value;
    if (mode === "file" && currentFile) {
      const body = view.state.doc.toString()
        .slice(0, BEHAVIOR.context.fileChars);
      sysContent = SYS + "\nCurrent file: " + currentFile +
        "\n```\n" + body + "\n```";
      $("ctxMeter").textContent = "context: current file · ~" +
        Math.round(body.length / 4) + " tok (rough estimate)";
    } else if (mode !== "file") {
      const d = await postJson("/api/context", {
        mode, budget: BEHAVIOR.context.sliceBudget });
      if (d.error) {
        addMsg("SYSTEM", "Project slice unavailable: " + d.error +
          " - sending with no project context.");
        $("ctxMeter").textContent = "context: none (slice failed)";
      } else if (d.over) {
        addMsg("SYSTEM", "Project slice is ~" + d.tokens +
          " tokens - over the " + BEHAVIOR.context.sliceBudget.toLocaleString() + " budget, so this message was NOT " +
          "sent. Switch context to current file, or shrink the project.");
        return;
      } else {
        sysContent = SYS + "\nProject context (" + d.mode +
          " slice, " + d.files + " files):\n" + d.text;
        $("ctxMeter").textContent = "context: " + d.mode + " slice · " +
          d.tokens.toLocaleString() + " / " + BEHAVIOR.context.sliceBudget.toLocaleString() + " tok · " + d.files +
          " files (full project ~" +
          d.originalTokens.toLocaleString() + " tok)";
      }
    }
  }

  /* @file mentions + selection attach (Phase 9, Cursor-style):
     referenced files and any selected code ride along as context. */
  const attachedNames = [];
  if (text.includes("@")) {
    try {
      const fr = await fetch("/api/files");
      const fd = await fr.json();
      const known = new Set((fd.files || [])
        .filter((x) => x.type === "file").map((x) => x.path));
      const mentioned = [...new Set(
        [...text.matchAll(/@([\w.\-/]+)/g)]
          .map((m) => m[1]).filter((p) => known.has(p)))].slice(0, 2);
      for (const p of mentioned) {
        const r2 = await fetch("/api/file?path=" +
          encodeURIComponent(p));
        const d2 = await r2.json();
        if (!d2.error && d2.content != null) {
          sysContent += "\nAttached file " + p + ":\n```\n" +
            d2.content.slice(0, BEHAVIOR.context.fileChars) + "\n```";
          attachedNames.push(p);
        }
      }
    } catch (e) { /* mentions are best-effort */ }
  }
  const selNow = view.state.selection.main;
  if (!selNow.empty && currentFile) {
    const selText = view.state.doc
      .sliceString(selNow.from, selNow.to).slice(0, 3000);
    if (selText.trim()) {
      sysContent += "\nSelected code from " + currentFile +
        ":\n```\n" + selText + "\n```";
      attachedNames.push("selection");
    }
  }
  if (attachedNames.length)
    $("ctxMeter").textContent =
      "attached: " + attachedNames.join(", ");

  ta.value = "";
  addMsg("YOU", text);
  history.push({ role: "user", content: text });
  saveHistory();
  const messages = [{ role: "system", content: sysContent }, ...history];

  const body = addMsg("GHOST", "");
  let full = "";
  chatAbort = new AbortController();
  const sendBtn = $("chatSend");
  sendBtn.textContent = "■ Stop";
  sendBtn.onclick = () => { if (chatAbort) chatAbort.abort(); };
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: chatAbort.signal,
      body: JSON.stringify({
        messages, stream: true,
        max_tokens: settings.shortAnswers ? 512
                                           : BEHAVIOR.chat.maxTokens,
        temperature: settings.temperature }),
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content || "";
          full += delta;
          body.textContent = full;
          $("chatLog").scrollTop = $("chatLog").scrollHeight;
        } catch (e) { /* partial JSON line; wait for more */ }
      }
    }
  } catch (e) {
    if (e && e.name === "AbortError") {
      full += "\n\n(stopped)";
    } else {
      full = full || ("(error talking to the model: " + e + ")");
    }
  }
  chatAbort = null;
  sendBtn.textContent = "Send";
  sendBtn.onclick = sendChat;
  renderRich(body, full);
  history.push({ role: "assistant", content: full });
  saveHistory();
}

let chatAbort = null;
$("chatSend").onclick = sendChat;
$("chatText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

/* ---------------- Phase 2: run / git / workspace / find ------- */
$("runBtn").onclick = async () => {
  if (!currentFile) { alert("Open a file first."); return; }
  if (dirty) await saveFile();
  $("runPane").classList.remove("hidden");
  $("runTitle").textContent = "Running " + currentFile + " …";
  $("runOut").textContent = "";
  const d = await postJson("/api/run", { path: currentFile });
  if (d.error) {
    $("runTitle").textContent = "Run unavailable";
    $("runOut").textContent = d.error +
      "\n\n(Runs are local and unsandboxed: your machine, your code.)";
    return;
  }
  $("runTitle").textContent =
    "$ " + d.cmd + "  ·  exit " + d.code + "  ·  " + d.ms + " ms";
  $("runOut").textContent =
    (d.stdout || "") +
    (d.stderr ? "\n— stderr —\n" + d.stderr : "") || "(no output)";
};
$("runClose").onclick = () => $("runPane").classList.add("hidden");

async function refreshGit() {
  const box = $("gitChanges");
  if (!box) return;
  try {
    const r = await fetch("/api/git/status");
    const d = await r.json();
    if (!d.repo) {
      $("gitBranch").textContent = "";
      $("gitLog").textContent = "";
      $("gitAiMsg").disabled = true;
      box.textContent = d.error || "Not a git repo.";
      return;
    }
    $("gitBranch").textContent = d.branch || "";
    $("gitAiMsg").disabled = false;
    box.innerHTML = "";
    if (!d.changes.length) {
      box.textContent = "Clean - nothing changed.";
      return;
    }
    for (const c of d.changes) {
      const row = document.createElement("div");
      row.className = "gitRow";
      const staged = c.index !== " " && c.index !== "?";
      const untracked = c.index === "?" && c.worktree === "?";
      const label = document.createElement("span");
      label.textContent = c.path + " ";
      const tag = document.createElement("em");
      tag.textContent = untracked ? "untracked"
        : staged ? "staged" : "modified";
      label.appendChild(tag);
      row.appendChild(label);
      if (!staged) {
        const b = document.createElement("button");
        b.textContent = "Stage";
        b.onclick = async () => {
          await postJson("/api/git/stage", { path: c.path });
          refreshGit();
        };
        row.appendChild(b);
      }
      const db = document.createElement("button");
      db.textContent = "Diff";
      db.onclick = () => showDiff(c.path);
      row.appendChild(db);
      box.appendChild(row);
    }
    try {
      const lr = await fetch("/api/git/log");
      const ld = await lr.json();
      if (ld.commits && ld.commits.length) {
        $("gitLog").textContent = "Recent commits:\n" +
          ld.commits.map((c) => c.hash + "  " + c.subject).join("\n");
      } else {
        $("gitLog").textContent = "";
      }
    } catch (e) { $("gitLog").textContent = ""; }
  } catch (e) {
    box.textContent = "git unavailable";
  }
}

async function showDiff(path) {
  const r = await fetch("/api/git/diff?path=" + encodeURIComponent(path));
  const d = await r.json();
  $("diffTitle").textContent = "Diff: " + path;
  $("diffOut").textContent =
    d.error || d.diff || "(no diff - file may be untracked)";
  $("diffPanel").classList.remove("hidden");
}
$("diffClose").onclick = () => $("diffPanel").classList.add("hidden");
$("commitBtn").onclick = async () => {
  const msg = $("commitMsg").value.trim();
  if (!msg) { alert("Write a commit message first."); return; }
  const d = await postJson("/api/git/commit", { message: msg });
  if (d.error) { alert(d.error); return; }
  $("commitMsg").value = "";
  addMsg("SYSTEM", "Committed: " + d.output);
  refreshGit();
};

/* Workspace switching (2.1) + recents */
let wsRecents = JSON.parse(
  localStorage.getItem("ghostide-recent-workspaces") || "[]");
async function refreshWsLabel() {
  try {
    const r = await fetch("/api/workspace");
    const d = await r.json();
    $("wsPath").textContent = "📂 " + (d.workspace || "");
    $("wsPath").title = d.workspace || "";
    const scope = d.workspace || "on-device";
    if (scope !== historyScope) {
      historyScope = scope;
      loadHistory();
    }
    return d.workspace;
  } catch (e) { return null; }
}
$("wsBtn").onclick = async () => {
  const cur = await refreshWsLabel();
  if (cur === "on-device") {
    alert("On the phone, the workspace is the app's own folder. " +
          "Use Import / Export in the app menu to move files.");
    return;
  }
  const m = $("wsMenu");
  m.innerHTML = "";
  const open = document.createElement("button");
  open.textContent = "Open folder…";
  open.onclick = () => {
    m.classList.add("hidden");
    const p = prompt("Folder path to open as workspace:", cur || "");
    if (p) switchWorkspace(p);
  };
  m.appendChild(open);
  for (const p of wsRecents) {
    if (p === cur) continue;
    const b = document.createElement("button");
    b.textContent = p;
    b.onclick = () => { m.classList.add("hidden"); switchWorkspace(p); };
    m.appendChild(b);
  }
  m.classList.toggle("hidden");
};
document.addEventListener("click", (e) => {
  const m = $("wsMenu");
  if (!m.classList.contains("hidden") && !m.contains(e.target) &&
      e.target.id !== "wsBtn")
    m.classList.add("hidden");
});
async function switchWorkspace(p) {
  const d = await postJson("/api/workspace", { path: p });
  if (d.error) { alert(d.error); return; }
  wsRecents = [d.workspace,
    ...wsRecents.filter((x) => x !== d.workspace)].slice(0, 6);
  localStorage.setItem("ghostide-recent-workspaces",
    JSON.stringify(wsRecents));
  if (splitFile) closeSplit();
  tabOrder.length = 0;
  tabStates.clear();
  tabDirty.clear();
  currentFile = null;
  dirty = false;
  view.setState(EditorState.create({
    doc: "// Workspace: " + d.workspace + "\n",
    extensions: baseExtensions(null) }));
  $("currentFile").textContent = "no file open";
  setSaveState("");
  renderTabs();
  refreshWsLabel();
  loadFiles();
}

/* Project find / replace (2.5) */
$("findBtn").onclick = () => $("findPanel").classList.toggle("hidden");
$("findClose").onclick = () => $("findPanel").classList.add("hidden");
function jumpToLine(n) {
  try {
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: line.from },
                    scrollIntoView: true });
    view.focus();
  } catch (e) { /* line out of range after edits */ }
}
$("findGo").onclick = async () => {
  const q = $("findQuery").value;
  const box = $("findResults");
  if (!q) return;
  box.textContent = "searching…";
  const d = await postJson("/api/search", { query: q });
  if (d.error) { box.textContent = d.error; return; }
  box.innerHTML = "";
  if (!d.matches.length) { box.textContent = "No matches."; return; }
  for (const m of d.matches) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = m.path + ":" + m.line + "  " + m.text;
    row.onclick = async () => {
      await openFile(m.path);
      jumpToLine(m.line);
    };
    box.appendChild(row);
  }
  if (d.truncated) {
    const n = document.createElement("div");
    n.className = "dim";
    n.textContent = "(stopped at 200 matches)";
    box.appendChild(n);
  }
};
$("findReplace").onclick = async () => {
  const q = $("findQuery").value;
  if (!q) return;
  if (!confirm("Replace ALL occurrences of \"" + q + "\" across the " +
      "project? Open tabs keep their in-editor copy until reopened."))
    return;
  const d = await postJson("/api/replace", {
    query: q, replacement: $("findReplacement").value });
  if (d.error) { alert(d.error); return; }
  $("findResults").textContent =
    "Replaced " + d.replacements + " occurrence(s) in " +
    d.filesChanged + " file(s).";
  loadFiles();
};

/* ---------------- Phase 6: split view ----------------
   The split pane is a plain editor (no autocomplete - that stays in
   the main pane). It edits a split-local state; on save/close the
   text syncs back into the tab store, so the file's tab always
   shows the latest content. Switching a file between panes resets
   its undo history - a known, accepted trade. */
let splitView = null;
let splitFile = null;
let splitDirty = false;

function splitExtensions(path) {
  return [
    basicSetup,
    oneDark,
    wrapComp.of(wrapExt()),
    indentComp.of(indentExt()),
    wsComp.of(wsExt()),
    langFor(path || ""),
    keymap.of([
      { key: "Mod-s", run: () => { saveSplit(); return true; } },
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && splitFile) {
        splitDirty = true;
        tabDirty.set(splitFile, true);
        $("splitName").textContent = "● " + splitFile;
      }
    }),
  ];
}

function syncSplitBack() {
  if (!splitView || !splitFile) return;
  tabStates.set(splitFile, EditorState.create({
    doc: splitView.state.doc.toString(),
    extensions: baseExtensions(splitFile) }));
  tabDirty.set(splitFile, splitDirty);
}

async function openSplit(path) {
  if (!path) return;
  if (path === currentFile) {
    alert("That file is already in the main pane.");
    return;
  }
  if (splitFile === path) { if (splitView) splitView.focus(); return; }
  syncSplitBack();
  let docText;
  if (tabStates.has(path)) {
    docText = tabStates.get(path).doc.toString();
  } else {
    const r = await fetch("/api/file?path=" + encodeURIComponent(path));
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    if (d.content && d.content.length > 200000 &&
        !confirm(path + " is " + Math.round(d.content.length / 1024) +
          " KB - large files can make the editor sluggish. " +
          "Open it anyway?")) return;
    docText = d.content;
    tabOrder.push(path);
    tabStates.set(path, EditorState.create({
      doc: docText, extensions: baseExtensions(path) }));
    tabDirty.set(path, false);
    renderTabs();
  }
  splitFile = path;
  splitDirty = !!tabDirty.get(path);
  const st = EditorState.create({
    doc: docText, extensions: splitExtensions(path) });
  if (!splitView) {
    splitView = new EditorView({ state: st, parent: $("editor2") });
  } else {
    splitView.setState(st);
  }
  $("splitName").textContent = (splitDirty ? "● " : "") + path;
  $("splitCol").classList.remove("hidden");
  splitView.focus();
  noteRecentFile(path);
}

function closeSplit() {
  syncSplitBack();
  splitFile = null;
  splitDirty = false;
  $("splitCol").classList.add("hidden");
  if (splitView) {
    splitView.setState(EditorState.create({
      doc: "", extensions: splitExtensions(null) }));
  }
  renderTabs();
}

async function saveSplit() {
  if (!splitFile || !splitView) return;
  const d = await postJson("/api/file", {
    path: splitFile, content: splitView.state.doc.toString() });
  if (d.error) { alert(d.error); return; }
  splitDirty = false;
  tabDirty.set(splitFile, false);
  $("splitName").textContent = splitFile;
  try { localStorage.removeItem(draftKey(splitFile)); } catch (e) {}
  syncSplitBack();
  renderTabs();
}

$("splitBtn").onclick = () => {
  if (splitFile) { closeSplit(); return; }
  openQuick("split");
};
$("splitClose").onclick = () => closeSplit();
$("splitSave").onclick = () => saveSplit();

/* ---------------- Phase 6: quick open ---------------- */
let quickMode = "open";
let quickFiles = [];
let quickSymbols = [];
async function openQuick(mode) {
  quickMode = mode || "open";
  if (quickMode === "command") {
    $("quickInput").placeholder =
      "Type a command… (Enter runs, Esc closes)";
    $("quickInput").value = "";
    renderQuick("");
    $("quickPanel").classList.remove("hidden");
    $("quickInput").focus();
    return;
  }
  $("quickInput").placeholder =
    "Open file by name… (Enter opens, Esc closes)";
  if (quickMode === "mention")
    $("quickInput").placeholder = "Mention a file… (tap to insert @file)";
  try {
    const r = await fetch("/api/files");
    const d = await r.json();
    /* /api/files returns {path, type} objects on BOTH builds -
       map them to file path strings. Treating the entries as
       strings threw inside this try, silently emptying the list:
       Quick Open, the split picker and palette file commands all
       showed "No files match" (Phase 6-8 latent bug, fixed P9). */
    quickFiles = (d.files || [])
      .filter((f) => f.type === "file")
      .map((f) => f.path);
  } catch (e) { quickFiles = []; }
  $("quickInput").value = "";
  renderQuick("");
  $("quickPanel").classList.remove("hidden");
  $("quickInput").focus();
}
function closeQuick() { $("quickPanel").classList.add("hidden"); }
function noteRecentFile(p) {
  try {
    let arr = JSON.parse(
      localStorage.getItem("ghostide-recent-files") || "[]");
    arr = [p, ...arr.filter((x) => x !== p)].slice(0, 8);
    localStorage.setItem("ghostide-recent-files", JSON.stringify(arr));
  } catch (e) { /* best-effort */ }
}

function renderQuick(q) {
  const list = $("quickList");
  list.innerHTML = "";
  const needle = q.toLowerCase();
  if (quickMode === "command") {
    const matches = COMMANDS.filter((c) =>
      c.title.toLowerCase().includes(needle)).slice(0, 30);
    for (const c of matches) {
      const row = document.createElement("div");
      row.className = "findRow";
      row.textContent = "⌘ " + c.title;
      row.onclick = () => { closeQuick(); c.run(); };
      list.appendChild(row);
    }
    if (!matches.length)
      list.innerHTML = '<div class="dim">No commands match.</div>';
    return;
  }
  if (quickMode === "symbol") {
    const matches = quickSymbols.filter((s) =>
      s.name.toLowerCase().includes(needle)).slice(0, 30);
    for (const s of matches) {
      const row = document.createElement("div");
      row.className = "findRow";
      row.textContent = "ƒ " + s.name + "  · line " + s.line;
      row.onclick = () => { closeQuick(); jumpToLine(s.line); };
      list.appendChild(row);
    }
    if (!matches.length)
      list.innerHTML = '<div class="dim">No symbols in this file.</div>';
    return;
  }
  if (quickMode === "mention") {
    const matches = quickFiles
      .filter((f) => f.toLowerCase().includes(needle)).slice(0, 30);
    for (const f of matches) {
      const row = document.createElement("div");
      row.className = "findRow";
      row.textContent = "@ " + f;
      row.onclick = () => {
        closeQuick();
        const ta = $("chatText");
        ta.value += (ta.value && !ta.value.endsWith(" ") ? " " : "") +
          "@" + f + " ";
        ta.focus();
      };
      list.appendChild(row);
    }
    if (!matches.length)
      list.innerHTML = '<div class="dim">No files match.</div>';
    return;
  }
  let recents = [];
  try {
    recents = JSON.parse(
      localStorage.getItem("ghostide-recent-files") || "[]");
  } catch (e) { recents = []; }
  let ordered = quickFiles
    .filter((f) => f.toLowerCase().includes(needle));
  if (!needle) {
    const recentSet = recents.filter((p) => ordered.includes(p));
    ordered = [...recentSet,
               ...ordered.filter((f) => !recentSet.includes(f))];
  }
  const matches = ordered.slice(0, 30);
  for (const f of matches) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = (!needle && recents.includes(f) ? "🕘 " : "") + f;
    row.onclick = () => {
      closeQuick();
      if (quickMode === "split") openSplit(f);
      else openFile(f);
    };
    list.appendChild(row);
  }
  if (!matches.length)
    list.innerHTML = '<div class="dim">No files match.</div>';
}
$("quickInput").addEventListener("input",
  (e) => renderQuick(e.target.value));
$("quickInput").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeQuick();
  if (e.key === "Enter") {
    const first = $("quickList").querySelector(".findRow");
    if (first) first.click();
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if ($("quickPanel").classList.contains("hidden")) openQuick("open");
    else closeQuick();
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey &&
      e.key.toLowerCase() === "p") {
    e.preventDefault();
    if ($("quickPanel").classList.contains("hidden"))
      openQuick("command");
    else closeQuick();
  }
});
$("toolQuick").onclick = () => { hideTools(); openQuick("open"); };

/* ---------------- Phase 6: outline + go to line ---------------- */
function extractSymbols(text) {
  const res = [
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
    /^\s*class\s+([A-Za-z_]\w*)/,
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/,
    /^\s*(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/,
  ];
  const syms = [];
  text.split("\n").forEach((ln, i) => {
    for (const re of res) {
      const m = ln.match(re);
      if (m) { syms.push({ name: m[1], line: i + 1 }); break; }
    }
  });
  return syms;
}

$("toolOutline").onclick = () => {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  const syms = extractSymbols(view.state.doc.toString());
  $("todoTitle").textContent = "Outline: " + currentFile;
  const box = $("todoResults");
  box.innerHTML = "";
  if (!syms.length)
    box.textContent = "No functions or classes found in this file.";
  for (const s of syms) {
    const row = document.createElement("div");
    row.className = "todoRow";
    row.textContent = s.name + "  ·  line " + s.line;
    row.onclick = () => jumpToLine(s.line);
    box.appendChild(row);
  }
  $("todoPanel").classList.remove("hidden");
};
$("toolGoto").onclick = () => {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  const n = parseInt(prompt("Go to line:"), 10);
  if (n >= 1) jumpToLine(n);
};

/* ---------------- Phase 6: file menu additions ---------------- */
$("menuCopyPath").onclick = async () => {
  $("fileMenu").classList.add("hidden");
  if (!menuTarget) return;
  try {
    await navigator.clipboard.writeText(menuTarget.path);
  } catch (e) {
    prompt("Copy the path:", menuTarget.path);
  }
};
$("menuDownload").onclick = async () => {
  $("fileMenu").classList.add("hidden");
  if (!menuTarget) return;
  const r = await fetch("/api/file?path=" +
    encodeURIComponent(menuTarget.path));
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([d.content], { type: "text/plain" }));
  a.download = menuTarget.path.split("/").pop();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
$("menuSplit").onclick = () => {
  $("fileMenu").classList.add("hidden");
  if (menuTarget) openSplit(menuTarget.path);
};

/* ---------------- Phase 6: clear chat ---------------- */
$("clearChatBtn").onclick = () => {
  if (!confirm("Clear this project's chat history?")) return;
  history.length = 0;
  saveHistory();
  $("chatLog").innerHTML = "";
  addMsg("GHOST", GREETING);
};

/* ---------------- Phase 6: settings additions ---------------- */
$("setWrap").checked = settings.wrap;
$("setWrap").onchange = (e) => {
  settings.wrap = e.target.checked;
  saveSettings();
  const eff = { effects: wrapComp.reconfigure(wrapExt()) };
  view.dispatch(eff);
  if (splitView) splitView.dispatch(eff);
};
$("setShort").checked = settings.shortAnswers;
$("setShort").onchange = (e) => {
  settings.shortAnswers = e.target.checked;
  saveSettings();
};
$("setFont").value = settings.fontSize;
document.documentElement.style.setProperty(
  "--ghost-font", settings.fontSize);
$("setFont").onchange = (e) => {
  settings.fontSize = e.target.value;
  saveSettings();
  document.documentElement.style.setProperty(
    "--ghost-font", settings.fontSize);
};
$("setDelay").value = settings.infillDelay;
$("setDelay").onchange = (e) => {
  const n = parseInt(e.target.value, 10);
  if (n >= 300 && n <= 3000) {
    settings.infillDelay = n;
    saveSettings();
  }
};
$("setAutosave").value = settings.autosave || "off";
$("setAutosave").onchange = (e) => {
  settings.autosave = e.target.value;
  saveSettings();
};
$("setTrim").checked = !!settings.trimOnSave;
$("setTrim").onchange = (e) => {
  settings.trimOnSave = e.target.checked;
  saveSettings();
};
$("setIndent").value = String(settings.indent || 2);
$("setIndent").onchange = (e) => {
  settings.indent = parseInt(e.target.value, 10) || 2;
  saveSettings();
  view.dispatch({ effects: indentComp.reconfigure(indentExt()) });
};
$("setWs").checked = !!settings.whitespace;
$("setWs").onchange = (e) => {
  settings.whitespace = e.target.checked;
  saveSettings();
  view.dispatch({ effects: wsComp.reconfigure(wsExt()) });
};

/* ---------------- Tools pack ---------------- */
$("toolsBtn").onclick = () => $("toolsPanel").classList.toggle("hidden");
$("toolsClose").onclick = () => $("toolsPanel").classList.add("hidden");
function hideTools() { $("toolsPanel").classList.add("hidden"); }

/* AI quick actions: prompt templates over the selection or file. */
function codeForAi() {
  const sel = view.state.selection.main;
  const doc = view.state.doc.toString();
  const picked = sel.empty ? doc : doc.slice(sel.from, sel.to);
  return picked.slice(0, BEHAVIOR.context.fileChars);
}
function aiAction(kind) {
  if (!currentFile) { alert("Open a file first."); return; }
  const fence = "```\n" + codeForAi() + "\n```";
  const prompts = {
    explain: "Explain what this code from " + currentFile +
      " does, briefly, and flag anything risky or buggy:\n" + fence,
    fix: "Find and fix the bugs in this code from " + currentFile +
      ". Return the full corrected code, then one line per fix:\n" + fence,
    tests: "Write tests for this code from " + currentFile +
      " (pytest for Python, node:test for JS). Return the complete " +
      "test file only:\n" + fence,
    doc: "Add clear docstrings and comments to this code from " +
      currentFile + " without changing its behavior. Return the " +
      "full updated file:\n" + fence,
  };
  hideTools();
  $("chatText").value = prompts[kind];
  sendChat();
}
$("aiExplain").onclick = () => aiAction("explain");
$("aiFix").onclick = () => aiAction("fix");
$("aiTests").onclick = () => aiAction("tests");
$("aiDoc").onclick = () => aiAction("doc");

/* Preview: markdown rendered, images shown, code as text. */
function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
}
function renderMarkdown(src) {
  const lines = escHtml(src).split("\n");
  let html = "", inCode = false, inList = false;
  const inline = (t) => t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      html += inCode ? "</code></pre>" : "<pre><code>";
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += line + "\n"; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      if (inList) { html += "</ul>"; inList = false; }
      html += "<h" + h[1].length + ">" + inline(h[2]) +
              "</h" + h[1].length + ">";
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + inline(line.replace(/^\s*[-*]\s+/, "")) + "</li>";
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (line.trim()) html += "<p>" + inline(line) + "</p>";
  }
  if (inCode) html += "</code></pre>";
  if (inList) html += "</ul>";
  return html;
}
$("toolPreview").onclick = async () => {
  if (!currentFile) { alert("Open a file first."); return; }
  hideTools();
  $("previewTitle").textContent = "Preview: " + currentFile;
  const body = $("previewBody");
  const ext = (currentFile.split(".").pop() || "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"]
      .includes(ext)) {
    body.innerHTML = "";
    const img = document.createElement("img");
    img.src = "/api/raw?path=" + encodeURIComponent(currentFile);
    img.alt = currentFile;
    body.appendChild(img);
  } else {
    const r = await fetch("/api/file?path=" +
      encodeURIComponent(currentFile));
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    if (ext === "md" || ext === "markdown") {
      body.innerHTML = renderMarkdown(d.content);
    } else {
      body.innerHTML = "";
      const pre = document.createElement("pre");
      pre.textContent = d.content;
      body.appendChild(pre);
    }
  }
  $("previewPanel").classList.remove("hidden");
};
$("previewClose").onclick = () =>
  $("previewPanel").classList.add("hidden");

$("toolCheck").onclick = async () => {
  if (!currentFile) { alert("Open a file first."); return; }
  hideTools();
  $("runPane").classList.remove("hidden");
  $("runTitle").textContent = "Checking " + currentFile + " …";
  $("runOut").textContent = "";
  const d = await postJson("/api/check", { path: currentFile });
  if (d.error) {
    $("runTitle").textContent = "Check unavailable";
    $("runOut").textContent = d.error;
    return;
  }
  if (d.ok === null) {
    $("runTitle").textContent = "Check: no checker for this file type";
    $("runOut").textContent = d.output;
    return;
  }
  $("runTitle").textContent =
    (d.ok ? "✓ Syntax OK · " : "✗ Syntax problem · ") + currentFile;
  $("runOut").textContent = d.output;
};

$("toolDup").onclick = async () => {
  if (!currentFile) { alert("Open a file first."); return; }
  hideTools();
  const dot = currentFile.lastIndexOf(".");
  const slash = currentFile.lastIndexOf("/");
  const suggestion = dot > slash
    ? currentFile.slice(0, dot) + "-copy" + currentFile.slice(dot)
    : currentFile + "-copy";
  const name = prompt("Duplicate as:", suggestion);
  if (!name) return;
  const r = await fetch("/api/file?path=" +
    encodeURIComponent(currentFile));
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  const s = await postJson("/api/file", {
    path: name, content: d.content });
  if (s.error) { alert(s.error); return; }
  await loadFiles();
  openFile(name);
};

/* Snippets (local to this browser/app). */
let snippets = [];
try {
  snippets = JSON.parse(localStorage.getItem("ghostide-snippets")
    || "[]");
} catch (e) { snippets = []; }
function persistSnippets() {
  try {
    localStorage.setItem("ghostide-snippets", JSON.stringify(snippets));
  } catch (e) { /* best-effort */ }
}
function renderSnips() {
  const list = $("snipList");
  list.innerHTML = "";
  if (!snippets.length) {
    list.innerHTML = '<div class="dim">No snippets yet.</div>';
    return;
  }
  snippets.forEach((sn, i) => {
    const row = document.createElement("div");
    row.className = "snipRow";
    const label = document.createElement("span");
    label.textContent = sn.name;
    label.title = "Insert at cursor";
    label.onclick = () => {
      const sel = view.state.selection.main;
      view.dispatch({ changes: {
        from: sel.from, to: sel.to, insert: sn.body },
        selection: { anchor: sel.from + sn.body.length } });
      view.focus();
      $("snipPanel").classList.add("hidden");
    };
    const del = document.createElement("button");
    del.textContent = "✕";
    del.onclick = () => {
      snippets.splice(i, 1);
      persistSnippets();
      renderSnips();
    };
    row.appendChild(label);
    row.appendChild(del);
    list.appendChild(row);
  });
}
$("toolSnippets").onclick = () => {
  hideTools();
  renderSnips();
  $("snipPanel").classList.remove("hidden");
};
$("snipClose").onclick = () => $("snipPanel").classList.add("hidden");
$("snipAdd").onclick = () => {
  const sel = view.state.selection.main;
  const body = sel.empty
    ? view.state.doc.toString()
    : view.state.doc.sliceString(sel.from, sel.to);
  if (!body.trim()) { alert("Nothing to save - open a file first."); return; }
  const name = $("snipName").value.trim()
    || ("snippet " + (snippets.length + 1));
  snippets.push({ name, body });
  persistSnippets();
  $("snipName").value = "";
  renderSnips();
};

/* TODO scan */
$("toolTodos").onclick = async () => {
  hideTools();
  $("todoTitle").textContent = "TODO / FIXME";
  const box = $("todoResults");
  box.textContent = "scanning…";
  $("todoPanel").classList.remove("hidden");
  const r = await fetch("/api/todos");
  const d = await r.json();
  if (d.error) { box.textContent = d.error; return; }
  box.innerHTML = "";
  if (!d.todos.length) {
    box.textContent = "No TODO / FIXME / XXX / HACK markers. Clean!";
    return;
  }
  for (const t of d.todos) {
    const row = document.createElement("div");
    row.className = "todoRow";
    const b = document.createElement("b");
    b.textContent = t.kind;
    row.appendChild(b);
    row.appendChild(document.createTextNode(
      " " + t.path + ":" + t.line + "  " + t.text));
    row.title = t.text;
    row.onclick = async () => {
      await openFile(t.path);
      jumpToLine(t.line);
    };
    box.appendChild(row);
  }
};
$("todoClose").onclick = () => $("todoPanel").classList.add("hidden");

/* Project stats */
$("toolStats").onclick = async () => {
  const out = $("statsOut");
  out.textContent = "counting…";
  const r = await fetch("/api/stats");
  const d = await r.json();
  if (d.error) { out.textContent = d.error; return; }
  const exts = Object.entries(d.byExt)
    .sort((a, b) => b[1].lines - a[1].lines).slice(0, 6)
    .map(([e, s]) => e + ": " + s.files + " files, " +
         s.lines.toLocaleString() + " lines")
    .join("\n");
  out.textContent =
    d.files + " files · " + d.lines.toLocaleString() + " lines · " +
    (d.bytes / 1048576).toFixed(2) + " MB\n" + exts;
};

/* Save the current context slice as a workspace file. */
$("toolSlice").onclick = async () => {
  hideTools();
  const mode = $("ctxMode").value === "file"
    ? "signatures" : $("ctxMode").value;
  const d = await postJson("/api/context", {
    mode, budget: BEHAVIOR.context.sliceBudget });
  if (d.error) { alert(d.error); return; }
  if (d.over) {
    alert("Slice is ~" + d.tokens + " tokens - over budget, not saved.");
    return;
  }
  const content = "# GhostIDE project slice (" + d.mode + ")\n" +
    "<!-- " + d.tokens + " of ~" + d.originalTokens +
    " tokens · " + d.files + " files · saved from the Tools panel -->\n\n" +
    d.text;
  const s = await postJson("/api/file", {
    path: ".ghostide-context.md", content });
  if (s.error) { alert(s.error); return; }
  await loadFiles();
  alert("Saved .ghostide-context.md (" + d.tokens.toLocaleString() +
    " tokens, " + d.files + " files).");
};

/* Terminal (desktop shell in the workspace). */
const termHistory = [];
let termIdx = -1;
$("toolTerminal").onclick = () => {
  hideTools();
  $("termPane").classList.remove("hidden");
  $("termCmd").focus();
};
$("termClose").onclick = () => $("termPane").classList.add("hidden");
async function runTerm() {
  const input = $("termCmd");
  const cmd = input.value.trim();
  if (!cmd) return;
  termHistory.unshift(cmd);
  termIdx = -1;
  input.value = "";
  const out = $("termOut");
  out.textContent += "$ " + cmd + "\n";
  out.scrollTop = out.scrollHeight;
  const d = await postJson("/api/terminal", { command: cmd });
  if (d.error) {
    out.textContent += d.error +
      "\n(The terminal runs on the desktop build.)\n";
  } else {
    out.textContent += (d.stdout || "") + (d.stderr || "") +
      "[exit " + d.code + " · " + d.ms + " ms]\n";
  }
  out.scrollTop = out.scrollHeight;
}
$("termCmd").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { runTerm(); }
  else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (termIdx < termHistory.length - 1) {
      termIdx++;
      $("termCmd").value = termHistory[termIdx];
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    termIdx = Math.max(-1, termIdx - 1);
    $("termCmd").value = termIdx >= 0 ? termHistory[termIdx] : "";
  }
});

/* ---------------- Phase 7: editor + chat extras ---------------- */
$("toolFindFile").onclick = () => {
  hideTools();
  openSearchPanel(view);
  view.focus();
};
$("toolFold").onclick = () => { hideTools(); foldAll(view); };
$("toolUnfold").onclick = () => { hideTools(); unfoldAll(view); };

function transformDoc(fn) {
  if (!currentFile) { alert("Open a file first."); return; }
  hideTools();
  const doc = view.state.doc.toString();
  const out = fn(doc);
  if (out === doc) { alert("Nothing changed."); return; }
  accepting = true;
  view.dispatch({ changes: {
    from: 0, to: view.state.doc.length, insert: out } });
  accepting = false;
  view.focus();
}
$("toolSort").onclick = () =>
  transformDoc((d) => d.split("\n").sort().join("\n"));
$("toolDedupe").onclick = () =>
  transformDoc((d) => [...new Set(d.split("\n"))].join("\n"));
$("toolTrim").onclick = () =>
  transformDoc((d) => d.split("\n")
    .map((l) => l.replace(/\s+$/, "")).join("\n"));
$("toolCase").onclick = () => {
  hideTools();
  const sel = view.state.selection.main;
  if (sel.empty) { alert("Select some text first."); return; }
  const text = view.state.doc.sliceString(sel.from, sel.to);
  const out = text === text.toUpperCase()
    ? text.toLowerCase() : text.toUpperCase();
  accepting = true;
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: out },
                  selection: { anchor: sel.from,
                               head: sel.from + out.length } });
  accepting = false;
  view.focus();
};

$("toolRegen").onclick = () => {
  hideTools();
  if (chatAbort) { alert("Wait for the current answer to finish."); return; }
  if (history.length &&
      history[history.length - 1].role === "assistant")
    history.pop();
  let idx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") { idx = i; break; }
  }
  if (idx < 0) { alert("Nothing to regenerate yet."); return; }
  const lastUser = history[idx];
  history.splice(idx, 1);
  saveHistory();
  loadHistory();
  $("chatText").value = lastUser.content;
  sendChat();
};

$("toolExportChat").onclick = async () => {
  hideTools();
  if (!history.length) { alert("No chat to export yet."); return; }
  const md = "# GhostIDE chat export\n\n" + history.map((m) =>
    (m.role === "user" ? "**You:** " : "**Ghost:** ") + m.content)
    .join("\n\n---\n\n") + "\n";
  const name = "chat-export-" +
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".md";
  const d = await postJson("/api/file", { path: name, content: md });
  if (d.error) { alert(d.error); return; }
  await loadFiles();
  alert("Chat saved to " + name + " in the workspace.");
};

$("toolZip").onclick = async () => {
  hideTools();
  try {
    const r = await fetch("/api/export-zip");
    const ct = r.headers.get("Content-Type") || "";
    if (ct.includes("application/json")) {
      const d = await r.json();
      alert(d.error || "Zip export unavailable here.");
      return;
    }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ghostide-workspace.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) {
    alert("Zip export failed: " + e);
  }
};

/* ---------------- Phase 8: VS Code / Cursor round ----------------
   One-shot chat collect (used by inline AI + the commit message
   writer): POSTs to /api/chat and concatenates the streamed
   deltas instead of rendering into the chat log. */
async function collectChat(messages, maxTokens) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages, temperature: 0.3,
      max_tokens: maxTokens || 1024 }),
  });
  const text = await r.text();
  let out = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    try {
      const j = JSON.parse(data);
      out += (j.choices && j.choices[0] && j.choices[0].delta &&
              j.choices[0].delta.content) || "";
    } catch (e) { /* partial line */ }
  }
  return out;
}

async function formatCurrentFile() {
  if (!currentFile) { alert("Open a file first."); return; }
  if (dirty) {
    alert("Save first - the formatter works on the saved file.");
    return;
  }
  const d = await postJson("/api/format", { path: currentFile });
  if (d.error) { alert(d.error); return; }
  if (!d.formatted) {
    alert(d.reason || "No formatter available for this file.");
    return;
  }
  const r = await fetch("/api/file?path=" +
    encodeURIComponent(currentFile));
  const fd = await r.json();
  if (!fd.error && fd.content !== view.state.doc.toString()) {
    accepting = true;
    view.dispatch({ changes: {
      from: 0, to: view.state.doc.length, insert: fd.content } });
    accepting = false;
    setSaveState("formatted ✓ " + new Date().toLocaleTimeString());
  }
}

/* Problems panel: syntax check rendered as a list, tap to jump. */
async function runProblems() {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  $("todoTitle").textContent = "Problems: " + currentFile;
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Checking…</div>';
  $("todoPanel").classList.remove("hidden");
  const d = await postJson("/api/check", { path: currentFile });
  box.innerHTML = "";
  if (d.error) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = d.error;
    box.appendChild(el);
    return;
  }
  if (d.ok === null || d.ok === undefined) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = d.output || "No checker available.";
    box.appendChild(el);
    return;
  }
  if (d.ok) {
    const el = document.createElement("div");
    el.className = "findRow";
    el.textContent = "✓ No problems found";
    box.appendChild(el);
    return;
  }
  const row = document.createElement("div");
  row.className = "findRow";
  row.textContent = "✖ " + (d.line ? "Line " + d.line + " — " : "") +
    (d.message || "syntax error");
  row.onclick = () => { if (d.line) jumpToLine(d.line); };
  box.appendChild(row);
  const fix = document.createElement("div");
  fix.className = "findRow";
  fix.textContent = "✨ Fix with AI";
  fix.onclick = () => {
    if (!modelUp) { alert("Start the model first."); return; }
    $("todoPanel").classList.add("hidden");
    inlineTarget = { from: 0, to: view.state.doc.length };
    $("inlineAiInput").value = "Fix this problem: " +
      (d.message || "syntax error") +
      (d.line ? " (line " + d.line + ")" : "");
    runInlineAi();
  };
  box.appendChild(fix);
  if (d.output) {
    const pre = document.createElement("pre");
    pre.className = "dim";
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = d.output;
    box.appendChild(pre);
  }
}
$("toolCheck").onclick = runProblems;

/* Status bar TODO chip. */
async function refreshTodoChip() {
  try {
    const r = await fetch("/api/todos");
    const d = await r.json();
    const n = (d.todos || []).length;
    const chip = $("todoChip");
    chip.textContent = "TODO " + n;
    chip.classList.toggle("hidden", n === 0);
  } catch (e) { /* server not up yet */ }
}
$("todoChip").onclick = () => $("toolTodos").click();

/* AI commit message from the diff (desktop git). */
$("gitAiMsg").onclick = async () => {
  const btn = $("gitAiMsg");
  if (!modelUp) { alert("Start the model first."); return; }
  btn.disabled = true;
  btn.textContent = "✨ …";
  try {
    const r = await fetch("/api/git/diff-all");
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    if (!d.diff || !d.diff.trim()) {
      alert("No changes to describe yet.");
      return;
    }
    const msg = await collectChat([
      { role: "system", content: "You write git commit messages. "
        + "Reply with ONE short commit message line only - no "
        + "quotes, no explanation." },
      { role: "user", content: "Write a commit message for this "
        + "diff:\n\n" + d.diff.slice(0, 6000) }], 60);
    const clean = msg.trim().split("\n")[0]
      .replace(/^["'`]+|["'`]+$/g, "");
    if (clean) $("commitMsg").value = clean;
    else alert("Ghost did not suggest a message.");
  } catch (e) {
    alert("AI message failed: " + e);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ AI";
  }
};

/* Inline AI edit (Cursor-style): describe a change to the
   selection (or the whole file), review Ghost's rewrite, apply. */
let inlineTarget = null;
let inlineResult = "";
function startInlineAi() {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  if (!modelUp) { alert("Start the model first."); return; }
  const sel = view.state.selection.main;
  inlineTarget = sel.empty
    ? { from: 0, to: view.state.doc.length }
    : { from: sel.from, to: sel.to };
  $("inlineAiInput").value = "";
  $("inlineAiReview").classList.add("hidden");
  $("inlineAiBar").classList.remove("hidden");
  $("inlineAiInput").focus();
}
$("aiInline").onclick = startInlineAi;
$("inlineAiClose").onclick = () =>
  $("inlineAiBar").classList.add("hidden");
async function runInlineAi() {
  const instr = $("inlineAiInput").value.trim();
  if (!instr || !inlineTarget) return;
  const code = view.state.doc.sliceString(
    inlineTarget.from, inlineTarget.to);
  $("inlineAiBar").classList.add("hidden");
  $("inlineAiOut").textContent = "Ghost is rewriting…";
  $("inlineAiApply").disabled = true;
  $("inlineAiReview").classList.remove("hidden");
  try {
    let out = await collectChat([
      { role: "system", content: BEHAVIOR.systemPrompt },
      { role: "user", content: "Rewrite the code below following "
        + "this instruction. Reply with ONLY the rewritten code - "
        + "no explanations, no markdown fences.\n\nInstruction: "
        + instr + "\n\nCode:\n" + code }], 1024);
    out = (out || "").trim();
    const fence = out.match(/^```\w*\n([\s\S]*?)```$/);
    if (fence) out = fence[1];
    inlineResult = out;
    $("inlineAiOut").textContent = out || "(empty reply)";
    $("inlineAiApply").disabled = !out;
  } catch (e) {
    $("inlineAiOut").textContent = "Failed: " + e;
  }
}
$("inlineAiGo").onclick = runInlineAi;
$("inlineAiInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runInlineAi();
  if (e.key === "Escape") $("inlineAiBar").classList.add("hidden");
});
$("inlineAiApply").onclick = () => {
  if (!inlineTarget) return;
  const to = Math.min(inlineTarget.to, view.state.doc.length);
  const from = Math.min(inlineTarget.from, to);
  accepting = true;
  view.dispatch({ changes: { from, to, insert: inlineResult },
                  selection: { anchor: from } });
  accepting = false;
  $("inlineAiReview").classList.add("hidden");
  inlineTarget = null;
  view.focus();
};
$("inlineAiDiscard").onclick = () => {
  $("inlineAiReview").classList.add("hidden");
  inlineTarget = null;
};

/* Command palette (Ctrl+Shift+P): every action, one list. Runs
   LAST in the module so every handler it points at exists. */
const COMMANDS = [
  { title: "Open file by name…", run: () => openQuick("open") },
  { title: "Open file in split pane…", run: () => openQuick("split") },
  { title: "Save file", run: () => saveFile() },
  { title: "Format document", run: () => formatCurrentFile() },
  { title: "AI: edit selection with a prompt…", run: () => startInlineAi() },
  { title: "AI: explain selection or file", run: () => $("aiExplain").click() },
  { title: "AI: find + fix bugs", run: () => $("aiFix").click() },
  { title: "AI: write tests", run: () => $("aiTests").click() },
  { title: "AI: add docstrings", run: () => $("aiDoc").click() },
  { title: "Check syntax (Problems)", run: () => runProblems() },
  { title: "Preview file", run: () => $("toolPreview").click() },
  { title: "Find in file", run: () => $("toolFindFile").click() },
  { title: "Find in project", run: () => $("findBtn").click() },
  { title: "Go to line", run: () => $("toolGoto").click() },
  { title: "Outline (functions and classes)", run: () => $("toolOutline").click() },
  { title: "Go to symbol…", run: () => openSymbols() },
  { title: "Go to definition", run: () => $("toolDef").click() },
  { title: "Rename symbol…", run: () => $("toolRename").click() },
  { title: "Reopen closed tab", run: () => {
      const p = closedStack.pop();
      if (p) openFile(p);
      else alert("No closed tab to reopen.");
    } },
  { title: "Bookmarks", run: () => { hideTools(); renderBookmarks(); } },
  { title: "Toggle focus mode (hide side panels)", run: () => toggleZen() },
  { title: "TODO / FIXME scan", run: () => $("toolTodos").click() },
  { title: "Project stats", run: () => $("toolStats").click() },
  { title: "Terminal", run: () => $("toolTerminal").click() },
  { title: "Snippets", run: () => $("toolSnippets").click() },
  { title: "Regenerate chat answer", run: () => $("toolRegen").click() },
  { title: "Export chat as file", run: () => $("toolExportChat").click() },
  { title: "Download workspace (.zip)", run: () => $("toolZip").click() },
  { title: "Close split pane", run: () => $("splitClose").click() },
  { title: "Toggle word wrap", run: () => {
      const c = $("setWrap");
      c.checked = !c.checked;
      c.onchange({ target: c });
    } },
  { title: "Toggle autocomplete", run: () => {
      const c = $("setAuto");
      c.checked = !c.checked;
      c.onchange({ target: c });
    } },
  { title: "Settings", run: () => $("settingsBtn").click() },
  { title: "Tools panel", run: () => $("toolsBtn").click() },
];
$("toolPalette").onclick = () => { hideTools(); openQuick("command"); };
refreshTodoChip();

/* ---------------- Phase 9: tree, symbols, mentions, zen,
   bookmarks, quiet problems ---------------- */
function toggleZen() {
  document.body.classList.toggle("zen");
}
$("zenBtn").onclick = toggleZen;

function openSymbols() {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  quickMode = "symbol";
  quickSymbols = extractSymbols(view.state.doc.toString());
  $("quickInput").placeholder =
    "Go to symbol in " + currentFile + "… (Esc closes)";
  $("quickInput").value = "";
  renderQuick("");
  $("quickPanel").classList.remove("hidden");
  $("quickInput").focus();
}
$("toolSymbols").onclick = openSymbols;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey &&
      e.key.toLowerCase() === "o") {
    e.preventDefault();
    if ($("quickPanel").classList.contains("hidden")) openSymbols();
    else closeQuick();
  }
});
$("mentionBtn").onclick = () => openQuick("mention");

/* Bookmarks: per-file line numbers in localStorage. */
function loadBookmarks() {
  try {
    return JSON.parse(
      localStorage.getItem("ghostide-bookmarks") || "{}");
  } catch (e) { return {}; }
}
function saveBookmarks(b) {
  try {
    localStorage.setItem("ghostide-bookmarks", JSON.stringify(b));
  } catch (e) { /* best-effort */ }
}
function renderBookmarks() {
  $("todoTitle").textContent = "Bookmarks";
  const box = $("todoResults");
  box.innerHTML = "";
  $("todoPanel").classList.remove("hidden");
  if (currentFile) {
    const ln = view.state.doc.lineAt(
      view.state.selection.main.head).number;
    const has = (loadBookmarks()[currentFile] || []).includes(ln);
    const t = document.createElement("div");
    t.className = "findRow";
    t.textContent = (has ? "✕ Remove bookmark at" : "🔖 Bookmark") +
      " — " + currentFile + " line " + ln;
    t.onclick = () => {
      const bb = loadBookmarks();
      const arr = bb[currentFile] || [];
      const i = arr.indexOf(ln);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(ln);
      arr.sort((a, b) => a - b);
      if (arr.length) bb[currentFile] = arr;
      else delete bb[currentFile];
      saveBookmarks(bb);
      renderBookmarks();
    };
    box.appendChild(t);
  }
  const b = loadBookmarks();
  let any = false;
  for (const path of Object.keys(b).sort()) {
    for (const line of b[path]) {
      any = true;
      const row = document.createElement("div");
      row.className = "findRow";
      row.textContent = "🔖 " + path + " · line " + line;
      row.onclick = async () => {
        $("todoPanel").classList.add("hidden");
        await openFile(path);
        jumpToLine(line);
      };
      box.appendChild(row);
    }
  }
  if (!any)
    box.insertAdjacentHTML("beforeend",
      '<div class="dim">No bookmarks yet - open a file and '
      + 'bookmark the current line from here.</div>');
}
$("toolBookmarks").onclick = () => { hideTools(); renderBookmarks(); };

/* Quiet problems check after save (desktop checkers only; the
   phone's stub answers ok:null and the chip stays hidden). */
async function checkQuiet() {
  const chip = $("probChip");
  if (!currentFile || !/\.(py|js|mjs|json)$/i.test(currentFile)) {
    chip.classList.add("hidden");
    return;
  }
  try {
    const d = await postJson("/api/check", { path: currentFile });
    if (d && d.ok === false) {
      chip.textContent = "⚠ problem" +
        (d.line ? " · line " + d.line : "");
      chip.classList.remove("hidden");
      chip.onclick = () => runProblems();
    } else {
      chip.classList.add("hidden");
    }
  } catch (e) {
    chip.classList.add("hidden");
  }
}

/* ---------------- Phase 10: breadcrumbs, session restore,
   rename symbol, go to definition, code-from-comment -------- */
function wordAtCursor() {
  const pos = view.state.selection.main.head;
  const doc = view.state.doc;
  const isWord = (ch) => /[A-Za-z0-9_$]/.test(ch);
  let from = pos;
  let to = pos;
  while (from > 0 && isWord(doc.sliceString(from - 1, from))) from--;
  while (to < doc.length && isWord(doc.sliceString(to, to + 1))) to++;
  return { word: doc.sliceString(from, to), from, to };
}

function updateCrumbs() {
  const el = $("crumbs");
  if (!el) return;
  if (!currentFile) { el.textContent = ""; return; }
  let out = currentFile.split("/").join(" › ");
  try {
    const lineNo = view.state.doc.lineAt(
      view.state.selection.main.head).number;
    const syms = extractSymbols(view.state.doc.toString());
    let cur = null;
    for (const s of syms) {
      if (s.line <= lineNo) cur = s;
      else break;
    }
    if (cur) out += " › ƒ " + cur.name;
  } catch (e) { /* crumbs are decorative */ }
  el.textContent = out;
}

/* Session restore: the open tabs + current file persist locally
   and reopen on launch (paths that no longer exist are skipped). */
function saveSession() {
  try {
    localStorage.setItem("ghostide-session", JSON.stringify({
      tabs: [...tabOrder], current: currentFile }));
  } catch (e) { /* best-effort */ }
}
(async () => {
  try {
    const s = JSON.parse(
      localStorage.getItem("ghostide-session") || "null");
    if (!s || !s.tabs || !s.tabs.length) return;
    const fr = await fetch("/api/files");
    const fd = await fr.json();
    const known = new Set((fd.files || [])
      .filter((x) => x.type === "file").map((x) => x.path));
    for (const p of s.tabs) {
      if (known.has(p)) await openFile(p, true);
    }
    if (s.current && known.has(s.current) &&
        tabOrder.includes(s.current) && s.current !== currentFile) {
      stashTab();
      activateTab(s.current);
    }
  } catch (e) { /* restore is best-effort */ }
})();

$("toolRename").onclick = async () => {
  hideTools();
  const w = wordAtCursor();
  if (!w.word) {
    alert("Put the cursor on a name (function, variable) first.");
    return;
  }
  if (dirty) {
    alert("Save your changes first - rename works on the saved "
      + "files, and your open edits would go stale.");
    return;
  }
  const nn = prompt("Rename symbol '" + w.word + "' to:", w.word);
  if (!nn || nn === w.word) return;
  const d = await postJson("/api/rename-symbol",
    { word: w.word, replacement: nn });
  if (d.error) { alert(d.error); return; }
  alert("Renamed " + d.replacements + " occurrence(s) in " +
    d.filesChanged + " file(s).");
  if (currentFile && d.filesChanged &&
      view.state.doc.toString().includes(w.word)) {
    /* Reload the current buffer from disk (it changed). Drop its
       tab first so openFile does not duplicate it. */
    const path = currentFile;
    const ti = tabOrder.indexOf(path);
    if (ti >= 0) tabOrder.splice(ti, 1);
    tabStates.delete(path);
    tabDirty.set(path, false);
    currentFile = null;
    await openFile(path, true);
  }
  loadFiles();
};

$("toolDef").onclick = async () => {
  hideTools();
  const w = wordAtCursor();
  if (!w.word) {
    alert("Put the cursor on a name first.");
    return;
  }
  const pats = ["def " + w.word, "class " + w.word,
    "function " + w.word, "const " + w.word + " =",
    "let " + w.word + " =", "var " + w.word + " =",
    w.word + " = function", w.word + ": function"];
  let hits = [];
  for (const q of pats) {
    const d = await postJson("/api/search", { query: q });
    if (d.matches && d.matches.length) {
      hits = d.matches;
      break;
    }
  }
  const seen = new Set();
  hits = hits.filter((h) => {
    const k = h.path + ":" + h.line;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!hits.length) {
    alert("No definition found for '" + w.word + "' (looked for "
      + "def / class / function lines - it is a simple search, "
      + "not a language server).");
    return;
  }
  if (hits.length === 1) {
    const h = hits[0];
    if (h.path !== currentFile) await openFile(h.path);
    jumpToLine(h.line);
    return;
  }
  $("todoTitle").textContent = "Definitions of " + w.word;
  const box = $("todoResults");
  box.innerHTML = "";
  for (const h of hits) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = h.path + " · line " + h.line;
    row.onclick = async () => {
      $("todoPanel").classList.add("hidden");
      if (h.path !== currentFile) await openFile(h.path);
      jumpToLine(h.line);
    };
    box.appendChild(row);
  }
  $("todoPanel").classList.remove("hidden");
};

$("menuCopyContents").onclick = async () => {
  $("fileMenu").classList.add("hidden");
  if (!menuTarget || menuTarget.type === "dir") return;
  const r = await fetch("/api/file?path=" +
    encodeURIComponent(menuTarget.path));
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  try {
    await navigator.clipboard.writeText(d.content || "");
  } catch (e) {
    prompt("Copy the contents:", d.content || "");
  }
};

/* Write code from a comment: Ghost drafts the code the comment
   describes; the shared review panel gates insertion. */
$("aiWrite").onclick = async () => {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  if (!modelUp) { alert("Start the model first."); return; }
  const head = view.state.selection.main.head;
  const lineNo = view.state.doc.lineAt(head).number;
  let comment = "";
  let commentLine = lineNo;
  for (let n = lineNo; n >= Math.max(1, lineNo - 3); n--) {
    const t = view.state.doc.line(n).text.trim();
    if (/^(#|\/\/|\/\*|\*)/.test(t)) {
      comment = t.replace(/^(#|\/\/|\/\*+|\*+)\s?/, "").trim();
      if (comment) { commentLine = n; break; }
    }
  }
  if (!comment) {
    alert("Put the cursor on (or just under) a comment that "
      + "describes the code you want.");
    return;
  }
  const lineObj = view.state.doc.line(commentLine);
  inlineTarget = { from: lineObj.to, to: lineObj.to };
  $("inlineAiOut").textContent = "Ghost is writing…";
  $("inlineAiApply").disabled = true;
  $("inlineAiReview").classList.remove("hidden");
  try {
    let out = await collectChat([
      { role: "system", content: BEHAVIOR.systemPrompt },
      { role: "user", content: "Write the code described by this "
        + "comment. Reply with ONLY the code - no explanations, "
        + "no markdown fences.\nFile: " + currentFile
        + "\nComment: " + comment }], 768);
    out = (out || "").trim();
    const fence = out.match(/^```\w*\n([\s\S]*?)```$/);
    if (fence) out = fence[1];
    inlineResult = out ? "\n" + out : "";
    $("inlineAiOut").textContent = out || "(empty reply)";
    $("inlineAiApply").disabled = !out;
  } catch (e) {
    $("inlineAiOut").textContent = "Failed: " + e;
  }
};

/* ---------------- boot ---------------- */
loadFiles();
refreshWsLabel();
/* Reaching this line proves the whole bundle evaluated without a
   startup crash - tell the watchdog in index.html, and surface
   anything the error trap caught on the way up. */
window.__ghostBooted = true;
if (window.__ghostErrs && window.__ghostErrs.length &&
    typeof __ghostShowErrs === "function") __ghostShowErrs();
