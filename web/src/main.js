import { EditorView, keymap, Decoration, WidgetType,
  highlightWhitespace, gutter, GutterMarker } from "@codemirror/view";
import { EditorState, StateEffect, StateField, Prec, Compartment,
  RangeSet, EditorSelection } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { indentWithTab, toggleComment, copyLineDown, moveLineUp,
  moveLineDown, deleteLine } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { oneDark } from "@codemirror/theme-one-dark";
import { openSearchPanel, selectNextOccurrence } from "@codemirror/search";
import { snippet } from "@codemirror/autocomplete";
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
    repoMap: false, testOnSave: false,
    autosave: "off", trimOnSave: false, indent: 2,
    whitespace: false },
  JSON.parse(localStorage.getItem("ghostide-settings") || "{}"));
function saveSettings() {
  localStorage.setItem("ghostide-settings", JSON.stringify(settings));
}

/* ---------------- Roadmap G7: breakpoints ---------------- */
const breakpoints = new Map();
try {
  const saved = JSON.parse(
    localStorage.getItem("ghostide-breakpoints") || "{}");
  for (const k of Object.keys(saved))
    breakpoints.set(k, new Set(saved[k]));
} catch (e) {}
function saveBreakpoints() {
  try {
    const o = {};
    for (const [k, v] of breakpoints) o[k] = [...v];
    localStorage.setItem("ghostide-breakpoints",
      JSON.stringify(o));
  } catch (e) {}
}
const bpBump = StateEffect.define();
const bpVersion = StateField.define({
  create: () => 0,
  update: (v, tr) => tr.effects.some((e) => e.is(bpBump))
    ? v + 1 : v,
});
class BpMarker extends GutterMarker {
  toDOM() {
    const s = document.createElement("span");
    s.className = "bpDot";
    s.textContent = "●";
    return s;
  }
}
const bpMarker = new BpMarker();
function toggleBreakpoint(line) {
  if (!currentFile) return;
  let set = breakpoints.get(currentFile);
  if (!set) { set = new Set(); breakpoints.set(currentFile, set); }
  if (set.has(line)) set.delete(line); else set.add(line);
  saveBreakpoints();
  view.dispatch({ effects: bpBump.of(null) });
}
const bpGutter = gutter({
  class: "cm-bp-gutter",
  markers: (v) => {
    void v.state.field(bpVersion, false);
    const set = breakpoints.get(currentFile);
    if (!set || !set.size) return RangeSet.empty;
    const marks = [];
    for (const ln of set) {
      if (ln >= 1 && ln <= v.state.doc.lines)
        marks.push(bpMarker.range(v.state.doc.line(ln).from));
    }
    marks.sort((a, b) => a.from - b.from);
    return RangeSet.of(marks);
  },
  domEventHandlers: {
    mousedown: (v, line, event) => {
      toggleBreakpoint(v.state.doc.lineAt(line.from).number);
      return true;
    },
  },
});

/* ---------------- editor ---------------- */
function langFor(path) {
  if (/\.tsx?$/.test(path)) return javascript({ typescript: true });
  if (/\.jsx?$/.test(path)) return javascript({ jsx: true });
  if (/\.py$/.test(path)) return python();
  if (/\.html?$/.test(path)) return html();
  if (/\.css$/.test(path)) return css();
  if (/\.json$/.test(path)) return json();
  if (/\.md$/.test(path)) return markdown();
  if (/\.sql$/.test(path)) return sql();
  if (/\.rs$/.test(path)) return rust();
  if (/\.go$/.test(path)) return go();
  return null;
}

/* Roadmap G21: file-tree icons that tell languages apart. */
function fileIcon(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return {
    py: "🐍", js: "🟨", mjs: "🟨", ts: "🟦", tsx: "🟦", jsx: "🟨",
    html: "🌐", htm: "🌐", css: "🎨", json: "🧾", md: "📝",
    sql: "🗄️", rs: "🦀", go: "🐹", sh: "⌨️",
  }[ext] || "📄";
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
    bpVersion,
    bpGutter,
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
      /* Roadmap G31: multi-cursor pack completion -
         add cursor above/below and select all occurrences
         (Mod-d step-by-step and Mod-Shift-d for all). */
      { key: "Mod-Alt-ArrowUp", run: (v) => addCursorLine(v, -1) },
      { key: "Mod-Alt-ArrowDown", run: (v) => addCursorLine(v, 1) },
      { key: "Mod-Shift-d", run: selectAllOccurrences },
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
      el.textContent = fileIcon(f.path) + " " + baseName;
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
  if (/\.(db|sqlite3?)$/i.test(path)) { openDbStudio(path); return; }
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
  pairNoteOpened(path, d.content);
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
  if (await pairGuardSave()) return;
  await fetch("/api/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: currentFile, content: view.state.doc.toString() }),
  });
  pairNoteSaved();
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
  maybeRunTestsOnSave(currentFile);
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
$("settingsBtn").onclick = () => {
  $("settingsPanel").classList.toggle("hidden");
  refreshModelDl();
};
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

/* ---------------- Roadmap G18: update check + model download ----
   The update check only ever REPORTS; it never downloads
   or installs anything by itself. */
$("setUpdateBtn").onclick = async () => {
  const out = $("setUpdateOut");
  out.textContent = "checking…";
  try {
    const r = await fetch("/api/update/check");
    const d = await r.json();
    if (d.current)
      $("setVersion").textContent = "v" + d.current;
    if (!d.ok) {
      out.textContent = d.note || d.error || "check failed";
      return;
    }
    out.innerHTML = "";
    out.appendChild(document.createTextNode(
      d.updateAvailable
        ? "Update available: v" + d.latest + ". "
        : "You are up to date. "));
    if (d.updateAvailable && d.url) {
      const a = document.createElement("a");
      a.href = d.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Get it";
      out.appendChild(a);
      out.appendChild(document.createTextNode(
        " (updates are never installed automatically)"));
    }
  } catch (e) {
    out.textContent = "check failed (offline?)";
  }
};

let modelDlTimer = null;
async function refreshModelDl() {
  try {
    const r = await fetch("/api/model/download");
    const d = await r.json();
    const out = $("setModelDlOut");
    const btn = $("setModelDlBtn");
    if (d.note) {
      out.textContent = d.note;
      btn.classList.add("hidden");
      return;
    }
    btn.classList.remove("hidden");
    if (d.downloaded) {
      out.textContent = "downloaded ✓ (" + d.path + ")";
      btn.textContent = "Download again";
    } else if (d.state === "downloading") {
      out.textContent = "downloading… "
        + Math.round(100 * (d.done || 0) / (d.total || 1))
        + "% of 4.7 GB";
      btn.textContent = "Downloading…";
    } else if (d.state === "verifying") {
      out.textContent = "verifying checksum…";
      btn.textContent = "Verifying…";
    } else if (d.state === "error") {
      out.textContent = "error: " + d.error;
      btn.textContent = "Retry download";
    } else {
      out.textContent = "not downloaded (goes to "
        + d.modelsDir + ")";
      btn.textContent = "Download 7B model";
    }
    if (d.state === "downloading" || d.state === "verifying") {
      if (!modelDlTimer)
        modelDlTimer = setInterval(refreshModelDl, 2000);
    } else if (modelDlTimer) {
      clearInterval(modelDlTimer);
      modelDlTimer = null;
    }
  } catch (e) { /* backend hiccup; reopening Settings retries */ }
}
$("setModelDlBtn").onclick = async () => {
  const d = await postJson("/api/model/download", { id: "7b" });
  if (d.error) { alert(d.error); return; }
  refreshModelDl();
};

/* ---------------- model status ---------------- */
async function pollHealth() {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    modelUp = d.model === "up";
    if (d.version)
      $("setVersion").textContent = "v" + d.version;
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
  if ($("agentToggle") && $("agentToggle").checked) {
    ta.value = "";
    runAgent(text);
    return;
  }

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
        mode, budget: BEHAVIOR.context.sliceBudget,
        seed: currentFile || undefined });
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
        if (d.mode === "smart" && d.included) {
          $("ctxMeter").textContent += " · " +
            d.included.map((i) => i.path).join(", ");
        }
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

  /* Repo map (Roadmap G2): the ranked workspace map rides along
     when the setting is on, or once when armed from Tools. */
  if (settings.repoMap || repoMapOnce) {
    repoMapOnce = false;
    try {
      const mapText = await getRepoMap();
      if (mapText) {
        sysContent += "\n\n" + mapText;
        attachedNames.push("repo map");
        $("ctxMeter").textContent =
          "attached: " + attachedNames.join(", ");
      }
    } catch (e) { /* the map is best-effort */ }
  }

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
  // Roadmap G30: error memory hooks.
  const runContent = view.state.doc.toString();
  if (d.code !== 0) {
    const banner = emBannerFor(d.stderr || d.stdout || "",
      currentFile, runContent);
    if (banner) $("runOut").textContent =
      banner + $("runOut").textContent;
  } else {
    emRecordClean(currentFile, runContent);
  }
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
      $("branchChip").classList.add("hidden");
      box.innerHTML = "";
      const note = document.createElement("div");
      note.textContent = d.error || "Not a git repo.";
      box.appendChild(note);
      const initBtn = document.createElement("button");
      initBtn.textContent = "Init repo here";
      initBtn.onclick = async () => {
        const r2 = await postJson("/api/git/init", {});
        if (r2.error) alert(r2.error);
        refreshGit();
      };
      box.appendChild(initBtn);
      return;
    }
    $("gitBranch").textContent = d.branch || "";
    $("gitAiMsg").disabled = false;
    if (d.branch) {
      $("branchChip").textContent = "⎇ " + d.branch;
      $("branchChip").classList.remove("hidden");
    }
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
      if (!untracked) {
        const rb = document.createElement("button");
        rb.textContent = "Revert";
        rb.title = "Discard this file's uncommitted changes";
        rb.onclick = async () => {
          if (!confirm("Discard all uncommitted changes to " +
              c.path + "? This cannot be undone.")) return;
          const d = await postJson("/api/git/checkout",
            { path: c.path });
          if (d.error) { alert(d.error); return; }
          if (c.path === currentFile) reloadCurrentFromDisk();
          refreshGit();
          loadFiles();
        };
        row.appendChild(rb);
      }
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
  pendingRefactor = null;
  $("diffApply").classList.add("hidden");
  $("diffDiscard").classList.add("hidden");
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
  // Roadmap G26: the pre-commit guard. Un-dismissed secret
  // findings ask once, out loud, before the commit lands.
  // A review failure never blocks the commit by itself.
  try {
    const rr = await fetch("/api/git/diff-all");
    const rd = await rr.json();
    if (rd.diff) {
      const dismissed = reviewDismissed();
      const secrets = reviewDiff(rd.diff).filter((f) =>
        f.kind === "secret" && !dismissed.has(f.id));
      if (secrets.length && !confirm("⚠ " + secrets.length +
          " possible secret(s) in this commit:\n" +
          secrets.map((s) => s.file + ":" + s.line).join("\n") +
          "\n\nCommit anyway?")) {
        openReview();
        return;
      }
    }
  } catch (e) { /* the review advises; it does not gate */ }
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
/* Roadmap G29: meaning search beside plain text search.
   Describe what the code DOES in plain English; results are
   functions ranked by concept (identifier words, body
   terms, related coding terms), each with its why. */
$("findSemantic").onclick = async () => {
  const q = $("findQuery").value;
  const box = $("findResults");
  if (!q.trim()) return;
  box.textContent = "reading the code by meaning…";
  const d = await postJson("/api/semsearch", { query: q });
  if (d.error) { box.textContent = d.error; return; }
  box.innerHTML = "";
  if (!d.results.length) {
    box.textContent = "No functions matched that meaning.";
    return;
  }
  for (const r of d.results) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "🧠 " + r.name + "  " + r.path + ":" +
      r.line + "  (why: " + r.matched.join(", ") + ")";
    row.title = r.snippet;
    row.onclick = async () => {
      await openFile(r.path);
      jumpToLine(r.line);
    };
    box.appendChild(row);
  }
  const n = document.createElement("div");
  n.className = "dim";
  n.textContent = "Meaning ranking: identifier words + body " +
    "terms + related coding concepts. Not a neural embedding.";
  box.appendChild(n);
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
  // Roadmap G31: capture the edit as a macro step while
  // recording.
  macroCapture({ kind: "replace", find: q,
    replace: $("findReplacement").value, regex: false });
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
    const matches = COMMANDS.concat(pluginCommands)
      .filter((c) =>
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
      row.textContent = "ƒ " + s.name +
        (s.path && s.path !== currentFile
          ? "  · " + s.path + ":" + s.line
          : "  · line " + s.line);
      row.onclick = async () => {
        closeQuick();
        if (s.path && s.path !== currentFile)
          await openFile(s.path);
        jumpToLine(s.line);
      };
      list.appendChild(row);
    }
    if (!matches.length)
      list.innerHTML = '<div class="dim">No symbols match.</div>';
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
$("setRepoMap").checked = !!settings.repoMap;
$("setRepoMap").onchange = (e) => {
  settings.repoMap = e.target.checked;
  saveSettings();
};
$("setTestOnSave").checked = !!settings.testOnSave;
$("setTestOnSave").onchange = (e) => {
  settings.testOnSave = e.target.checked;
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
/*@@DOCS@@*/
/* Roadmap G24: docs mode. renderMarkdown is a dependency-
   free renderer (escape-first, so raw HTML in a doc can
   never inject markup). renderMermaid covers the flowchart
   and sequence subsets of Mermaid and returns inline SVG,
   so diagrams work in the live preview AND in the
   exported single-file site. */
function mdDir(p) {
  return p && p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
}
function mdResolve(base, rel) {
  if (/^(https?:|data:|#|\/)/.test(rel)) return rel;
  const parts = (base ? base.split("/") : []).concat(rel.split("/"));
  const out = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
function renderMarkdown(src, basePath) {
  const base = basePath || "";
  const lines = escHtml(src).split("\n");
  let html = "";
  let fence = null;         // {lang, buf: []}
  let listType = null;      // "ul" | "ol"
  let quoteBuf = [];
  let tableBuf = [];
  const closeList = () => {
    if (listType) { html += "</" + listType + ">"; listType = null; }
  };
  const flushQuote = () => {
    if (quoteBuf.length) {
      html += "<blockquote>" + quoteBuf.map((q) =>
        "<p>" + inline(q) + "</p>").join("") + "</blockquote>";
      quoteBuf = [];
    }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map((r) => r.replace(/^\||\|$/g, "")
      .split("|").map((c) => c.trim()));
    tableBuf = [];
    const isSep = (r) => r.every((c) => /^:?-{2,}:?$/.test(c));
    if (rows.length > 1 && isSep(rows[1])) {
      html += "<table><thead><tr>" + rows[0].map((c) =>
        "<th>" + inline(c) + "</th>").join("") +
        "</tr></thead><tbody>";
      for (const r of rows.slice(2)) {
        html += "<tr>" + r.map((c) =>
          "<td>" + inline(c) + "</td>").join("") + "</tr>";
      }
      html += "</tbody></table>";
    } else {
      for (const r of rows) {
        html += "<p>" + inline(r.join(" | ")) + "</p>";
      }
    }
  };
  const inline = (t) => t
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, s) =>
      "<img alt=\"" + alt + "\" src=\"" +
      (/^(https?:|data:)/.test(s) ? s
        : "/api/raw?path=" + encodeURIComponent(mdResolve(base, s))) +
      "\">")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
      if (/^https?:/.test(href)) {
        return "<a href=\"" + href +
          "\" target=\"_blank\" rel=\"noopener\">" + text + "</a>";
      }
      const resolved = mdResolve(base, href);
      if (/\.md$/i.test(resolved)) {
        return "<a href=\"#" + resolved + "\" data-md=\"" +
          resolved + "\">" + text + "</a>";
      }
      return "<a href=\"" + href + "\">" + text + "</a>";
    })
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|\W)_([^_]+)_/g, "$1<em>$2</em>");
  for (const rawLine of lines) {
    const line = rawLine;
    if (fence) {
      if (line.trim().startsWith("```")) {
        if (fence.lang === "mermaid") {
          html += renderMermaid(fence.buf.join("\n"));
        } else {
          html += "<pre><code>" + fence.buf.join("\n") +
            "\n</code></pre>";
        }
        fence = null;
      } else fence.buf.push(line);
      continue;
    }
    const fm = line.trim().match(/^```(\w*)/);
    if (fm) {
      closeList(); flushQuote(); flushTable();
      fence = { lang: fm[1] || "", buf: [] };
      continue;
    }
    if (/^\|.*\|$/.test(line.trim())) {
      closeList(); flushQuote();
      tableBuf.push(line.trim());
      continue;
    }
    flushTable();
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      closeList(); flushQuote();
      html += "<h" + h[1].length + ">" + inline(h[2]) +
        "</h" + h[1].length + ">";
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList(); flushQuote();
      html += "<hr>";
      continue;
    }
    const q = line.match(/^&gt;\s?(.*)/);
    if (q) { closeList(); quoteBuf.push(q[1]); continue; }
    flushQuote();
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (task) {
      if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
      html += "<li class=\"task\"><input type=\"checkbox\" disabled" +
        (task[1].trim() ? " checked" : "") + "> " +
        inline(task[2]) + "</li>";
      continue;
    }
    if (ul) {
      if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
      html += "<li>" + inline(ul[1]) + "</li>";
      continue;
    }
    if (ol) {
      if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
      html += "<li>" + inline(ol[1]) + "</li>";
      continue;
    }
    closeList();
    if (line.trim()) html += "<p>" + inline(line) + "</p>";
  }
  if (fence) {
    html += "<pre><code>" + fence.buf.join("\n") + "\n</code></pre>";
  }
  closeList(); flushQuote(); flushTable();
  return html;
}
function renderMermaid(src) {
  try {
    const text = src.replace(/&gt;/g, ">").replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
    const first = (text.trim().split("\n")[0] || "").trim();
    if (/^sequenceDiagram/.test(first)) {
      return mermaidSequence(text);
    }
    if (/^(graph|flowchart)\s/.test(first)) {
      return mermaidFlow(text);
    }
  } catch (e) { /* fall through to the source block */ }
  return "<pre><code>" + escHtml(src) + "\n</code></pre>" +
    "<p class=\"dim\">(diagram preview supports flowchart " +
    "and sequence subsets)</p>";
}
function mermaidFlow(text) {
  const dirM = text.match(/^(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)/m);
  const dir = dirM ? dirM[1] : "TD";
  const nodes = new Map();
  const edges = [];
  const node = (id, label, shape) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, label: label || id, shape: shape || "rect" });
    } else if (label) {
      const n = nodes.get(id);
      n.label = label;
      if (shape) n.shape = shape;
    }
    return nodes.get(id);
  };
  const NODE_RE = /([A-Za-z0-9_]+)(?:\[\[([^\]]*)\]\]|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\}|\(\(([^)]*)\)\))?/g;
  const parseSide = (side) => {
    const ids = [];
    let m;
    NODE_RE.lastIndex = 0;
    const cleaned = side.replace(/"[^"]*"/g, (q) => q.slice(1, -1));
    while ((m = NODE_RE.exec(cleaned))) {
      const shape = m[3] !== undefined || m[2] !== undefined
        ? "rect"
        : m[6] !== undefined ? "circle"
        : m[5] !== undefined ? "diamond"
        : m[4] !== undefined ? "round" : null;
      const label = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
      node(m[1], label, shape);
      ids.push(m[1]);
    }
    return ids;
  };
  for (const rawStmt of text.split(/[;\n]/)) {
    const stmt = rawStmt.trim();
    if (!stmt || /^(graph|flowchart)\s/.test(stmt)) continue;
    if (/^(subgraph|end|classDef|class|style|linkStyle)\b/.test(stmt)) {
      continue;
    }
    const em = stmt.match(/^(.*?)\s*(-\.->|-->|---|--x|--o)\s*(?:\|([^|]*)\|)?\s*(.*)$/);
    if (em && (em[4] || /\|/.test(stmt))) {
      const left = parseSide(em[1].replace(/--\s*[^-]+$/, ""));
      const right = parseSide(em[4]);
      for (const a of left) {
        for (const b of right) {
          edges.push({ a, b, label: em[3] || "",
            dashed: em[2].includes(".") });
        }
      }
    } else {
      parseSide(stmt);
    }
  }
  if (!nodes.size) throw new Error("no nodes");
  // Layered layout: longest-path levels via relaxation.
  const level = new Map([...nodes.keys()].map((k) => [k, 0]));
  for (let i = 0; i < nodes.size; i++) {
    for (const e of edges) {
      if (level.get(e.b) <= level.get(e.a)) {
        level.set(e.b, level.get(e.a) + 1);
      }
    }
  }
  const byLevel = new Map();
  for (const n of nodes.values()) {
    const l = level.get(n.id);
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l).push(n);
  }
  const horiz = dir === "LR" || dir === "RL";
  const NW = 168, NH = 46, GX = 44, GY = 54;
  const pos = new Map();
  let maxL = 0, maxPer = 0;
  for (const [l, group] of byLevel) {
    maxL = Math.max(maxL, l);
    maxPer = Math.max(maxPer, group.length);
    group.forEach((n, i) => {
      const along = l * (NW + GX), across = i * (NH + GY);
      pos.set(n.id, horiz
        ? { x: 16 + along, y: 16 + i * (NH + GY) }
        : { x: 16 + i * (NW + GX), y: 16 + l * (NH + GY) });
      if (horiz) pos.get(n.id).y = 16 + across * 0 + i * (NH + GY);
    });
  }
  const W = horiz ? 32 + (maxL + 1) * NW + maxL * GX
    : 32 + maxPer * NW + (maxPer - 1) * GX;
  const H = horiz ? 32 + maxPer * NH + (maxPer - 1) * GY
    : 32 + (maxL + 1) * NH + maxL * GY;
  const shapeSvg = (n) => {
    const p = pos.get(n.id);
    const cx = p.x + NW / 2, cy = p.y + NH / 2;
    const label = n.label.length > 26
      ? n.label.slice(0, 25) + "…" : n.label;
    const txt = "<text x=\"" + cx + "\" y=\"" + (cy + 4) +
      "\" text-anchor=\"middle\" class=\"mtext\">" +
      escHtml(label) + "</text>";
    if (n.shape === "diamond") {
      return "<polygon points=\"" + cx + "," + p.y + " " +
        (p.x + NW) + "," + cy + " " + cx + "," + (p.y + NH) +
        " " + p.x + "," + cy + "\" class=\"mbox\"/>" + txt;
    }
    if (n.shape === "circle") {
      return "<ellipse cx=\"" + cx + "\" cy=\"" + cy +
        "\" rx=\"" + (NW / 2 - 16) + "\" ry=\"" + (NH / 2) +
        "\" class=\"mbox\"/>" + txt;
    }
    const rx = n.shape === "round" ? 20 : 5;
    return "<rect x=\"" + p.x + "\" y=\"" + p.y + "\" width=\"" +
      NW + "\" height=\"" + NH + "\" rx=\"" + rx +
      "\" class=\"mbox\"/>" + txt;
  };
  const edgeSvg = (e) => {
    const a = pos.get(e.a), b = pos.get(e.b);
    if (!a || !b) return "";
    const x1 = a.x + NW / 2, y1 = a.y + NH / 2;
    const x2 = b.x + NW / 2, y2 = b.y + NH / 2;
    let sx = x1, sy = y1, tx = x2, ty = y2;
    if (horiz) { sx = a.x + NW; tx = b.x; sy = y1; ty = y2; }
    else { sy = a.y + NH; ty = b.y; }
    const mid = horiz
      ? " x=\"" + ((sx + tx) / 2) + "\" y=\"" + ((sy + ty) / 2 - 4)
      : " x=\"" + ((sx + tx) / 2 + 5) + "\" y=\"" + ((sy + ty) / 2);
    return "<line x1=\"" + sx + "\" y1=\"" + sy + "\" x2=\"" +
      tx + "\" y2=\"" + ty + "\" class=\"medge\"" +
      (e.dashed ? " stroke-dasharray=\"5 4\"" : "") +
      " marker-end=\"url(#mArrow)\"/>" +
      (e.label ? "<text" + mid + "\" class=\"mlabel\">" +
        escHtml(e.label) + "</text>" : "");
  };
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" +
    W + "\" height=\"" + H + "\" viewBox=\"0 0 " + W + " " + H +
    "\" class=\"mermaid-svg\"><defs><marker id=\"mArrow\" " +
    "markerWidth=\"8\" markerHeight=\"8\" refX=\"7\" refY=\"3\" " +
    "orient=\"auto\"><path d=\"M0,0 L8,3 L0,6\" fill=\"none\" " +
    "stroke=\"#7ee2a0\" stroke-width=\"1.4\"/></marker></defs>" +
    "<style>.mbox{fill:#171a21;stroke:#7ee2a0;stroke-width:1.4}" +
    ".medge{stroke:#7ee2a0;stroke-width:1.4}" +
    ".mtext{fill:#e6e8f0;font:13px ui-monospace,monospace}" +
    ".mlabel{fill:#9a9fb0;font:11px ui-monospace,monospace}</style>" +
    edges.map(edgeSvg).join("") +
    [...nodes.values()].map(shapeSvg).join("") + "</svg>";
}
function mermaidSequence(text) {
  const actors = [];
  const seen = new Set();
  const msgs = [];
  const actor = (a) => {
    if (!seen.has(a)) { seen.add(a); actors.push(a); }
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const pm = line.match(/^participant\s+(\w+)(?:\s+as\s+(.+))?$/);
    if (pm) { actor(pm[2] || pm[1]); continue; }
    const mm = line.match(/^(\w+)\s*(--?>>|--?>)\s*(\w+)\s*:\s*(.*)$/);
    if (mm) {
      actor(mm[1]); actor(mm[3]);
      msgs.push({ a: mm[1], b: mm[3], text: mm[4],
        dashed: mm[2].startsWith("--") });
    }
  }
  if (!actors.length) throw new Error("no actors");
  const AW = 150, GAP = 60, TOP = 56, STEP = 36;
  const W = 32 + actors.length * AW + (actors.length - 1) * GAP;
  const H = TOP + msgs.length * STEP + 30;
  const cx = (a) => 16 + actors.indexOf(a) * (AW + GAP) + AW / 2;
  let out = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" +
    W + "\" height=\"" + H + "\" viewBox=\"0 0 " + W + " " + H +
    "\" class=\"mermaid-svg\"><defs><marker id=\"mArrow\" " +
    "markerWidth=\"8\" markerHeight=\"8\" refX=\"7\" refY=\"3\" " +
    "orient=\"auto\"><path d=\"M0,0 L8,3 L0,6\" fill=\"none\" " +
    "stroke=\"#7ee2a0\" stroke-width=\"1.4\"/></marker></defs>" +
    "<style>.mbox{fill:#171a21;stroke:#7ee2a0;stroke-width:1.4}" +
    ".medge{stroke:#7ee2a0;stroke-width:1.4}" +
    ".mtext{fill:#e6e8f0;font:13px ui-monospace,monospace}" +
    ".mlabel{fill:#9a9fb0;font:11px ui-monospace,monospace}" +
    ".mlife{stroke:#3a3f4d;stroke-dasharray:4 4}</style>";
  for (const a of actors) {
    out += "<line x1=\"" + cx(a) + "\" y1=\"44\" x2=\"" + cx(a) +
      "\" y2=\"" + (H - 8) + "\" class=\"mlife\"/>" +
      "<rect x=\"" + (cx(a) - AW / 2) + "\" y=\"8\" width=\"" +
      AW + "\" height=\"36\" rx=\"5\" class=\"mbox\"/>" +
      "<text x=\"" + cx(a) + "\" y=\"30\" text-anchor=\"middle\" " +
      "class=\"mtext\">" + escHtml(a) + "</text>";
  }
  msgs.forEach((m, i) => {
    const y = TOP + i * STEP;
    out += "<line x1=\"" + cx(m.a) + "\" y1=\"" + y + "\" x2=\"" +
      cx(m.b) + "\" y2=\"" + y + "\" class=\"medge\"" +
      (m.dashed ? " stroke-dasharray=\"5 4\"" : "") +
      " marker-end=\"url(#mArrow)\"/>" +
      "<text x=\"" + ((cx(m.a) + cx(m.b)) / 2) + "\" y=\"" +
      (y - 5) + "\" text-anchor=\"middle\" class=\"mlabel\">" +
      escHtml(m.text) + "</text>";
  });
  return out + "</svg>";
}
window.__ghostMd = renderMarkdown;
window.__ghostMermaid = renderMermaid;
/*@@DOCS-END@@*/

/* Roadmap G24 wiring: live preview while typing, in-app
   doc links, and the single-file docs site export. */
let mdLivePath = null;
let mdLiveTimer = null;
view.dom.addEventListener("input", () => {
  if (!mdLivePath || $("previewPanel").classList.contains("hidden")) {
    return;
  }
  if (currentFile !== mdLivePath) return;
  clearTimeout(mdLiveTimer);
  mdLiveTimer = setTimeout(() => {
    $("previewBody").innerHTML = renderMarkdown(
      view.state.doc.toString(), mdDir(mdLivePath));
  }, 350);
});
$("previewBody").addEventListener("click", async (e) => {
  const a = e.target.closest("a[data-md]");
  if (!a) return;
  e.preventDefault();
  const target = a.getAttribute("data-md");
  await openFile(target);
  if (currentFile === target) $("toolPreview").click();
});
$("previewClose").addEventListener("click", () => {
  mdLivePath = null;
});
const DOCS_SITE_CSS =
  "body{margin:0;font-family:system-ui,sans-serif;background:#101116;" +
  "color:#e6e8f0;display:flex}nav{position:sticky;top:0;height:100vh;" +
  "overflow:auto;padding:18px;background:#17181f;min-width:200px}" +
  "nav a{display:block;color:#9fe8bb;text-decoration:none;padding:4px 0;" +
  "font-size:13px}main{padding:24px 32px;max-width:820px}" +
  "section{margin-bottom:56px}table{border-collapse:collapse}" +
  "th,td{border:1px solid #2e3038;padding:5px 10px}" +
  "pre{background:#17181f;padding:12px;overflow:auto;border-radius:6px}" +
  "code{font-family:ui-monospace,monospace}blockquote{border-left:" +
  "3px solid #7ee2a0;margin:0;padding-left:14px;color:#b9bdd0}" +
  "img{max-width:100%}a{color:#9fe8bb}";
async function exportDocsSite() {
  const r = await fetch("/api/files");
  const d = await r.json();
  const mds = (d.files || [])
    .filter((f) => f.type === "file" && /\.md$/i.test(f.path))
    .map((f) => f.path).sort();
  if (!mds.length) {
    alert("No Markdown files in this workspace.");
    return;
  }
  const slug = (p) => p.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slugOf = new Map(mds.map((p) => [p, slug(p)]));
  const nav = [];
  const sections = [];
  for (const p of mds) {
    const fr = await fetch("/api/file?path=" + encodeURIComponent(p));
    const fd = await fr.json();
    if (fd.error) continue;
    let html = renderMarkdown(fd.content || "", mdDir(p));
    html = html.replace(/href="#([^"]+)"/g, (m, target) =>
      slugOf.has(target) ? "href=\"#" + slugOf.get(target) + "\"" : m);
    nav.push("<a href=\"#" + slug(p) + "\">" + escHtml(p) + "</a>");
    sections.push("<section id=\"" + slug(p) + "\">" + html +
      "</section>");
  }
  const site = "<!doctype html>\n<html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, " +
    "initial-scale=1\"><title>Project docs</title><style>" +
    DOCS_SITE_CSS + "</style></head><body><nav>" + nav.join("") +
    "</nav><main>" + sections.join("\n") + "</main></body></html>";
  const wr = await fetch("/api/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "docs-site.html", content: site }),
  });
  const wd = await wr.json();
  if (wd.error) { alert(wd.error); return; }
  addMsg("SYSTEM", "📄 Exported " + sections.length +
    " doc page(s) to docs-site.html in the workspace root. " +
    "It is a single self-contained file: open it anywhere.");
}
$("toolDocs").onclick = () => { hideTools(); exportDocsSite(); };
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
      mdLivePath = currentFile;
      body.innerHTML = renderMarkdown(
        view.state.doc.toString(), mdDir(currentFile));
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
  if (dirty) await saveFile();
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
  // Roadmap G30: error memory hooks (check edition).
  const chkContent = view.state.doc.toString();
  if (d.ok === false) {
    const banner = emBannerFor(d.output || "", currentFile,
      chkContent);
    if (banner) $("runOut").textContent =
      banner + $("runOut").textContent;
  } else if (d.ok === true) {
    emRecordClean(currentFile, chkContent);
  }
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
      /* Tabstop snippets (Phase 11): a body containing ${1:...}
         placeholders inserts as a real VS Code-style snippet -
         Tab walks the stops. Anything else inserts as plain
         text, exactly as before. */
      if (sn.body.includes("${")) {
        try {
          snippet(sn.body)(view, null, sel.from, sel.to);
          view.focus();
          $("snipPanel").classList.add("hidden");
          return;
        } catch (e) { /* fall through to plain insert */ }
      }
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

/* Terminal (persistent desktop shell) + Python REPL (G10).
   Both keep server-side sessions: shell cwd/vars and REPL
   variables persist between commands. */
const termHistory = [];
let termIdx = -1;
let termMode = "shell";
function openTermPane(mode) {
  hideTools();
  termMode = mode;
  $("termPane").classList.remove("hidden");
  if (mode === "repl") {
    $("termTitle").textContent =
      "Python REPL · session stays alive between lines";
    $("termCwd").textContent = "";
    $("termPrompt").textContent = ">>>";
    $("termCmd").placeholder =
      "python line, Enter to run (blank line ends a block)";
    postJson("/api/repl", { input: "" }).then((d) => {
      if (d.output) {
        const out = $("termOut");
        out.textContent += d.output;
        out.scrollTop = out.scrollHeight;
      }
    });
  } else {
    $("termTitle").textContent =
      "Terminal · workspace folder · local shell (unsandboxed)";
    $("termPrompt").textContent = "$";
    $("termCmd").placeholder =
      "type a command, Enter to run (↑/↓ for history)";
  }
  $("termCmd").focus();
}
$("toolTerminal").onclick = () => openTermPane("shell");
$("toolRepl").onclick = () => openTermPane("repl");
$("termClose").onclick = () => $("termPane").classList.add("hidden");
$("termReset").onclick = async () => {
  await postJson(termMode === "repl"
    ? "/api/repl/reset" : "/api/terminal/reset", {});
  const out = $("termOut");
  out.textContent += "(session reset)\n";
  if (termMode === "repl") openTermPane("repl");
};
async function runTerm() {
  const input = $("termCmd");
  const cmd = input.value;
  const out = $("termOut");
  if (termMode === "repl") {
    input.value = "";
    if (cmd.trim()) termHistory.unshift(cmd);
    termIdx = -1;
    out.textContent += cmd + "\n";
    const d = await postJson("/api/repl", { input: cmd });
    if (d.error) out.textContent += d.error + "\n";
    else out.textContent += (d.output || "");
    out.scrollTop = out.scrollHeight;
    return;
  }
  if (!cmd.trim()) return;
  termHistory.unshift(cmd);
  termIdx = -1;
  input.value = "";
  out.textContent += "$ " + cmd + "\n";
  out.scrollTop = out.scrollHeight;
  const d = await postJson("/api/terminal", { command: cmd });
  if (d.error) {
    out.textContent += d.error + "\n";
  } else {
    out.textContent += (d.stdout || "") + (d.stderr || "") +
      "[exit " + d.code + " · " + d.ms + " ms]\n";
    if (d.cwd) $("termCwd").textContent = "· " + d.cwd;
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
  { title: "Find all references", run: () => $("toolRefs").click() },
  { title: "Extract function…", run: () => $("toolExtractFn").click() },
  { title: "Extract variable…", run: () => $("toolExtractVar").click() },
  { title: "Inline variable", run: () => $("toolInline").click() },
  { title: "Rename symbol…", run: () => $("toolRename").click() },
  { title: "Repo map", run: () => $("toolRepoMap").click() },
  { title: "Run tests", run: () => $("toolTests").click() },
  { title: "Debug this file", run: () => $("toolDebug").click() },
  { title: "Fix my tests (AI)", run: () => $("toolFix").click() },
  { title: "New project from template", run: () => $("toolTemplates").click() },
  { title: "Pair mode", run: () => $("toolPair").click() },
  { title: "Review changes (pre-commit)", run: () => $("gitReview").click() },
  { title: "Context lab", run: () => $("toolContext").click() },
  { title: "Reference docs", run: () => $("toolRefdocs").click() },
  { title: "Macros", run: () => $("toolMacros").click() },
  { title: "Add cursor on selected lines", run: () => cursorsOnSelectedLines(view) },
  { title: "Select all occurrences", run: () => selectAllOccurrences(view) },
  { title: "Encrypted backup", run: () => $("toolBackup").click() },
  { title: "API client", run: () => $("toolApi").click() },
  { title: "Export docs site", run: () => $("toolDocs").click() },
  { title: "Asset browser", run: () => $("toolAssets").click() },
  { title: "Local history (previous versions)", run: () => $("toolHistory").click() },
  { title: "Check whole project (Problems)", run: () => $("toolCheckAll").click() },
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
  { title: "Python REPL", run: () => $("toolRepl").click() },
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

async function openSymbols() {
  hideTools();
  quickMode = "symbol";
  /* Instant fallback: current file's symbols. Then the
     workspace index (G1) replaces the list when it answers. */
  quickSymbols = currentFile
    ? extractSymbols(view.state.doc.toString()).map((s) => ({
        name: s.name, line: s.line, path: currentFile,
        kind: s.kind || "" }))
    : [];
  $("quickInput").placeholder =
    "Go to symbol in workspace… (Esc closes)";
  $("quickInput").value = "";
  renderQuick("");
  $("quickPanel").classList.remove("hidden");
  $("quickInput").focus();
  try {
    const r = await fetch("/api/symbols");
    const d = await r.json();
    if (d.symbols && d.symbols.length) {
      quickSymbols = d.symbols;
      renderQuick($("quickInput").value);
    }
  } catch (e) { /* fallback list already shown */ }
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
  const el = $("crumbPath");
  if (!el) return;
  if (!currentFile) {
    el.textContent = "";
    $("crumbBlame").textContent = "";
    return;
  }
  let out = currentFile.split("/").join(" › ");
  let lineNo = 1;
  try {
    lineNo = view.state.doc.lineAt(
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
  queueBlame(currentFile, lineNo);
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
  /* Symbol index first (Roadmap G1): exact definitions from
     the workspace index, both builds. */
  let hits = [];
  try {
    const r = await fetch("/api/symbols/search?name=" +
      encodeURIComponent(w.word));
    const d = await r.json();
    if (d.symbols) hits = d.symbols;
  } catch (e) { /* fall back below */ }
  if (!hits.length) {
    /* Fallback heuristic (pre-index behavior): search for the
       definition-shaped lines. */
    const pats = ["def " + w.word, "class " + w.word,
      "function " + w.word, "const " + w.word + " =",
      "let " + w.word + " =", "var " + w.word + " =",
      w.word + " = function", w.word + ": function"];
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
  }
  if (!hits.length) {
    alert("No definition found for '" + w.word + "' in the "
      + "workspace index.");
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
    row.textContent = (h.kind ? h.kind + "  " : "") + h.path +
      " · line " + h.line;
    row.onclick = async () => {
      $("todoPanel").classList.add("hidden");
      if (h.path !== currentFile) await openFile(h.path);
      jumpToLine(h.line);
    };
    box.appendChild(row);
  }
  $("todoPanel").classList.remove("hidden");
};

$("toolRefs").onclick = async () => {
  hideTools();
  const w = wordAtCursor();
  if (!w.word) {
    alert("Put the cursor on a name first.");
    return;
  }
  $("todoTitle").textContent = "References to " + w.word + "…";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Searching the index…</div>';
  $("todoPanel").classList.remove("hidden");
  const r = await fetch("/api/references?name=" +
    encodeURIComponent(w.word));
  const d = await r.json();
  box.innerHTML = "";
  $("todoTitle").textContent = "References: " + w.word +
    " (" + (d.total || 0) + (d.truncated ? ", first 300" : "") +
    ")";
  if (d.error || !d.references || !d.references.length) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = d.error || ("No occurrences of '" + w.word
      + "' - references are tracked for names that are defined "
      + "somewhere in the workspace.");
    box.appendChild(el);
    return;
  }
  for (const h of d.references) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = h.path + " · " + h.line + "  " + h.text;
    row.onclick = async () => {
      $("todoPanel").classList.add("hidden");
      if (h.path !== currentFile) await openFile(h.path);
      jumpToLine(h.line);
    };
    box.appendChild(row);
  }
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

/* ---------------- Phase 11: local history, project problems,
   blame, reload helper ---------------- */
let blameTimer = null;
let blameKey = "";
function queueBlame(path, line) {
  const key = path + ":" + line;
  if (key === blameKey) return;
  blameKey = key;
  clearTimeout(blameTimer);
  blameTimer = setTimeout(async () => {
    const el = $("crumbBlame");
    try {
      const r = await fetch("/api/git/blame?path=" +
        encodeURIComponent(path) + "&line=" + line);
      const d = await r.json();
      if (blameKey !== key) return;
      if (d.ok && d.author) {
        const when = d.time
          ? new Date(d.time * 1000).toLocaleDateString() : "";
        el.textContent = "  ·  👤 " + d.author +
          (d.summary ? " · " + d.summary : "") +
          (when ? " · " + when : "");
      } else {
        el.textContent = "";
      }
    } catch (e) {
      el.textContent = "";
    }
  }, 500);
}

async function reloadCurrentFromDisk() {
  if (!currentFile) return;
  const path = currentFile;
  const ti = tabOrder.indexOf(path);
  if (ti >= 0) tabOrder.splice(ti, 1);
  tabStates.delete(path);
  tabDirty.set(path, false);
  currentFile = null;
  await openFile(path, true);
}

function fmtSnapTs(ts) {
  /* 20261019-031500[-n] -> 2026-10-19 03:15:00 */
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return ts;
  return m[1] + "-" + m[2] + "-" + m[3] + " " +
    m[4] + ":" + m[5] + ":" + m[6];
}

$("toolHistory").onclick = async () => {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  $("todoTitle").textContent = "Local history: " + currentFile;
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Loading…</div>';
  $("todoPanel").classList.remove("hidden");
  const r = await fetch("/api/history?path=" +
    encodeURIComponent(currentFile));
  const d = await r.json();
  box.innerHTML = "";
  const hint = document.createElement("div");
  hint.className = "dim";
  hint.textContent = "Every save keeps the previous version "
    + "here. Tap a snapshot to load it into the editor - "
    + "nothing is written until you Save.";
  box.appendChild(hint);
  if (d.error) {
    hint.textContent = d.error;
    return;
  }
  if (!d.entries || !d.entries.length) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = "No snapshots yet - save this file after "
      + "an edit and its previous version will appear here.";
    box.appendChild(el);
    return;
  }
  for (const e of d.entries) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "🕘 " + fmtSnapTs(e.ts) + "  ·  " +
      Math.max(1, Math.round(e.size / 1024)) + " KB";
    row.onclick = async () => {
      const rr = await fetch("/api/history/file?path=" +
        encodeURIComponent(currentFile) + "&ts=" +
        encodeURIComponent(e.ts));
      const dd = await rr.json();
      if (dd.error) { alert(dd.error); return; }
      accepting = true;
      view.dispatch({ changes: {
        from: 0, to: view.state.doc.length, insert: dd.content },
        selection: { anchor: 0 } });
      accepting = false;
      $("todoPanel").classList.add("hidden");
      setSaveState("snapshot " + fmtSnapTs(e.ts) +
        " loaded - Save to keep it");
      view.focus();
    };
    box.appendChild(row);
  }
};

$("toolCheckAll").onclick = async () => {
  hideTools();
  $("todoTitle").textContent = "Project problems";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Checking the project…</div>';
  $("todoPanel").classList.remove("hidden");
  const r = await fetch("/api/check-all");
  const d = await r.json();
  box.innerHTML = "";
  if (d.error) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = d.error;
    box.appendChild(el);
    return;
  }
  if (!d.problems || !d.problems.length) {
    const el = document.createElement("div");
    el.className = "findRow";
    el.textContent = "✓ No problems in " + d.checked +
      " checked file(s)";
    box.appendChild(el);
    return;
  }
  for (const p of d.problems) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "✖ " + p.path +
      (p.line ? " · line " + p.line : "") + " — " +
      (p.message || "syntax error");
    row.onclick = async () => {
      $("todoPanel").classList.add("hidden");
      if (p.path !== currentFile) await openFile(p.path);
      if (p.line) jumpToLine(p.line);
    };
    box.appendChild(row);
  }
};

/* ---------------- Roadmap G2: repo map ---------------- */
let repoMapOnce = false;
let repoMapCache = { at: 0, text: "" };
async function getRepoMap() {
  if (Date.now() - repoMapCache.at < 60000 && repoMapCache.text)
    return repoMapCache.text;
  const r = await fetch("/api/repomap?budget=6000");
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  repoMapCache = { at: Date.now(), text: d.map || "" };
  return repoMapCache.text;
}

$("toolRepoMap").onclick = async () => {
  hideTools();
  $("todoTitle").textContent = "Repo map";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Building the map…</div>';
  $("todoPanel").classList.remove("hidden");
  try {
    const mapText = await getRepoMap();
    box.innerHTML = "";
    const arm = document.createElement("div");
    arm.className = "findRow";
    arm.textContent = settings.repoMap
      ? "✓ The map rides along with every chat message "
        + "(Settings → repo map is on)"
      : "➕ Attach this map to my next chat message";
    arm.onclick = () => {
      repoMapOnce = true;
      arm.textContent = "✓ Armed - it will ride along with "
        + "your next chat message";
    };
    box.appendChild(arm);
    const pre = document.createElement("div");
    pre.className = "mapText";
    pre.textContent = mapText || "(no symbols yet)";
    box.appendChild(pre);
  } catch (e) {
    box.innerHTML = "";
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = "Repo map unavailable: " + e.message;
    box.appendChild(el);
  }
};

/* ---------------- Roadmap G3: refactoring UI ---------------- */
let pendingRefactor = null;
function anyOpenDirty() {
  if (dirty) return true;
  for (const v of tabDirty.values()) if (v) return true;
  return false;
}
async function previewRefactor(title, payload) {
  const d = await postJson("/api/refactor", payload);
  if (d.error) { alert(d.error); return; }
  pendingRefactor = { title, payload };
  $("diffTitle").textContent = title + " - preview";
  $("diffOut").textContent = d.diff ||
    "(no text changes - the file move itself)";
  $("diffApply").classList.remove("hidden");
  $("diffDiscard").classList.remove("hidden");
  $("diffPanel").classList.remove("hidden");
}
function closeDiff() {
  pendingRefactor = null;
  $("diffApply").classList.add("hidden");
  $("diffDiscard").classList.add("hidden");
  $("diffPanel").classList.add("hidden");
}
$("diffClose").onclick = closeDiff;
$("diffDiscard").onclick = closeDiff;
$("diffApply").onclick = async () => {
  if (!pendingRefactor) return;
  const { title, payload } = pendingRefactor;
  const d = await postJson("/api/refactor",
    Object.assign({}, payload, { apply: true }));
  if (d.error) { alert(d.error); return; }
  closeDiff();
  const changed = new Set(d.files || []);
  if (d.move) {
    const wasOpen = tabOrder.includes(d.move.from);
    if (tabStates.has(d.move.from)) closeTab(d.move.from);
    if (wasOpen) await openFile(d.move.to, true);
  }
  for (const p of changed) {
    if (p === currentFile) await reloadCurrentFromDisk();
    else if (tabStates.has(p)) tabStates.delete(p);
  }
  loadFiles();
  setSaveState("refactor applied: " + title);
};

$("toolExtractFn").onclick = () => {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  if (dirty) {
    alert("Save first - refactoring works on the saved file.");
    return;
  }
  const sel = view.state.selection.main;
  if (sel.empty) {
    alert("Select the statements to extract first.");
    return;
  }
  let startLine = view.state.doc.lineAt(sel.from).number;
  let endLine = view.state.doc.lineAt(sel.to).number;
  if (view.state.doc.lineAt(sel.to).from === sel.to) endLine--;
  const name = prompt("New function name:", "extracted");
  if (!name) return;
  previewRefactor("Extract function " + name, {
    op: "extract-function", path: currentFile,
    startLine, endLine, name });
};

$("toolExtractVar").onclick = () => {
  hideTools();
  if (!currentFile) { alert("Open a file first."); return; }
  if (dirty) {
    alert("Save first - refactoring works on the saved file.");
    return;
  }
  const sel = view.state.selection.main;
  if (sel.empty) {
    alert("Select an expression on one line first.");
    return;
  }
  const lineObj = view.state.doc.lineAt(sel.from);
  if (view.state.doc.lineAt(sel.to).number !== lineObj.number) {
    alert("Extract variable works on a single line for now.");
    return;
  }
  const name = prompt("New variable name:", "value");
  if (!name) return;
  previewRefactor("Extract variable " + name, {
    op: "extract-variable", path: currentFile,
    line: lineObj.number,
    startCol: sel.from - lineObj.from,
    endCol: sel.to - lineObj.from, name });
};

$("toolInline").onclick = () => {
  hideTools();
  const w = wordAtCursor();
  if (!w.word) {
    alert("Put the cursor on a variable name first.");
    return;
  }
  if (anyOpenDirty()) {
    alert("Save all open files first - inline rewrites "
      + "every file that uses " + w.word + ".");
    return;
  }
  previewRefactor("Inline " + w.word, { op: "inline", name: w.word });
};

$("menuMove").onclick = () => {
  $("fileMenu").classList.add("hidden");
  if (!menuTarget || menuTarget.type === "dir") return;
  if (anyOpenDirty()) {
    alert("Save all open files first - moving a file rewrites "
      + "the files that import it.");
    return;
  }
  const to = prompt("Move " + menuTarget.path + " to:",
    menuTarget.path);
  if (!to || to === menuTarget.path) return;
  previewRefactor("Move " + menuTarget.path + " → " + to, {
    op: "move", from: menuTarget.path, to });
};

/* ---------------- Roadmap G5: agent mode ----------------
   A multi-step loop over the plain chat endpoint. The model
   replies with exactly ONE action per message:
     READ <path>    - we answer with the file's content
     WRITE <path>   - followed by a fenced block holding the
                      file's COMPLETE new content; the write
                      is STAGED in memory, never on disk
     CHECK          - syntax-check everything staged
     DONE <summary> - finish and open the review panel
     ASK <question> - stop and ask the user
   Nothing reaches disk until the user approves files in the
   review panel, so Stop / reject leaves the workspace
   exactly as it was. */
const AGENT_MAX_STEPS = 12;
let agentRunning = false;
let agentStop = false;
const AGENT_RULES = [
  "You are Ghost in AGENT MODE. Complete the task by",
  "replying with exactly ONE action per message:",
  "READ <path> - ask for a file's current content",
  "WRITE <path> - on the next line a fenced code block with",
  "  the file's complete new content (whole file, no fragments)",
  "CHECK - syntax-check everything you have written",
  "DONE <one-line summary> - the task is complete",
  "ASK <question> - you need the user to decide something",
  "Rules: never invent file contents - READ a file before",
  "rewriting it. Keep every WRITE syntactically valid. Do",
  "not explain outside the action line. You have at most "
    + AGENT_MAX_STEPS + " actions.",
].join("\n");

function parseAgentAction(reply) {
  const text = reply || "";
  let m = text.match(/^\s*READ\s+(\S+)\s*$/m);
  if (m) return { type: "read", path: m[1] };
  m = text.match(/^\s*WRITE\s+(\S+)\s*\n```[a-zA-Z0-9]*\n([\s\S]*?)```/m);
  if (m) {
    let content = m[2];
    if (!content.endsWith("\n")) content += "\n";
    return { type: "write", path: m[1], content };
  }
  if (/^\s*CHECK\s*$/m.test(text)) return { type: "check" };
  m = text.match(/^\s*DONE\s*(.*)$/m);
  if (m) return { type: "done", summary: m[1] || "" };
  m = text.match(/^\s*ASK\s+(.+)$/m);
  if (m) return { type: "ask", question: m[1].trim() };
  return { type: "unknown", raw: text.slice(0, 200) };
}
window.__ghostParseAgent = parseAgentAction;

async function runAgent(task) {
  if (agentRunning) {
    addMsg("SYSTEM", "An agent task is already running.");
    return;
  }
  if (anyOpenDirty()) {
    addMsg("SYSTEM", "Agent mode works from the saved files - "
      + "save your open edits first.");
    return;
  }
  agentRunning = true;
  agentStop = false;
  addMsg("YOU", "🤖 " + task);
  const sendBtn = $("chatSend");
  const oldSend = sendBtn.onclick;
  sendBtn.textContent = "■ Stop agent";
  sendBtn.onclick = () => { agentStop = true; };
  const staged = new Map();
  const readCache = new Map();
  async function readForAgent(path) {
    if (staged.has(path)) return staged.get(path);
    if (readCache.has(path)) return readCache.get(path);
    const r = await fetch("/api/file?path=" +
      encodeURIComponent(path));
    const d = await r.json();
    if (d.error) return null;
    readCache.set(path, d.content);
    return d.content;
  }
  let mapText = "";
  try { mapText = await getRepoMap(); } catch (e) { /* optional */ }
  const messages = [
    { role: "system", content: BEHAVIOR.systemPrompt + "\n\n" +
      AGENT_RULES + (mapText ? "\n\n" + mapText : "") },
    { role: "user", content: "Task: " + task +
      (currentFile ? "\nThe user is currently editing: "
        + currentFile : "") },
  ];
  let outcome = "cap";
  let summary = "";
  let nudges = 0;
  for (let step = 1; step <= AGENT_MAX_STEPS; step++) {
    if (agentStop) { outcome = "stopped"; break; }
    addMsg("SYSTEM", "🤖 step " + step + "/" + AGENT_MAX_STEPS);
    let reply = "";
    try {
      reply = await collectChat(messages, 2048);
    } catch (e) {
      addMsg("SYSTEM", "Agent: model call failed: " + e);
      outcome = "failed";
      break;
    }
    messages.push({ role: "assistant", content: reply });
    const act = parseAgentAction(reply);
    if (act.type === "read") {
      const content = await readForAgent(act.path);
      addMsg("SYSTEM", "📖 READ " + act.path);
      messages.push({ role: "user", content: content == null
        ? "READ failed: " + act.path + " does not exist yet. "
          + "You may create it with WRITE."
        : "Content of " + act.path + ":\n```\n" +
          content.slice(0, 12000) + "\n```" });
    } else if (act.type === "write") {
      staged.set(act.path, act.content);
      addMsg("SYSTEM", "✏️ WRITE " + act.path +
        " (staged - not saved)");
      messages.push({ role: "user", content: "Staged " +
        act.path + ". " + staged.size +
        " file(s) staged. Continue." });
    } else if (act.type === "check") {
      const notes = [];
      for (const [p, c] of staged) {
        const d = await postJson("/api/check-content",
          { path: p, content: c });
        if (d.ok === true) notes.push(p + ": OK");
        else if (d.ok === false) notes.push(p + ": PROBLEM " +
          (d.message || "") +
          (d.line ? " (line " + d.line + ")" : ""));
        else notes.push(p + ": check skipped (" +
          (d.note || "not available") + ")");
      }
      addMsg("SYSTEM", "🔍 CHECK\n" + notes.join("\n"));
      messages.push({ role: "user", content: "Check results:\n" +
        notes.join("\n") +
        "\nFix any problems with another WRITE, or finish "
        + "with DONE." });
    } else if (act.type === "done") {
      outcome = "done";
      summary = act.summary;
      break;
    } else if (act.type === "ask") {
      addMsg("GHOST", "❓ " + act.question);
      outcome = "asked";
      break;
    } else {
      nudges++;
      if (nudges > 1) {
        addMsg("SYSTEM", "Agent stopped: two replies in a row "
          + "had no action in them.");
        outcome = "failed";
        break;
      }
      messages.push({ role: "user", content: "That reply had "
        + "no action. Reply with exactly one action: READ, "
        + "WRITE, CHECK, DONE, or ASK." });
    }
  }
  sendBtn.textContent = "Send";
  sendBtn.onclick = oldSend;
  agentRunning = false;
  if (outcome === "stopped") {
    addMsg("SYSTEM", "Agent stopped by you. Nothing was "
      + "written - the staged changes were discarded.");
  } else if (outcome === "cap") {
    addMsg("SYSTEM", "Agent hit the " + AGENT_MAX_STEPS +
      "-step cap.");
  }
  if ((outcome === "done" || outcome === "cap") && staged.size) {
    addMsg("GHOST", "🤖 " + (summary || "Task run complete") +
      " - review the " + staged.size +
      " file(s) below. Nothing is saved until you approve.");
    openAgentReview(staged);
  } else if (outcome === "done") {
    addMsg("GHOST", "🤖 Done: " + summary);
  }
}

async function openAgentReview(staged) {
  $("todoTitle").textContent =
    "🤖 Agent changes - approve per file";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Preparing diffs…</div>';
  $("todoPanel").classList.remove("hidden");
  let existing = new Set();
  try {
    const fr = await fetch("/api/files");
    const fd = await fr.json();
    existing = new Set((fd.files || [])
      .filter((x) => x.type === "file").map((x) => x.path));
  } catch (e) { /* labels only */ }
  const approved = new Set(staged.keys());
  box.innerHTML = "";
  const applyRow = document.createElement("div");
  applyRow.className = "findRow";
  const rejectRow = document.createElement("div");
  rejectRow.className = "findRow";
  rejectRow.textContent = "✖ Reject all - write nothing";
  rejectRow.onclick = () => {
    $("todoPanel").classList.add("hidden");
    addMsg("SYSTEM", "Agent changes rejected - nothing was "
      + "written.");
  };
  function refreshApply() {
    applyRow.textContent = "✓ Apply approved (" +
      approved.size + " of " + staged.size + ")";
  }
  applyRow.onclick = async () => {
    $("todoPanel").classList.add("hidden");
    let n = 0;
    for (const [p, c] of staged) {
      if (!approved.has(p)) continue;
      const d = await postJson("/api/file",
        { path: p, content: c });
      if (!d.error) {
        n++;
        if (p === currentFile) await reloadCurrentFromDisk();
        else if (tabStates.has(p)) tabStates.delete(p);
      }
    }
    loadFiles();
    addMsg("SYSTEM", "Agent changes applied: " + n +
      " file(s) saved.");
  };
  refreshApply();
  box.appendChild(applyRow);
  box.appendChild(rejectRow);
  for (const [p, c] of staged) {
    const row = document.createElement("div");
    row.className = "findRow";
    function label() {
      row.textContent = (approved.has(p) ? "☑ " : "☐ ") + p +
        (existing.has(p) ? "" : " (new file)");
    }
    label();
    row.onclick = () => {
      if (approved.has(p)) approved.delete(p);
      else approved.add(p);
      label();
      refreshApply();
    };
    box.appendChild(row);
    const diffRow = document.createElement("div");
    diffRow.className = "findRow";
    diffRow.textContent = "   👁 view diff for " + p;
    diffRow.onclick = async () => {
      const d = await postJson("/api/diff-text",
        { path: p, content: c });
      pendingRefactor = null;
      $("diffApply").classList.add("hidden");
      $("diffDiscard").classList.add("hidden");
      $("diffTitle").textContent = "Agent diff: " + p;
      $("diffOut").textContent = d.diff || "(no differences)";
      $("diffPanel").classList.remove("hidden");
    };
    box.appendChild(diffRow);
  }
}

/* ---------------- Roadmap G6: test runner ---------------- */
let testDefLines = {};
async function openTests() {
  hideTools();
  $("todoTitle").textContent = "Tests";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Discovering tests…</div>';
  $("todoPanel").classList.remove("hidden");
  const r = await fetch("/api/tests/discover");
  const d = await r.json();
  box.innerHTML = "";
  if (d.error) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = d.error;
    box.appendChild(el);
    return;
  }
  const files = d.files || [];
  testDefLines = {};
  for (const f of files)
    for (const t of f.tests || [])
      testDefLines[f.path + ":" + t.name] = t.line;
  if (!files.length) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = "No test files found (test_*.py, "
      + "*_test.py, *.test.js).";
    box.appendChild(el);
    return;
  }
  const all = document.createElement("div");
  all.className = "findRow";
  all.textContent = "▶ Run all tests (" + files.length
    + " file(s))";
  all.onclick = () => runTests(null);
  box.appendChild(all);
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "▶ " + f.path +
      (f.tests && f.tests.length
        ? " · " + f.tests.length + " test(s)" : "");
    row.onclick = () => runTests(f.path);
    box.appendChild(row);
  }
}

async function runTests(path) {
  $("todoTitle").textContent = "Tests - running…";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Running…</div>';
  $("todoPanel").classList.remove("hidden");
  const d = await postJson("/api/tests/run",
    path ? { path } : {});
  box.innerHTML = "";
  if (d.error) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = d.error;
    box.appendChild(el);
    $("todoTitle").textContent = "Tests";
    return;
  }
  $("todoTitle").textContent = "Tests: " + d.passed +
    " passed, " + d.failed + " failed (" + d.ms + " ms)";
  if (!d.results.length) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = "No tests ran.";
    box.appendChild(el);
    return;
  }
  for (const r of d.results) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = (r.status === "pass" ? "✓ " : "✗ ") +
      r.name + " · " + r.file +
      (r.line ? ":" + r.line : "") +
      (r.message ? " - " + String(r.message).slice(0, 120) : "");
    row.onclick = async () => {
      $("todoPanel").classList.add("hidden");
      if (r.file !== currentFile) await openFile(r.file);
      const ln = r.line ||
        testDefLines[r.file + ":" + r.name];
      if (ln) jumpToLine(ln);
    };
    box.appendChild(row);
  }
}
$("toolTests").onclick = openTests;

async function maybeRunTestsOnSave(savedPath) {
  if (!settings.testOnSave || !savedPath) return;
  try {
    const r = await fetch("/api/tests/discover");
    const d = await r.json();
    if (d.error || !d.files || !d.files.length) return;
    const stem = savedPath.split("/").pop()
      .replace(/\.\w+$/, "");
    const related = d.files.filter((f) =>
      f.path === savedPath || f.path.includes(stem));
    if (!related.length) return;
    let failed = 0;
    let passed = 0;
    for (const f of related) {
      const rd = await postJson("/api/tests/run",
        { path: f.path });
      if (rd.error) return;
      passed += rd.passed;
      failed += rd.failed;
    }
    const chip = $("testChip");
    if (failed) {
      chip.textContent = "🧪 ✗ " + failed + " failing";
      chip.classList.remove("hidden");
      chip.onclick = () => openTests();
    } else {
      chip.classList.add("hidden");
      setSaveState("saved · tests ✓ " + passed + " passed");
    }
  } catch (e) { /* run-on-save is best-effort */ }
}

/* ---------------- Roadmap G7: debugger UI ---------------- */
let debugSession = null;
let debugRelFile = null;

function debugShowPanel(show) {
  $("debugPanel").classList.toggle("hidden", !show);
}
function renderDebugEvent(ev) {
  const out = $("debugOut");
  if (ev.stdout) out.textContent += ev.stdout;
  if (ev.event === "stopped") {
    $("debugStatus").textContent = "⏸ Stopped at " +
      (debugRelFile || "") + ":" + ev.line +
      " in " + (ev.func || "");
    const lines = Object.keys(ev.vars || {}).sort().map(
      (k) => k + " = " + ev.vars[k]);
    $("debugVars").textContent = lines.length
      ? lines.join("\n") : "(no local variables)";
    const rel = debugRelFile;
    (async () => {
      if (rel && rel !== currentFile) await openFile(rel);
      jumpToLine(ev.line);
    })();
  } else if (ev.event === "exited") {
    $("debugStatus").textContent = ev.error
      ? "💥 Exited with an error (see output)"
      : "🏁 Finished";
    if (ev.error) out.textContent += "\n" + ev.error;
    $("debugVars").textContent = "";
    debugSession = null;
  } else {
    $("debugStatus").textContent =
      "Debugger did not respond in time.";
  }
  out.scrollTop = out.scrollHeight;
}
async function startDebug() {
  if (!currentFile) { alert("Open a Python file first."); return; }
  if (!currentFile.endsWith(".py")) {
    alert("The debugger runs Python files (desktop build).");
    return;
  }
  hideTools();
  debugRelFile = currentFile;
  $("debugTitle").textContent = "🐛 Debug: " + currentFile;
  $("debugOut").textContent = "";
  $("debugVars").textContent = "";
  $("debugStatus").textContent = "Starting…";
  debugShowPanel(true);
  const bps = [...(breakpoints.get(currentFile) || [])];
  const d = await postJson("/api/debug/start",
    { path: currentFile, breakpoints: bps });
  if (d.error) {
    $("debugStatus").textContent = d.error;
    return;
  }
  debugSession = d.session;
  renderDebugEvent(d.event);
}
async function debugCmd(cmd) {
  if (!debugSession) return;
  $("debugStatus").textContent = "…";
  const d = await postJson("/api/debug/cmd",
    { session: debugSession, cmd });
  if (d.error) {
    $("debugStatus").textContent = d.error;
    return;
  }
  renderDebugEvent(d.event);
}
$("toolDebug").onclick = startDebug;
$("dbgContinue").onclick = () => debugCmd("continue");
$("dbgNext").onclick = () => debugCmd("next");
$("dbgStep").onclick = () => debugCmd("step");
$("dbgReturn").onclick = () => debugCmd("return");
$("dbgStop").onclick = async () => {
  if (debugSession)
    await postJson("/api/debug/stop", { session: debugSession });
  debugSession = null;
  $("debugStatus").textContent = "⏹ Stopped";
  $("debugVars").textContent = "";
};
$("debugClose").onclick = () => debugShowPanel(false);

/* ---------------- Roadmap G8: self-fixing loop ----------------
   Run tests -> hand failures to the agent -> it repairs with
   the G5 protocol, but writes APPLY immediately (each one is
   snapshotted by Local History and backed up in memory) ->
   re-run. A round that increases failures is reverted on the
   spot. Max 3 rounds; the attempt log ends in a report panel
   with an Undo-everything button. */
const FIX_MAX_ROUNDS = 3;
const FIX_MAX_STEPS = 10;

async function runTestsAll() {
  return postJson("/api/tests/run", {});
}

async function runFixLoop() {
  if (agentRunning) {
    addMsg("SYSTEM", "An agent task is already running.");
    return;
  }
  if (anyOpenDirty()) {
    addMsg("SYSTEM", "Fix-my-tests works from the saved files "
      + "- save your open edits first.");
    return;
  }
  let res = await runTestsAll();
  if (res.error) { addMsg("SYSTEM", "Fix my tests: " + res.error); return; }
  if (!res.results || !res.results.length) {
    addMsg("SYSTEM", "No tests found in this project.");
    return;
  }
  if (!res.failed) {
    addMsg("GHOST", "✅ Your tests already pass (" + res.passed
      + " of " + res.results.length + "). Nothing to fix.");
    return;
  }
  agentRunning = true;
  agentStop = false;
  const sendBtn = $("chatSend");
  const oldSend = sendBtn.onclick;
  sendBtn.textContent = "■ Stop fixing";
  sendBtn.onclick = () => { agentStop = true; };
  const backups = new Map();
  const log = [];
  const note = (s) => { log.push(s); addMsg("SYSTEM", s); };
  note("🛠 Fix-my-tests: " + res.failed + " failing of " +
    res.results.length + ". Up to " + FIX_MAX_ROUNDS +
    " repair rounds. Writes apply as the agent makes them, " +
    "each one recoverable (Local History + the Undo button " +
    "in the final report).");
  let outcome = "gaveup";
  let prevFailed = res.failed;
  const touched = new Set();
  for (let round = 1; round <= FIX_MAX_ROUNDS; round++) {
    if (agentStop) { outcome = "stopped"; break; }
    const failures = res.results.filter(
      (r) => r.status === "fail");
    const failText = failures.map((f) => "- " + f.name +
      " in " + f.file + (f.line ? " line " + f.line : "") +
      (f.message ? ": " + f.message : "")).join("\n");
    note("🔁 Round " + round + ": handing " + failures.length +
      " failure(s) to Ghost.");
    const roundStart = new Map();
    const roundFiles = new Map();
    async function readRound(path) {
      if (roundFiles.has(path)) return roundFiles.get(path);
      const r = await fetch("/api/file?path=" +
        encodeURIComponent(path));
      const d = await r.json();
      if (d.error) return null;
      roundFiles.set(path, d.content);
      return d.content;
    }
    const messages = [
      { role: "system", content: BEHAVIOR.systemPrompt + "\n\n" +
        AGENT_RULES },
      { role: "user", content: "Fix the failing tests below " +
        "by fixing the SOURCE code. Do not edit the tests " +
        "themselves unless a test is plainly wrong. Work in " +
        "the agent protocol: READ files before rewriting " +
        "them, WRITE complete fixed files, CHECK, then DONE." +
        "\n\nFailing tests:\n" + failText },
    ];
    let nudges = 0;
    let roundDone = false;
    for (let step = 1; step <= FIX_MAX_STEPS; step++) {
      if (agentStop) break;
      let reply = "";
      try {
        reply = await collectChat(messages, 2048);
      } catch (e) {
        note("Round " + round + ": model call failed: " + e);
        break;
      }
      messages.push({ role: "assistant", content: reply });
      const act = parseAgentAction(reply);
      if (act.type === "read") {
        const content = await readRound(act.path);
        messages.push({ role: "user", content: content == null
          ? "READ failed: " + act.path + " does not exist."
          : "Content of " + act.path + ":\n```\n" +
            content.slice(0, 12000) + "\n```" });
      } else if (act.type === "write") {
        if (!roundStart.has(act.path)) {
          const cur = await readRound(act.path);
          roundStart.set(act.path, cur);
          if (!backups.has(act.path)) backups.set(act.path, cur);
        }
        roundFiles.set(act.path, act.content);
        touched.add(act.path);
        const sd = await postJson("/api/file",
          { path: act.path, content: act.content });
        addMsg("SYSTEM", "✏️ Applied fix to " + act.path +
          (sd.error ? " - SAVE FAILED: " + sd.error : ""));
        messages.push({ role: "user", content: "Applied " +
          act.path + ". Continue." });
      } else if (act.type === "check") {
        const notes = [];
        for (const [p, c] of roundFiles) {
          const d = await postJson("/api/check-content",
            { path: p, content: c });
          notes.push(p + ": " + (d.ok === true ? "OK"
            : d.ok === false
              ? "PROBLEM " + (d.message || "")
              : "skipped"));
        }
        messages.push({ role: "user", content: "Check results:\n"
          + notes.join("\n") +
          "\nFix problems with another WRITE, or DONE." });
      } else if (act.type === "done") {
        roundDone = true;
        break;
      } else if (act.type === "ask") {
        addMsg("GHOST", "❓ " + act.question);
        outcome = "asked";
        break;
      } else {
        nudges++;
        if (nudges > 1) break;
        messages.push({ role: "user", content: "That reply had "
          + "no action. Reply with exactly one action: READ, "
          + "WRITE, CHECK, DONE, or ASK." });
      }
    }
    if (outcome === "asked" || agentStop) {
      if (agentStop) outcome = "stopped";
      break;
    }
    void roundDone;
    res = await runTestsAll();
    if (res.error) { note("Re-run failed: " + res.error); break; }
    note("Round " + round + " result: " + prevFailed + " → " +
      res.failed + " failing (" + res.passed + " passing).");
    if (touched.has(currentFile)) reloadCurrentFromDisk();
    loadFiles();
    if (res.failed === 0) { outcome = "green"; break; }
    if (res.failed > prevFailed) {
      for (const [p, content] of roundStart) {
        if (content == null) continue;
        await postJson("/api/file", { path: p, content });
      }
      note("Round " + round + " made things worse - its " +
        "changes were reverted.");
      outcome = "worse";
      res = await runTestsAll();
      break;
    }
    prevFailed = res.failed;
  }
  sendBtn.textContent = "Send";
  sendBtn.onclick = oldSend;
  agentRunning = false;
  const verdict = outcome === "green"
    ? "✅ All tests pass now (" + res.passed + " of " +
      res.results.length + ")."
    : outcome === "stopped"
      ? "⏹ Stopped. Tests still failing: " + res.failed + "."
      : outcome === "asked"
        ? "❓ Ghost stopped to ask a question (above)."
        : "🧯 Still " + res.failed + " failing after the loop. "
          + "The attempt log above shows every round.";
  addMsg("GHOST", "🛠 Fix-my-tests: " + verdict);
  openFixReport(log, verdict, backups, touched);
}

function openFixReport(log, verdict, backups, touched) {
  $("todoTitle").textContent = "🛠 Fix-my-tests report";
  const box = $("todoResults");
  box.innerHTML = "";
  $("todoPanel").classList.remove("hidden");
  const head = document.createElement("div");
  head.className = "dim";
  head.textContent = verdict + " Files changed: " +
    (touched.size ? [...touched].join(", ") : "none");
  box.appendChild(head);
  for (const line of log) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = line;
    box.appendChild(row);
  }
  if (backups.size) {
    const undo = document.createElement("div");
    undo.className = "findRow";
    undo.textContent = "↩ Undo all loop changes (restore " +
      backups.size + " file(s))";
    undo.onclick = async () => {
      for (const [p, content] of backups) {
        if (content == null) continue;
        await postJson("/api/file", { path: p, content });
      }
      if (touched.has(currentFile)) reloadCurrentFromDisk();
      loadFiles();
      $("todoPanel").classList.add("hidden");
      addMsg("SYSTEM", "Fix-my-tests changes undone.");
    };
    box.appendChild(undo);
  }
}
$("toolFix").onclick = () => {
  hideTools();
  runFixLoop();
};

/*@@REVIEW@@*/
/* ---------------- Roadmap G26: pre-commit AI review --------
   A deterministic rules scan over the ADDED lines of the
   diff (secrets, bug risks, dead code, debug leftovers),
   anchored to file + new-file line, each finding
   dismissible. The Ask Ghost button adds the model's own
   read on top; the rules are the floor that always runs. */
function parseDiff(diff) {
  const files = [];
  let cur = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = null; continue; }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") { cur = null; continue; }
      cur = { file: p.replace(/^b\//, ""), additions: [] };
      files.push(cur);
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { newLine = parseInt(h[1], 10); continue; }
    if (!cur) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      cur.additions.push({ line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // deletions and "\ No newline" markers do not
      // advance the new-file line counter
    } else {
      newLine++;
    }
  }
  return files;
}
const REVIEW_RULES = [
  { kind: "secret", sev: 3, re: /\bAKIA[0-9A-Z]{16}\b/,
    msg: "Possible AWS access key ID in plain text." },
  { kind: "secret", sev: 3,
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/,
    msg: "Possible GitHub token in plain text." },
  { kind: "secret", sev: 3, re: /\bsk-[A-Za-z0-9]{20,}\b/,
    msg: "Possible API secret key (sk- style) in plain text." },
  { kind: "secret", sev: 3,
    re: /BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY/,
    msg: "A private key is about to be committed." },
  { kind: "secret", sev: 3,
    re: /(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passwd|password|pwd)\b\s*[:=]\s*["'][^"'\s]{7,}["']/i,
    skip: /["'](your[-_ ]|xxx|changeme|todo|placeholder)/i,
    msg: "Hardcoded credential in a string literal. Prefer an environment variable or an uncommitted local config." },
  { kind: "bug", sev: 2, re: /\beval\s*\(|\bexec\s*\(/,
    msg: "eval/exec runs text as code: dangerous with anything but fully trusted input." },
  { kind: "bug", sev: 2, re: /^\s*except\s*:/,
    msg: "Bare except swallows every error, including real bugs. Catch a specific exception." },
  { kind: "bug", sev: 2, re: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\})/,
    msg: "Mutable default argument: one list/dict shared across every call. Default to None instead." },
  { kind: "bug", sev: 2, re: /shell\s*=\s*True/,
    msg: "shell=True plus any interpolated value is a command injection risk." },
  { kind: "bug", sev: 2, re: /pickle\.loads?\s*\(/,
    msg: "Unpickling data you did not create runs arbitrary code." },
  { kind: "bug", sev: 1, re: /\.innerHTML\s*=/,
    msg: "innerHTML assignment: if the value carries user data, that is an XSS hole. Prefer textContent." },
  { kind: "dead", sev: 1,
    re: /^\s*(#|\/\/)\s*(def |function |return\b|if\s|for\s|while\s|import |from |var |let |const |class |print\(|console\.)/,
    msg: "Commented-out code. Delete it; git remembers." },
  { kind: "debug", sev: 1, re: /\bdebugger\s*;/,
    msg: "A debugger statement is still in here." },
  { kind: "debug", sev: 1, re: /\bconsole\.log\s*\(/,
    exts: ["js", "mjs", "ts", "tsx", "jsx"],
    msg: "console.log left in (fine while debugging, noisy in a commit)." },
  { kind: "debug", sev: 1, re: /(^|\s)print\s*\(/,
    exts: ["py"], skipFile: /test/i,
    msg: "print() left in (fine while debugging, noisy in a commit)." },
  { kind: "todo", sev: 0, re: /\b(TODO|FIXME|XXX|HACK)\b/,
    msg: "New TODO/FIXME marker added." },
];
function reviewDiff(diff) {
  const findings = [];
  const seen = new Set();
  for (const f of parseDiff(diff)) {
    const ext = (f.file.split(".").pop() || "").toLowerCase();
    for (const add of f.additions) {
      for (const rule of REVIEW_RULES) {
        if (rule.exts && !rule.exts.includes(ext)) continue;
        if (rule.skipFile && rule.skipFile.test(f.file)) continue;
        if (rule.skip && rule.skip.test(add.text)) continue;
        if (!rule.re.test(add.text)) continue;
        const snippet = add.text.trim().slice(0, 120);
        let hash = 0;
        const key = f.file + "|" + add.line + "|" + rule.kind +
          "|" + snippet;
        for (let i = 0; i < key.length; i++) {
          hash = ((hash * 31) + key.charCodeAt(i)) | 0;
        }
        const id = "r" + (hash >>> 0).toString(36);
        if (seen.has(id)) continue;
        seen.add(id);
        findings.push({ id, file: f.file, line: add.line,
          kind: rule.kind, sev: rule.sev, msg: rule.msg,
          snippet });
      }
    }
  }
  findings.sort((a, b) => b.sev - a.sev ||
    a.file.localeCompare(b.file) || a.line - b.line);
  return findings;
}
window.__ghostReview = reviewDiff;
/*@@REVIEW-END@@*/
function reviewDismissed() {
  try {
    return new Set(JSON.parse(
      localStorage.getItem("ghostide-review-dismissed") || "[]"));
  } catch (e) { return new Set(); }
}
function reviewDismiss(id) {
  const s = reviewDismissed();
  s.add(id);
  localStorage.setItem("ghostide-review-dismissed",
    JSON.stringify([...s].slice(-300)));
}
let reviewLastDiff = "";
async function openReview() {
  $("reviewPanel").classList.remove("hidden");
  $("reviewTitle").textContent = "🔍 Pre-commit review";
  $("reviewOut").innerHTML = "<div class=\"dim\">Scanning the diff…</div>";
  $("reviewAiOut").textContent = "";
  const r = await fetch("/api/git/diff-all");
  const d = await r.json();
  if (d.repo === false || d.error) {
    $("reviewOut").innerHTML = "<div class=\"dim\">Not a git " +
      "repo (or git unavailable here).</div>";
    return;
  }
  if (!d.diff || !d.diff.trim()) {
    $("reviewOut").innerHTML = "<div class=\"dim\">No changes " +
      "to review.</div>";
    return;
  }
  reviewLastDiff = d.diff;
  const dismissed = reviewDismissed();
  const findings = reviewDiff(d.diff)
    .filter((f) => !dismissed.has(f.id));
  const out = $("reviewOut");
  out.innerHTML = "";
  if (!findings.length) {
    out.innerHTML = "<div class=\"reviewClean\">✅ Nothing " +
      "flagged by the rules scan (secrets, bug risks, dead " +
      "code). Ask Ghost for a second opinion any time.</div>";
    return;
  }
  const sevName = ["note", "low", "risk", "SECRET"];
  const sevClass = ["sev0", "sev1", "sev2", "sev3"];
  for (const f of findings) {
    const row = document.createElement("div");
    row.className = "reviewRow";
    const chip = document.createElement("span");
    chip.className = "revSev " + sevClass[f.sev];
    chip.textContent = f.kind === "secret" ? "SECRET" : sevName[f.sev];
    const jump = document.createElement("button");
    jump.className = "revJump";
    jump.textContent = f.file + ":" + f.line;
    jump.onclick = async () => {
      await openFile(f.file);
      if (currentFile === f.file) jumpToLine(f.line);
    };
    const msg = document.createElement("span");
    msg.textContent = f.msg;
    const snip = document.createElement("div");
    snip.className = "revSnip";
    snip.textContent = f.snippet;
    const dis = document.createElement("button");
    dis.textContent = "✕ Dismiss";
    dis.onclick = () => { reviewDismiss(f.id); row.remove(); };
    row.append(chip, jump, msg, dis, snip);
    out.appendChild(row);
  }
}
$("gitReview").onclick = openReview;
$("reviewClose").onclick = () =>
  $("reviewPanel").classList.add("hidden");
$("reviewAiBtn").onclick = async () => {
  if (!modelUp) { alert("Start the model first."); return; }
  if (!reviewLastDiff) { alert("Run the review first."); return; }
  $("reviewAiOut").textContent = "Ghost is reading the diff…";
  try {
    const text = await collectChat([
      { role: "system", content: "You are a strict but fair " +
        "code reviewer. Read the diff and report real issues " +
        "only: bugs, security risks, dead code. Anchor each " +
        "point as file:line. If the diff is clean, say so in " +
        "one line. No praise, no filler." },
      { role: "user", content: "Review this diff:\n\n" +
        reviewLastDiff.slice(0, 7000) }], 700);
    $("reviewAiOut").textContent = text;
  } catch (e) {
    $("reviewAiOut").textContent = "AI review failed: " + e;
  }
};

/* ---------------- Roadmap G28: offline reference docs ----
   Search the bundled refdocs.json (Python stdlib slice from
   the real pydoc data + hand-written JavaScript core). The
   Ask button drops the page into the chat box so Ghost
   answers from the page instead of guessing - the whole
   loop is offline. */
let rdCurrentEntry = null;
async function rdSearch() {
  const q = $("rdQuery").value.trim();
  $("rdEntry").classList.add("hidden");
  const box = $("rdResults");
  if (!q) { box.innerHTML = ""; return; }
  box.innerHTML = "<div class=\"dim\">Searching…</div>";
  try {
    const r = await fetch("/api/refdocs/search?q=" +
      encodeURIComponent(q));
    const d = await r.json();
    box.innerHTML = "";
    if (!d.results.length) {
      box.innerHTML = "<div class=\"dim\">No matches in the " +
        "bundled reference.</div>";
      return;
    }
    for (const res of d.results) {
      const row = document.createElement("div");
      row.className = "ctxRow";
      row.textContent = (res.lang === "py" ? "🐍 " : "🟨 ") +
        res.title + " — " + res.summary;
      row.onclick = () => rdOpen(res.id);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = "<div class=\"dim\">Search failed: " +
      e + "</div>";
  }
}
async function rdOpen(id) {
  try {
    const r = await fetch("/api/refdocs/get?id=" +
      encodeURIComponent(id));
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    rdCurrentEntry = d.entry;
    $("rdEntryTitle").textContent = d.entry.title;
    $("rdEntryBody").textContent = d.entry.body;
    $("rdEntry").classList.remove("hidden");
    $("rdResults").innerHTML = "";
  } catch (e) { alert("Could not open the page: " + e); }
}
$("toolRefdocs").onclick = () => {
  hideTools();
  $("rdPanel").classList.remove("hidden");
  $("rdQuery").focus();
};
$("rdClose").onclick = () =>
  $("rdPanel").classList.add("hidden");
$("rdSearchBtn").onclick = rdSearch;
$("rdQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") rdSearch();
});
$("rdBack").onclick = () => {
  $("rdEntry").classList.add("hidden");
  rdSearch();
};
$("rdAsk").onclick = () => {
  if (!rdCurrentEntry) return;
  $("rdPanel").classList.add("hidden");
  $("chatText").value =
    "Answer from this reference page, not from memory.\n\n" +
    "--- " + rdCurrentEntry.title + " ---\n" +
    rdCurrentEntry.body.slice(0, 3000) +
    "\n\nMy question: ";
  $("chatText").focus();
};

/*@@CTX@@*/
/* ---------------- Roadmap G27: context lab ----------------
   The server counts tokens with a port of GhostSlice's
   calibrated estimator, so these numbers match
   `ghostslice scan` on the same tree. This module renders
   the heatmap + per-file costs and computes what-if slice
   comparisons client-side from the same stats. */
function sliceStats(files, opts) {
  let kept = 0, dropped = 0, keptToks = 0, droppedToks = 0;
  for (const f of files) {
    const toks = f.tokens || 0;
    let drop = false;
    if (opts.skipTests && (/(^|\/)(tests?|__tests__)(\/|$)/i
        .test(f.path) || /(^|\/)test[_-]/.test(f.path) ||
        /[_-](test|spec)\.[a-z0-9]+$/i.test(f.path)))
      drop = true;
    if (opts.skipDocs && /\.md$/i.test(f.path)) drop = true;
    if (opts.skipLocks && f.lock) drop = true;
    if (opts.maxBytes && f.bytes > opts.maxBytes) drop = true;
    if (opts.prefix && !f.path.startsWith(opts.prefix))
      drop = true;
    if (drop) { dropped++; droppedToks += toks; }
    else { kept++; keptToks += toks; }
  }
  return { kept, dropped, keptToks, droppedToks };
}
function fitWindow(files, budget) {
  // Greedy biggest-first fill: how much of the repo fits a
  // context window, and what gets left out.
  const sorted = [...files].sort(
    (x, y) => (y.tokens || 0) - (x.tokens || 0));
  let used = 0, inside = 0;
  for (const f of sorted) {
    const toks = f.tokens || 0;
    if (used + toks <= budget) { used += toks; inside++; }
  }
  return { used, inside, outside: files.length - inside };
}
window.__ghostCtx = { sliceStats, fitWindow };
/*@@CTX-END@@*/
let ctxStatsData = null;
function renderCtx() {
  if (!ctxStatsData) return;
  const d = ctxStatsData;
  $("ctxSummary").textContent =
    d.fileCount + " text files · " + fmtSize(d.totalBytes) +
    " · ≈ " + d.totalTokens.toLocaleString() +
    " tokens if Ghost read everything";
  const heat = $("ctxHeat");
  heat.innerHTML = "";
  const max = Math.max(1, ...d.files.map((f) => f.tokens || 0));
  for (const f of d.files.slice(0, 140)) {
    const tile = document.createElement("div");
    tile.className = "ctxTile";
    const ratio = (f.tokens || 0) / max;
    tile.style.background =
      "hsl(" + Math.round(210 - 190 * ratio) + ", 65%, " +
      (26 + Math.round(14 * ratio)) + "%)";
    tile.style.flexGrow = String(1 + Math.round(ratio * 5));
    tile.textContent = f.path.split("/").pop();
    tile.title = f.path + " · ≈ " +
      (f.tokens === null ? "?" : f.tokens.toLocaleString()) +
      " tokens · " + fmtSize(f.bytes);
    tile.onclick = () => openFile(f.path);
    heat.appendChild(tile);
  }
  const list = $("ctxList");
  list.innerHTML = "";
  for (const f of d.files.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "ctxRow";
    const pct = d.totalTokens
      ? ((f.tokens || 0) / d.totalTokens * 100).toFixed(1)
      : "0";
    row.textContent = f.path + " — ≈ " +
      (f.tokens === null ? "too large to count"
        : f.tokens.toLocaleString() + " tokens") +
      " (" + pct + "%) · " + fmtSize(f.bytes) +
      (f.lock ? " · lockfile" : "");
    row.onclick = () => openFile(f.path);
    list.appendChild(row);
  }
  renderCtxSlice();
}
function renderCtxSlice() {
  if (!ctxStatsData) return;
  const opts = {
    skipTests: $("ctxSkipTests").checked,
    skipDocs: $("ctxSkipDocs").checked,
    skipLocks: $("ctxSkipLocks").checked,
    maxBytes: parseInt($("ctxMaxSize").value, 10) || 0,
    prefix: $("ctxPrefix").value.trim(),
  };
  const s = sliceStats(ctxStatsData.files, opts);
  const total = ctxStatsData.totalTokens;
  const saved = total
    ? Math.round(s.droppedToks / total * 100) : 0;
  $("ctxSliceOut").textContent =
    "Slice keeps " + s.kept + " files / ≈ " +
    s.keptToks.toLocaleString() + " tokens; drops " +
    s.dropped + " files / ≈ " +
    s.droppedToks.toLocaleString() + " tokens (" + saved +
    "% saved).";
  const budget = parseInt($("ctxWindow").value, 10);
  const fit = fitWindow(ctxStatsData.files, budget);
  $("ctxFitOut").textContent =
    "A " + (budget / 1024) + "k window fits the " + fit.inside +
    " biggest files (≈ " + fit.used.toLocaleString() +
    " tokens); " + fit.outside + " files stay outside.";
}
async function openContextLab() {
  hideTools();
  $("ctxPanel").classList.remove("hidden");
  $("ctxTitle").textContent = "🧪 Context lab";
  $("ctxSummary").textContent = "Counting what Ghost sees…";
  try {
    const r = await fetch("/api/context/stats");
    ctxStatsData = await r.json();
    $("ctxMethod").textContent = ctxStatsData.method +
      " Lockfiles are counted (GhostSlice counts them too) " +
      "and can be sliced out below.";
    renderCtx();
  } catch (e) {
    $("ctxSummary").textContent = "Context lab failed: " + e;
  }
}
$("toolContext").onclick = openContextLab;
$("ctxRefresh").onclick = openContextLab;
$("ctxClose").onclick = () =>
  $("ctxPanel").classList.add("hidden");
for (const id of ["ctxSkipTests", "ctxSkipDocs", "ctxSkipLocks",
    "ctxMaxSize", "ctxWindow"]) {
  $(id).onchange = renderCtxSlice;
}
$("ctxPrefix").oninput = renderCtxSlice;

/*@@EM@@*/
/* ---------------- Roadmap G30: error memory ---------------
   Errors are remembered by a normalized signature (error
   line with paths, numbers and quoted names skeletonized).
   When a file that errored later runs clean after edits,
   the change that cleared it is stored as the fix. When
   the same signature shows up again - in ANY file - the
   run pane opens with "last time, this fixed it" before
   any new guessing. All local (localStorage). */
function emErrorLine(text) {
  const lines = String(text).split("\n")
    .map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(Error|Exception|error:|SyntaxError|Traceback)/
        .test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1] || "";
}
function emSignature(text) {
  let line = emErrorLine(text);
  line = line.replace(/(["']).*?\1/g, "…")
    .replace(/[A-Za-z]:[\\/][^\s]+/g, "<path>")
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, "<path>")
    .replace(/0x[0-9a-fA-F]+/g, "#")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ").trim().slice(0, 180);
  return line;
}
function emFixSummary(before, after) {
  const A = String(before).split("\n");
  const B = String(after).split("\n");
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  let j = 0;
  while (j < A.length - i && j < B.length - i &&
         A[A.length - 1 - j] === B[B.length - 1 - j]) j++;
  const oldPart = A.slice(i, A.length - j).slice(0, 6);
  const newPart = B.slice(i, B.length - j).slice(0, 6);
  if (!oldPart.length && !newPart.length)
    return "(the file was rewritten)";
  return oldPart.map((l) => "- " + l)
    .concat(newPart.map((l) => "+ " + l)).join("\n");
}
function emStore() {
  try {
    return JSON.parse(localStorage.getItem(
      "ghostide-error-memory") || "{}");
  } catch (e) { return {}; }
}
function emSave(store) {
  localStorage.setItem("ghostide-error-memory",
    JSON.stringify(store));
}
function emLookup(sig) {
  const store = emStore();
  return (store.entries || {})[sig] || null;
}
function emRecordError(errorText, file, beforeContent) {
  const sig = emSignature(errorText);
  if (!sig) return null;
  const store = emStore();
  store.pending = store.pending || {};
  const list = (store.pending[file] || []).filter(
    (p) => p.sig !== sig);
  list.push({ sig, sample: emErrorLine(errorText),
    before: beforeContent, ts: Date.now() });
  store.pending[file] = list.slice(-3);
  emSave(store);
  return emLookup(sig);
}
function emRecordClean(file, afterContent) {
  const store = emStore();
  const pend = (store.pending || {})[file] || [];
  if (!pend.length) return;
  store.entries = store.entries || {};
  for (const p of pend) {
    if (p.before === afterContent) continue;
    const prev = store.entries[p.sig];
    store.entries[p.sig] = {
      sig: p.sig, sample: p.sample, file,
      fix: emFixSummary(p.before, afterContent),
      ts: Date.now(), count: (prev ? prev.count : 0) + 1,
    };
  }
  // Cap the memory at the 60 most recent fixes.
  const keys = Object.keys(store.entries);
  if (keys.length > 60) {
    keys.sort((a, b) =>
      store.entries[a].ts - store.entries[b].ts);
    for (const k of keys.slice(0, keys.length - 60))
      delete store.entries[k];
  }
  store.pending[file] = [];
  emSave(store);
}
window.__ghostEM = { emSignature, emFixSummary, emRecordError,
  emRecordClean, emLookup };
/*@@EM-END@@*/
function renderEmPanel() {
  const store = emStore();
  const entries = Object.values(store.entries || {})
    .sort((a, b) => b.ts - a.ts);
  const box = $("emList");
  box.innerHTML = "";
  if (!entries.length) {
    box.innerHTML = "<div class=\"dim\">Nothing remembered " +
      "yet. When an error gets fixed by an edit and the file " +
      "runs clean, the fix lands here.</div>";
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "reviewRow";
    const head = document.createElement("span");
    head.textContent = e.sample + "  ·  first fixed in " +
      e.file + "  ·  " +
      new Date(e.ts).toLocaleDateString();
    const fix = document.createElement("div");
    fix.className = "revSnip";
    fix.textContent = e.fix;
    row.append(head, fix);
    box.appendChild(row);
  }
}
$("toolErrorMem").onclick = () => {
  hideTools();
  $("emPanel").classList.remove("hidden");
  renderEmPanel();
};
$("emClose").onclick = () =>
  $("emPanel").classList.add("hidden");
$("emClear").onclick = () => {
  if (!confirm("Forget every remembered error and fix?"))
    return;
  localStorage.removeItem("ghostide-error-memory");
  renderEmPanel();
};
function emBannerFor(errorText, file, beforeContent) {
  const mem = emRecordError(errorText, file, beforeContent);
  if (!mem) return "";
  return "⚡ Seen before. Last time, this fixed it (in " +
    mem.file + "):\n" + mem.fix + "\n\n— this time —\n";
}

/* ---------------- Roadmap G31: multi-cursor pack ---------
   basicSetup already brings multiple selections, Mod-d
   (selectNextOccurrence) and Alt-drag rectangular
   selection. These complete the pack. */
function addCursorLine(v, dir) {
  const sel = v.state.selection;
  const main = sel.main;
  const line = v.state.doc.lineAt(main.head);
  const targetNo = line.number + dir;
  if (targetNo < 1 || targetNo > v.state.doc.lines)
    return false;
  const target = v.state.doc.line(targetNo);
  const col = Math.min(main.head - line.from,
    target.length);
  const pos = target.from + col;
  const ranges = sel.ranges.slice();
  if (!ranges.some((r) => r.head === pos)) {
    ranges.push(EditorSelection.cursor(pos));
  }
  v.dispatch({ selection: EditorSelection.create(
    ranges, ranges.length - 1) });
  return true;
}
function selectAllOccurrences(v) {
  const sel = v.state.selection;
  const main = sel.main;
  let needle = v.state.sliceDoc(main.from, main.to);
  if (!needle) {
    // No selection: use the word at the cursor.
    const word = v.state.wordAt(main.head);
    if (!word) return false;
    needle = v.state.sliceDoc(word.from, word.to);
  }
  if (!needle) return false;
  const doc = v.state.doc.toString();
  const ranges = [];
  let idx = 0;
  while (ranges.length < 500) {
    const hit = doc.indexOf(needle, idx);
    if (hit < 0) break;
    ranges.push(EditorSelection.range(
      hit, hit + needle.length));
    idx = hit + Math.max(1, needle.length);
  }
  if (!ranges.length) return false;
  v.dispatch({ selection: EditorSelection.create(
    ranges, 0) });
  return true;
}
function cursorsOnSelectedLines(v) {
  const sel = v.state.selection;
  const main = sel.main;
  const first = v.state.doc.lineAt(main.from);
  const last = v.state.doc.lineAt(main.to);
  if (last.number - first.number < 1) return false;
  const ranges = [];
  for (let n = first.number; n <= last.number; n++) {
    ranges.push(EditorSelection.cursor(
      v.state.doc.line(n).to));
  }
  v.dispatch({ selection: EditorSelection.create(
    ranges, 0) });
  return true;
}

/*@@MACRO@@*/
/* ---------------- Roadmap G31: macros -------------------
   A macro is a list of steps applied to file text:
   replace (plain or regex), trim trailing whitespace,
   detab leading tabs, ensure a single final newline.
   While recording, project Find & Replace operations are
   captured as steps. Macros save to localStorage and can
   run on the current file or across a folder. */
function macroApply(content, steps) {
  let text = String(content);
  const counts = [];
  for (const step of steps) {
    let n = 0;
    if (step.kind === "replace") {
      if (step.regex) {
        // Line-oriented by design: macros clean files line
        // by line, so ^ and $ anchor per line.
        const re = new RegExp(step.find, "gm");
        text = text.replace(re, () => { n++; return step.replace; });
      } else {
        const parts = text.split(step.find);
        n = parts.length - 1;
        text = parts.join(step.replace);
      }
    } else if (step.kind === "trim") {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].replace(/[ \t]+$/, "");
        if (t !== lines[i]) { lines[i] = t; n++; }
      }
      text = lines.join("\n");
    } else if (step.kind === "detab") {
      const width = step.width || 2;
      text = text.replace(/^\t+/gm, (m) => {
        n += m.length;
        return " ".repeat(m.length * width);
      });
    } else if (step.kind === "newline") {
      const fixed = text.replace(/\s*$/, "") + "\n";
      n = fixed === text ? 0 : 1;
      text = fixed;
    }
    counts.push(n);
  }
  return { content: text, counts };
}
window.__ghostMacro = macroApply;
/*@@MACRO-END@@*/
function macroStore() {
  try {
    return JSON.parse(localStorage.getItem(
      "ghostide-macros") || "{}");
  } catch (e) { return {}; }
}
function macroSaveAll(all) {
  localStorage.setItem("ghostide-macros",
    JSON.stringify(all));
}
let macroRecording = null;   // steps array while recording
function macroCapture(step) {
  if (!macroRecording) return;
  macroRecording.push(step);
  renderMacroPanel();
}
function macroStepLabel(step) {
  if (step.kind === "replace")
    return (step.regex ? "regex replace " : "replace ") +
      JSON.stringify(step.find) + " → " +
      JSON.stringify(step.replace);
  if (step.kind === "trim") return "trim trailing whitespace";
  if (step.kind === "detab")
    return "leading tabs → " + (step.width || 2) + " spaces";
  if (step.kind === "newline")
    return "ensure single final newline";
  return step.kind;
}
function renderMacroPanel() {
  $("macroRecordBtn").textContent = macroRecording
    ? "⏹ Stop & save" : "⏺ Record";
  const all = macroStore();
  const sel = $("macroSelect");
  const cur = sel.value;
  sel.innerHTML = "";
  for (const name of Object.keys(all)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  if (cur && all[cur]) sel.value = cur;
  const name = sel.value;
  const steps = macroRecording ||
    (name ? all[name] : []) || [];
  const box = $("macroSteps");
  box.innerHTML = "";
  if (macroRecording) {
    const note = document.createElement("div");
    note.className = "dim";
    note.textContent = "⏺ Recording: " + steps.length +
      " step(s) so far. Project Find & Replace adds steps; " +
      "or add steps below, then Stop & save.";
    box.appendChild(note);
  }
  steps.forEach((step, i) => {
    const row = document.createElement("div");
    row.className = "reviewRow";
    const label = document.createElement("span");
    label.textContent = (i + 1) + ". " + macroStepLabel(step);
    const del = document.createElement("button");
    del.textContent = "✕";
    del.onclick = () => {
      if (macroRecording) {
        macroRecording.splice(i, 1);
      } else if (name) {
        all[name].splice(i, 1);
        macroSaveAll(all);
      }
      renderMacroPanel();
    };
    row.append(label, del);
    box.appendChild(row);
  });
  if (!steps.length && !macroRecording) {
    box.innerHTML = "<div class=\"dim\">No steps yet. " +
      "Record some edits or add steps below.</div>";
  }
}
async function macroRunOnFiles(name, paths) {
  const all = macroStore();
  const steps = all[name];
  if (!steps || !steps.length) {
    alert("That macro has no steps.");
    return;
  }
  const log = [];
  let changed = 0;
  for (const path of paths) {
    try {
      const r = await fetch("/api/file?path=" +
        encodeURIComponent(path));
      const d = await r.json();
      if (typeof d.content !== "string") continue;
      const out = macroApply(d.content, steps);
      if (out.content !== d.content) {
        if (path === currentFile) {
          view.dispatch({ changes: { from: 0,
            to: view.state.doc.length,
            insert: out.content } });
        } else {
          await postJson("/api/file",
            { path, content: out.content });
        }
        changed++;
        log.push(path + " ✓ (" +
          out.counts.reduce((a, b) => a + b, 0) + " edits)");
      } else {
        log.push(path + " · no change");
      }
    } catch (e) {
      log.push(path + " ✗ " + e);
    }
  }
  $("macroLog").textContent = "Macro \"" + name + "\": " +
    changed + "/" + paths.length + " file(s) changed.\n" +
    log.join("\n");
  loadFiles();
}
$("toolMacros").onclick = () => {
  hideTools();
  $("macroPanel").classList.remove("hidden");
  renderMacroPanel();
};
$("macroClose").onclick = () =>
  $("macroPanel").classList.add("hidden");
$("macroSelect").onchange = renderMacroPanel;
$("macroRecordBtn").onclick = () => {
  if (macroRecording) {
    const name = prompt("Name this macro:",
      "cleanup");
    if (name) {
      const all = macroStore();
      all[name] = macroRecording;
      macroSaveAll(all);
    }
    macroRecording = null;
  } else {
    macroRecording = [];
  }
  renderMacroPanel();
};
$("macroAddStep").onclick = () => {
  const kind = $("macroStepKind").value;
  let step = null;
  if (kind === "replace") {
    const find = $("macroFind").value;
    if (!find) { alert("A replace step needs Find text."); return; }
    step = { kind, find, replace: $("macroReplace").value,
      regex: $("macroRegex").checked };
  } else if (kind === "detab") {
    step = { kind, width: 2 };
  } else {
    step = { kind };
  }
  if (macroRecording) {
    macroRecording.push(step);
  } else {
    const name = $("macroSelect").value ||
      prompt("Name the new macro:", "cleanup");
    if (!name) return;
    const all = macroStore();
    all[name] = all[name] || [];
    all[name].push(step);
    macroSaveAll(all);
  }
  renderMacroPanel();
};
$("macroDelete").onclick = () => {
  const name = $("macroSelect").value;
  if (!name) return;
  if (!confirm("Delete macro \"" + name + "\"?")) return;
  const all = macroStore();
  delete all[name];
  macroSaveAll(all);
  renderMacroPanel();
};
$("macroRun").onclick = async () => {
  const name = $("macroSelect").value;
  if (!name) { alert("Pick or record a macro first."); return; }
  const scope = $("macroScope").value;
  if (scope === "file") {
    if (!currentFile) { alert("Open a file first."); return; }
    macroRunOnFiles(name, [currentFile]);
    return;
  }
  const prefix = $("macroPrefix").value.trim();
  const r = await fetch("/api/files");
  const d = await r.json();
  const paths = d.files
    .filter((f) => f.type === "file" &&
      (!prefix || f.path.startsWith(prefix)) &&
      /\.(py|js|mjs|ts|tsx|jsx|md|txt|json|html|css|go|rs|java|c|h|cpp|sh|sql)$/i
        .test(f.path))
    .map((f) => f.path)
    .slice(0, 200);
  if (!paths.length) {
    alert("No text files under that prefix.");
    return;
  }
  if (!confirm("Run macro \"" + name + "\" across " +
      paths.length + " file(s)? This edits them on disk."))
    return;
  macroRunOnFiles(name, paths);
};

/* ---------------- Roadmap G25: asset tools ----------------
   Asset browser: every image in the workspace with a
   thumbnail, dimensions, and size, heaviest first so the
   bloat is easy to spot. Icon maker: a canvas glyph plus
   simple shapes, exported as a PNG set at the sizes
   Android and the web want (written via /api/file64). */
const IMG_EXTS = ["png", "jpg", "jpeg", "gif", "webp",
  "svg", "bmp", "ico", "avif"];
let assetSortBySize = true;
function fmtSize(n) {
  if (n == null) return "?";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}
async function openAssets() {
  $("assetPanel").classList.remove("hidden");
  $("toolsPanel").classList.add("hidden");
  const r = await fetch("/api/files");
  const d = await r.json();
  const imgs = (d.files || []).filter((f) =>
    f.type === "file" && IMG_EXTS.includes(
      (f.path.split(".").pop() || "").toLowerCase()));
  imgs.sort((a, b) => assetSortBySize
    ? (b.size || 0) - (a.size || 0)
    : a.path.localeCompare(b.path));
  const grid = $("assetGrid");
  grid.innerHTML = "";
  if (!imgs.length) {
    grid.innerHTML = "<div class=\"dim\">No images in this " +
      "workspace yet. The icon maker below can create some.</div>";
  }
  imgs.forEach((f, i) => {
    const card = document.createElement("div");
    card.className = "assetCard" +
      (assetSortBySize && i === 0 && imgs.length > 1
        ? " heaviest" : "");
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = "/api/raw?path=" + encodeURIComponent(f.path);
    img.alt = f.path;
    const name = document.createElement("div");
    name.className = "aName";
    name.textContent = f.path;
    const meta = document.createElement("div");
    meta.className = "aMeta";
    meta.textContent = fmtSize(f.size) +
      (assetSortBySize && i === 0 && imgs.length > 1
        ? " · 🐘 heaviest" : "");
    img.onload = () => {
      meta.textContent = img.naturalWidth + "×" +
        img.naturalHeight + " · " + meta.textContent;
    };
    card.append(img, name, meta);
    card.onclick = () => {
      $("previewTitle").textContent = "Preview: " + f.path;
      const body = $("previewBody");
      body.innerHTML = "";
      const big = document.createElement("img");
      big.src = img.src;
      big.alt = f.path;
      body.appendChild(big);
      $("previewPanel").classList.remove("hidden");
    };
    grid.appendChild(card);
  });
  drawIcon();
}
function drawIcon() {
  const cv = $("iconCanvas");
  const ctx = cv.getContext("2d");
  const S = cv.width;
  ctx.clearRect(0, 0, S, S);
  const shape = $("iconShape").value;
  if (shape !== "none") {
    ctx.fillStyle = $("iconBg").value;
    ctx.beginPath();
    if (shape === "circle") {
      ctx.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2);
    } else if (shape === "rounded") {
      ctx.roundRect(4, 4, S - 8, S - 8, 96);
    } else {
      ctx.rect(4, 4, S - 8, S - 8);
    }
    ctx.fill();
  }
  const glyph = $("iconText").value || "👻";
  ctx.fillStyle = $("iconFg").value;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "300px system-ui, sans-serif";
  ctx.fillText(glyph, S / 2, S / 2 + 12);
}
async function makeIconSet() {
  drawIcon();
  const sizes = [
    [48, "icons/icon-48.png"], [72, "icons/icon-72.png"],
    [96, "icons/icon-96.png"], [144, "icons/icon-144.png"],
    [192, "icons/icon-192.png"], [512, "icons/icon-512.png"],
    [180, "icons/apple-touch-icon.png"],
    [32, "icons/favicon-32.png"],
  ];
  let ok = 0;
  for (const [size, path] of sizes) {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    c.getContext("2d").drawImage($("iconCanvas"), 0, 0, size, size);
    const b64 = c.toDataURL("image/png").split(",")[1];
    const r = await fetch("/api/file64", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, base64: b64 }),
    });
    const d = await r.json();
    if (!d.error) ok++;
  }
  $("iconMsg").textContent = "Wrote " + ok + " icon files to " +
    "icons/ (48-512 px, Apple touch icon, favicon).";
  loadFiles();
}
$("toolAssets").onclick = openAssets;
$("assetClose").onclick = () =>
  $("assetPanel").classList.add("hidden");
$("assetSortBtn").onclick = () => {
  assetSortBySize = !assetSortBySize;
  $("assetSortBtn").textContent = assetSortBySize
    ? "Largest first" : "Name A-Z";
  openAssets();
};
$("iconMakeBtn").onclick = makeIconSet;
for (const id of ["iconText", "iconShape", "iconBg", "iconFg"]) {
  $(id).addEventListener("input", drawIcon);
}

/* ---------------- Roadmap G23: API client ----------------
   Postman-lite. Requests are sent by the IDE's own server
   (/api/http), so local dev servers without CORS headers
   work fine. Saved requests live per project in
   .ghostide/api-requests.json; history is localStorage. */
const API_SAVE_PATH = ".ghostide/api-requests.json";
let apiSavedList = [];
function apiParseHeaders(text) {
  const out = {};
  for (const line of (text || "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
function apiForm() {
  return {
    method: $("apiMethod").value,
    url: $("apiUrl").value.trim(),
    headers: apiParseHeaders($("apiHeaders").value),
    headersText: $("apiHeaders").value,
    body: $("apiBody").value,
  };
}
function apiFill(r) {
  $("apiMethod").value = r.method || "GET";
  $("apiUrl").value = r.url || "";
  $("apiHeaders").value = r.headersText ||
    Object.entries(r.headers || {})
      .map(([k, v]) => k + ": " + v).join("\n");
  $("apiBody").value = r.body || "";
}
function apiHistory() {
  try {
    return JSON.parse(
      localStorage.getItem("ghostide-api-history") || "[]");
  } catch (e) { return []; }
}
function apiRenderHistory() {
  const wrap = $("apiHistory");
  wrap.innerHTML = "";
  const hist = apiHistory();
  if (!hist.length) return;
  const label = document.createElement("span");
  label.className = "dim";
  label.textContent = "History: ";
  wrap.appendChild(label);
  for (const h of hist) {
    const b = document.createElement("button");
    b.textContent = h.method + " " + h.status + " " +
      (h.url.length > 42 ? h.url.slice(0, 42) + "…" : h.url);
    b.title = h.url;
    b.onclick = () => apiFill(h);
    wrap.appendChild(b);
  }
}
function apiRenderSaved() {
  const wrap = $("apiSaved");
  wrap.innerHTML = "";
  if (!apiSavedList.length) return;
  const label = document.createElement("span");
  label.className = "dim";
  label.textContent = "Saved in this project: ";
  wrap.appendChild(label);
  apiSavedList.forEach((r, i) => {
    const b = document.createElement("button");
    b.textContent = r.name;
    b.onclick = () => apiFill(r);
    wrap.appendChild(b);
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = "Delete " + r.name;
    x.onclick = async () => {
      apiSavedList.splice(i, 1);
      await apiPersistSaved();
      apiRenderSaved();
    };
    wrap.appendChild(x);
  });
}
async function apiLoadSaved() {
  try {
    const r = await fetch("/api/file?path=" +
      encodeURIComponent(API_SAVE_PATH));
    const d = await r.json();
    if (d.content) {
      apiSavedList = JSON.parse(d.content).requests || [];
    }
  } catch (e) { apiSavedList = []; }
  apiRenderSaved();
}
async function apiPersistSaved() {
  await fetch("/api/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: API_SAVE_PATH,
      content: JSON.stringify({ requests: apiSavedList }, null, 2),
    }),
  });
}
async function apiSendNow() {
  const form = apiForm();
  if (!form.url) { $("apiStatus").textContent = "Enter a URL first."; return; }
  $("apiStatus").textContent = "Sending…";
  $("apiResp").textContent = "";
  $("apiRespHeaders").textContent = "";
  const r = await fetch("/api/http", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(form),
  });
  const d = await r.json();
  if (d.error) {
    $("apiStatus").textContent = "⚠ " + d.error;
    return;
  }
  $("apiStatus").textContent = "Status " + d.status + " · " +
    d.ms + " ms · " + d.size + " bytes" +
    (d.truncated ? " (body capped at 512 KB)" : "");
  $("apiRespHeaders").textContent =
    (d.headers || []).map(([k, v]) => k + ": " + v).join("\n");
  let body = d.body || "";
  try { body = JSON.stringify(JSON.parse(body), null, 2); }
  catch (e) { /* not JSON: show as-is */ }
  $("apiResp").textContent = body;
  const hist = apiHistory();
  hist.unshift({ ...form, status: d.status,
    t: new Date().toISOString() });
  localStorage.setItem("ghostide-api-history",
    JSON.stringify(hist.slice(0, 20)));
  apiRenderHistory();
}
function openApi() {
  $("apiPanel").classList.remove("hidden");
  $("toolsPanel").classList.add("hidden");
  apiLoadSaved();
  apiRenderHistory();
}
$("toolApi").onclick = openApi;
$("apiClose").onclick = () => $("apiPanel").classList.add("hidden");
$("apiSend").onclick = apiSendNow;
$("apiSaveBtn").onclick = async () => {
  const form = apiForm();
  if (!form.url) { $("apiStatus").textContent = "Enter a URL first."; return; }
  const name = prompt("Name this request:",
    form.method + " " + form.url.split("/").slice(-1)[0]);
  if (!name) return;
  apiSavedList.push({ name, ...form });
  await apiPersistSaved();
  apiRenderSaved();
  $("apiStatus").textContent = "Saved \"" + name +
    "\" to " + API_SAVE_PATH;
};

/* ---------------- Roadmap G22: SQLite studio ----------------
   Opening a .db/.sqlite file opens this studio instead of
   the text editor. Read-only by default; the write toggle
   is explicit, and SQLite itself enforces read-only (the
   server opens the file mode=ro), so a write query in
   read-only mode fails with SQLite's own error. */
const dbState = { path: null, write: false, tables: [] };
async function dbPost(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
function dbRenderGrid(cols, rows) {
  const t = $("dbGrid");
  t.innerHTML = "";
  if (!cols.length) return;
  const head = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  t.appendChild(head);
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const v of row) {
      const td = document.createElement("td");
      td.textContent = v === null ? "NULL" : String(v);
      if (v === null) td.className = "dim";
      tr.appendChild(td);
    }
    t.appendChild(tr);
  }
}
async function dbRun(sql) {
  const d = await dbPost("/api/db/query", {
    path: dbState.path, sql, write: dbState.write,
  });
  if (d.error) { $("dbMsg").textContent = "⚠ " + d.error; return; }
  if (d.columns && d.columns.length) {
    dbRenderGrid(d.columns, d.rows);
    $("dbMsg").textContent = d.rows.length + " row(s) in " +
      d.ms + " ms" + (d.truncated ? " (capped at 500)" : "");
  } else {
    $("dbGrid").innerHTML = "";
    $("dbMsg").textContent = "Done: " + d.rowcount +
      " row(s) affected in " + d.ms + " ms";
  }
}
async function dbLoadInfo() {
  const d = await dbPost("/api/db/info", { path: dbState.path });
  if (d.error) { $("dbMsg").textContent = "⚠ " + d.error; return; }
  dbState.tables = d.tables;
  const wrap = $("dbTables");
  wrap.innerHTML = "";
  for (const t of d.tables) {
    const b = document.createElement("button");
    b.textContent = "🗄️ " + t.name + " (" + t.count + ")";
    b.onclick = () => {
      $("dbSchema").textContent = t.name + ": " +
        t.columns.map((c) => c.name + " " + (c.type || "") +
          (c.pk ? " PK" : "")).join(", ");
      $("dbSql").value = "SELECT * FROM \"" + t.name +
        "\" LIMIT 100";
      dbRun($("dbSql").value);
    };
    wrap.appendChild(b);
  }
  $("dbMsg").textContent = d.tables.length +
    " table(s). Tap a table to preview it, or write a query.";
}
function openDbStudio(path) {
  dbState.path = path;
  dbState.write = false;
  $("dbWriteBtn").textContent = "🔒 Read-only";
  $("dbTitle").textContent = "🗄️ " + path;
  $("dbPanel").classList.remove("hidden");
  $("dbSchema").textContent = "";
  $("dbGrid").innerHTML = "";
  $("dbSql").value = "";
  dbLoadInfo();
}
$("dbClose").onclick = () => $("dbPanel").classList.add("hidden");
$("dbWriteBtn").onclick = () => {
  dbState.write = !dbState.write;
  $("dbWriteBtn").textContent = dbState.write
    ? "🔓 Edits allowed" : "🔒 Read-only";
  $("dbMsg").textContent = dbState.write
    ? "Write mode ON: INSERT/UPDATE/DELETE will change the file."
    : "Read-only mode.";
};
$("dbRunBtn").onclick = () => {
  const sql = $("dbSql").value.trim();
  if (sql) dbRun(sql);
};

/* ---------------- Roadmap G13: voice coding ----------------
   Phone only: the native side exposes GhostVoice.dictate via
   the system speech recognizer and calls back into
   __ghostVoiceResult. "Ask Ghost ..." sends straight to
   chat; exact phrases ("save file", "run it", "new file")
   act as commands; anything else is dictation into the
   target (chat box or editor cursor). Desktop has no bridge
   and gets a polite note instead. */
function startDictation(target) {
  if (window.GhostVoice && window.GhostVoice.dictate) {
    window.GhostVoice.dictate(target);
  } else {
    alert("Voice dictation uses the phone's speech "
      + "recognizer, so it is a phone feature. On desktop, "
      + "typing is the way.");
  }
}
$("chatMic").onclick = () => startDictation("chat");
$("voiceBtn").onclick = () => startDictation("editor");

const VOICE_COMMANDS = [
  [/^save( file)?\.?$/i, () => saveFile()],
  [/^run( it| the file| file)?\.?$/i, () => $("runBtn").click()],
  [/^new file\.?$/i, () => $("newFileBtn").click()],
];
window.__ghostVoiceResult = (target, text) => {
  if (!text) return;
  const said = text.trim();
  const ask = said.match(/^ask ghost[:,]?\s+(.+)$/i);
  if (ask) {
    $("chatText").value = ask[1];
    sendChat();
    return;
  }
  for (const [re, fn] of VOICE_COMMANDS) {
    if (re.test(said)) { fn(); return; }
  }
  if (target === "editor") {
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    view.focus();
  } else {
    const box = $("chatText");
    box.value = box.value ? box.value + " " + text : text;
    box.focus();
  }
};

/* ---------------- Roadmap G16: pair mode ----------------
   Two devices, one workspace: everyone opens the SAME
   GhostIDE server (usually the desktop on the LAN; the
   phone joins it from its Models screen, "Pair with a
   desktop"). While pair mode is on, this client heartbeats
   its presence (name, open file, dirty flag) and watches
   the open file's server copy. A clean editor auto-reloads
   a peer's changes; a save that would overwrite a peer's
   newer work is diverted to a .conflict-<name> copy
   instead of silently clobbering, and resolves from this
   panel. Hashing is FNV-1a over content (change
   detection, not security). */
let pairOn = false;
let pairId = "";
let pairName = "";
let pairPeers = [];
let pairConflict = null; // { path, conflictPath|null }
const pairBase = {};     // path -> hash last synced
let pairTimers = [];

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

function pairDecide(base, mine, server) {
  if (server === base && mine === base) return "clean";
  if (server === base) return "save";
  if (mine === base) return "reload";
  if (mine === server) return "insync";
  return "conflict";
}

function pairNoteOpened(path, content) {
  if (content != null) pairBase[path] = fnv1a(content);
}

function pairNoteSaved() {
  if (currentFile)
    pairBase[currentFile] = fnv1a(view.state.doc.toString());
}

function pairInit() {
  try {
    pairOn = localStorage.getItem("ghostide-pair-on") === "1";
    pairId = localStorage.getItem("ghostide-pair-id") || "";
    if (!pairId) {
      pairId = "d" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem("ghostide-pair-id", pairId);
    }
    pairName = localStorage.getItem("ghostide-pair-name")
      || "";
    if (!pairName) {
      pairName = (/android/i.test(navigator.userAgent)
        ? "phone" : "desktop") + "-" + pairId.slice(-3);
    }
  } catch (e) { pairOn = false; }
  if (pairOn) pairStartLoops();
  renderPairChip();
}

function pairStartLoops() {
  pairStopLoops();
  pairHeartbeat();
  pairTimers.push(setInterval(pairHeartbeat, 5000));
  pairTimers.push(setInterval(pairPoll, 8000));
}

function pairStopLoops() {
  for (const t of pairTimers) clearInterval(t);
  pairTimers = [];
}

function renderPairChip() {
  const chip = $("pairChip");
  if (!pairOn) {
    chip.classList.add("hidden");
    return;
  }
  chip.classList.remove("hidden");
  chip.textContent = pairConflict
    ? "👥⚠ conflict"
    : "👥 " + (pairPeers.length + 1);
}
$("pairChip").onclick = () => openPair();

async function pairHeartbeat() {
  if (!pairOn) return;
  try {
    const d = await postJson("/api/pair/heartbeat", {
      id: pairId, name: pairName,
      file: currentFile || "", dirty: !!dirty,
    });
    pairPeers = (d.peers || []).filter(
      (x) => x.id !== pairId);
  } catch (e) { /* server momentarily unreachable */ }
  renderPairChip();
}

async function pairPoll() {
  if (!pairOn || !currentFile || pairConflict) return;
  try {
    const r = await fetch("/api/file?path="
      + encodeURIComponent(currentFile));
    const d = await r.json();
    if (d.error || d.content == null) return;
    const server = fnv1a(d.content);
    const mine = fnv1a(view.state.doc.toString());
    const base = pairBase[currentFile] || server;
    pairBase[currentFile] = base;
    const what = pairDecide(base, mine, server);
    if (what === "reload") {
      const pos = Math.min(
        view.state.selection.main.head, d.content.length);
      accepting = true;
      view.dispatch({ changes: {
        from: 0, to: view.state.doc.length,
        insert: d.content },
        selection: { anchor: pos } });
      accepting = false;
      pairBase[currentFile] = server;
      addMsg("SYSTEM", "👥↻ " + currentFile
        + " was updated by a paired device - reloaded.");
    } else if (what === "insync") {
      pairBase[currentFile] = server;
    } else if (what === "conflict") {
      pairConflict = { path: currentFile, conflictPath: null };
      renderPairChip();
      addMsg("SYSTEM", "👥⚠ " + currentFile + " changed on "
        + "the server while you were editing it. Saves to "
        + "it are paused - open Pair mode (Tools) to "
        + "resolve. Your edits are safe in the editor.");
    }
  } catch (e) { /* try again next tick */ }
}

async function pairGuardSave() {
  if (!pairOn || !currentFile) return false;
  if (pairConflict && pairConflict.path === currentFile) {
    alert("This file has an unresolved pair conflict. "
      + "Resolve it in Tools, Pair mode - your work is "
      + "safe in the editor and the conflict copy.");
    return true;
  }
  if (pairConflict) return false;
  try {
    const r = await fetch("/api/file?path="
      + encodeURIComponent(currentFile));
    const d = await r.json();
    if (d.error || d.content == null) return false;
    const server = fnv1a(d.content);
    const mine = fnv1a(view.state.doc.toString());
    const base = pairBase[currentFile] || server;
    if (pairDecide(base, mine, server) !== "conflict")
      return false;
    const cpath = currentFile + ".conflict-" + pairName;
    const w = await postJson("/api/file", {
      path: cpath, content: view.state.doc.toString() });
    if (w.error) { alert(w.error); return true; }
    pairConflict = { path: currentFile, conflictPath: cpath };
    setSaveState("⚠ pair conflict - yours is in " + cpath);
    addMsg("SYSTEM", "👥⚠ Save protected: " + currentFile
      + " has newer work from a paired device, so your "
      + "version went to " + cpath + " instead of "
      + "overwriting it. Resolve in Tools, Pair mode.");
    renderPairChip();
    return true;
  } catch (e) { return false; }
}

async function openPair() {
  hideTools();
  $("todoTitle").textContent = "Pair mode";
  const box = $("todoResults");
  box.innerHTML = "";
  $("todoPanel").classList.remove("hidden");
  const head = document.createElement("div");
  head.className = "dim";
  head.textContent = pairOn
    ? "Pair mode is ON. You are \"" + pairName + "\". "
      + "Everyone must open the SAME GhostIDE server: "
      + "desktop on your LAN, phone joins from its Models "
      + "screen (Pair with a desktop)."
    : "Pair mode is OFF. Turn it on here, on every device "
      + "that shares this server.";
  box.appendChild(head);
  const tgl = document.createElement("div");
  tgl.className = "findRow";
  tgl.textContent = pairOn
    ? "⏸ Turn pair mode off" : "▶ Turn pair mode on";
  tgl.onclick = () => {
    pairOn = !pairOn;
    try {
      localStorage.setItem("ghostide-pair-on",
        pairOn ? "1" : "0");
    } catch (e) {}
    if (pairOn) pairStartLoops();
    else { pairStopLoops(); pairPeers = []; }
    renderPairChip();
    openPair();
  };
  box.appendChild(tgl);
  const nm = document.createElement("div");
  nm.className = "findRow";
  nm.textContent = "✎ Device name: " + pairName;
  nm.onclick = () => {
    const v = prompt("Name for this device:", pairName);
    if (v && v.trim()) {
      pairName = v.trim().slice(0, 40);
      try {
        localStorage.setItem("ghostide-pair-name", pairName);
      } catch (e) {}
      pairHeartbeat();
      openPair();
    }
  };
  box.appendChild(nm);
  if (pairConflict) {
    const c = pairConflict;
    const info = document.createElement("div");
    info.className = "dim";
    info.textContent = "⚠ Conflict on " + c.path
      + (c.conflictPath
        ? " - your version is in " + c.conflictPath
        : "")
      + ". The server copy was not overwritten.";
    box.appendChild(info);
    if (c.path !== currentFile) {
      const op = document.createElement("div");
      op.className = "findRow";
      op.textContent = "📂 Open " + c.path + " to resolve";
      op.onclick = () => {
        $("todoPanel").classList.add("hidden");
        openFile(c.path);
      };
      box.appendChild(op);
    } else {
      const km = document.createElement("div");
      km.className = "findRow";
      km.textContent = "⬆ Keep mine (overwrite the server "
        + "copy with my editor)";
      km.onclick = async () => {
        const w = await postJson("/api/file", {
          path: c.path,
          content: view.state.doc.toString() });
        if (w.error) { alert(w.error); return; }
        pairBase[c.path] = fnv1a(
          view.state.doc.toString());
        pairConflict = null;
        dirty = false;
        tabDirty.set(c.path, false);
        renderTabs();
        renderPairChip();
        addMsg("SYSTEM", "👥 Conflict resolved: your "
          + "version won for " + c.path + ".");
        openPair();
      };
      box.appendChild(km);
      const ks = document.createElement("div");
      ks.className = "findRow";
      ks.textContent = "⬇ Use the server version (my "
        + "edits stay in the conflict copy)";
      ks.onclick = async () => {
        if (!c.conflictPath) {
          c.conflictPath = c.path + ".conflict-" + pairName;
          const w = await postJson("/api/file", {
            path: c.conflictPath,
            content: view.state.doc.toString() });
          if (w.error) { alert(w.error); return; }
        }
        const r = await fetch("/api/file?path="
          + encodeURIComponent(c.path));
        const d = await r.json();
        if (d.error) { alert(d.error); return; }
        accepting = true;
        view.dispatch({ changes: {
          from: 0, to: view.state.doc.length,
          insert: d.content } });
        accepting = false;
        pairBase[c.path] = fnv1a(d.content);
        pairConflict = null;
        dirty = false;
        tabDirty.set(c.path, false);
        renderTabs();
        renderPairChip();
        addMsg("SYSTEM", "👥 Conflict resolved: server "
          + "version loaded for " + c.path + ".");
        openPair();
      };
      box.appendChild(ks);
      if (c.conflictPath) {
        const oc = document.createElement("div");
        oc.className = "findRow";
        oc.textContent = "👁 Open my conflict copy ("
          + c.conflictPath + ")";
        oc.onclick = () => {
          $("todoPanel").classList.add("hidden");
          openFile(c.conflictPath);
        };
        box.appendChild(oc);
      }
    }
  }
  if (pairOn) {
    await pairHeartbeat();
    if (!pairPeers.length) {
      const none = document.createElement("div");
      none.className = "dim";
      none.textContent = "No other devices yet. Open this "
        + "same server on the other device and turn pair "
        + "mode on there too.";
      box.appendChild(none);
    }
    for (const p of pairPeers) {
      const row = document.createElement("div");
      row.className = "findRow";
      row.textContent = "👥 " + p.name + (p.file
        ? " - " + p.file + (p.dirty ? " (editing)" : "")
        : " - no file open");
      if (p.file) row.onclick = () => {
        $("todoPanel").classList.add("hidden");
        openFile(p.file);
      };
      box.appendChild(row);
    }
  }
}
$("toolPair").onclick = openPair;

/* ---------------- Roadmap G17: encrypted backup ----------------
   Off by default - nothing happens until you create one.
   The server zips the workspace (same file set as the zip
   export) and encrypts it with your passphrase (PBKDF2 +
   HMAC keystream, encrypt-then-MAC; format shared with
   the phone build, see server.py / BackupCrypto.java).
   The passphrase is never stored anywhere; lose it and
   the backup is unrecoverable, by design. */
async function openBackup() {
  hideTools();
  $("todoTitle").textContent = "Encrypted backup";
  const box = $("todoResults");
  box.innerHTML = "";
  $("todoPanel").classList.remove("hidden");
  const note = document.createElement("div");
  note.className = "dim";
  note.textContent = "Backups are encrypted with a "
    + "passphrase only you know (it is never saved). The "
    + ".ghostbak file lands in the workspace's backups/ "
    + "folder - move it somewhere safe (Drive, WebDAV, "
    + "USB). Restore overwrites files with the same names.";
  box.appendChild(note);
  const mk = document.createElement("div");
  mk.className = "findRow";
  mk.textContent = "🔐 Create encrypted backup…";
  mk.onclick = async () => {
    const pw = prompt("Passphrase for this backup "
      + "(at least 8 characters):");
    if (!pw) return;
    if (pw.length < 8) {
      alert("That passphrase is too short (8+ characters).");
      return;
    }
    const pw2 = prompt("Type the passphrase again:");
    if (pw2 !== pw) {
      alert("The passphrases did not match. Nothing made.");
      return;
    }
    const d = await postJson("/api/backup/create",
      { passphrase: pw });
    if (d.error) { alert(d.error); return; }
    addMsg("SYSTEM", "🔐 Backup created: " + d.path
      + " (" + d.files + " files, "
      + Math.round(d.size / 1024) + " KB). Move it off "
      + "this device to finish the job.");
    openBackup();
  };
  box.appendChild(mk);
  let files = [];
  try {
    const fr = await fetch("/api/files");
    const fd = await fr.json();
    files = (fd.files || []).map((f) => f.path)
      .filter((p) => p.startsWith("backups/")
        && p.endsWith(".ghostbak"));
  } catch (e) { /* list is best-effort */ }
  if (!files.length) {
    const none = document.createElement("div");
    none.className = "dim";
    none.textContent = "No backups in this workspace yet. "
      + "To restore one from elsewhere, put its .ghostbak "
      + "file in the backups/ folder first.";
    box.appendChild(none);
  }
  for (const p of files) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "↩ Restore " + p;
    row.onclick = async () => {
      if (!confirm("Restore " + p + "? Files with the "
          + "same names are overwritten.")) return;
      const pw = prompt("Passphrase for this backup:");
      if (!pw) return;
      const d = await postJson("/api/backup/restore",
        { path: p, passphrase: pw });
      if (d.error) { alert(d.error); return; }
      addMsg("SYSTEM", "🔐 Restored " + d.files
        + " files (" + d.bytes + " bytes) from " + p
        + ".");
      $("todoPanel").classList.add("hidden");
      await loadFiles();
    };
    box.appendChild(row);
  }
}
$("toolBackup").onclick = openBackup;

/* ---------------- Roadmap G15: plugin system ----------------
   A plugin is a folder in plugins/<id>/ holding
   plugin.json (manifest: name, version, description,
   actions) and plugin.js. The script runs in a sandboxed
   iframe (opaque origin, no access to this page) and talks
   to the IDE only through the ghost API, carried over
   postMessage RPC:
     ghost.files.list() / read(path) / write(path, content)
     ghost.editor.current() / selection() / insert(text)
       / open(path)
     ghost.ask(prompt) - one-shot chat with the local model
     ghost.ui.show() / hide() / notify(text)
     ghost.onAction(id, fn) - handle a manifest action
   Writes go through /api/file, so they stay inside the
   workspace and land in Local History like any save.
   Honest limit: the sandbox isolates the plugin from this
   page and confines it to the API; it is not a network
   sandbox. Keep the literal text of a closing script tag
   out of plugin.js - it would end the sandbox document. */
const PLUGIN_DIR = "plugins";
let plugins = [];
let pluginCommands = [];
let activePlugin = null;

const PLUGIN_CSS = "body{font-family:system-ui,sans-serif;"
  + "background:#14161c;color:#e8eaf2;margin:10px;"
  + "font-size:14px}h3{margin:4px 0 8px}h4{margin:12px 0 4px}"
  + "table{border-collapse:collapse}"
  + "td{padding:2px 10px 2px 0}.dim{color:#9aa0b4}"
  + "pre{white-space:pre-wrap}";

const PLUGIN_SHIM = `
var __id = 0, __pending = {}, __handlers = {};
function __call(method, args) {
  return new Promise(function (resolve, reject) {
    var id = ++__id;
    __pending[id] = { resolve: resolve, reject: reject };
    parent.postMessage(
      { kind: "rpc", id: id, method: method, args: args || [] },
      "*");
  });
}
window.addEventListener("message", function (ev) {
  var m = ev.data || {};
  if (m.kind === "rpc-result") {
    var p = __pending[m.id];
    if (!p) return;
    delete __pending[m.id];
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error || "plugin call failed"));
  } else if (m.kind === "action") {
    var h = __handlers[m.action];
    if (!h) return;
    Promise.resolve().then(h).catch(function (e) {
      __call("ui.notify",
        ["Plugin error: " + ((e && e.message) || e)]);
    });
  }
});
var ghost = {
  onAction: function (id, fn) { __handlers[id] = fn; },
  files: {
    list: function () { return __call("files.list"); },
    read: function (p) { return __call("files.read", [p]); },
    write: function (p, c) {
      return __call("files.write", [p, c]);
    }
  },
  editor: {
    current: function () { return __call("editor.current"); },
    selection: function () {
      return __call("editor.selection");
    },
    insert: function (t) {
      return __call("editor.insert", [t]);
    },
    open: function (p) { return __call("editor.open", [p]); }
  },
  ask: function (prompt) {
    return __call("ghost.ask", [prompt]);
  },
  ui: {
    show: function () { return __call("ui.show"); },
    hide: function () { return __call("ui.hide"); },
    notify: function (t) { return __call("ui.notify", [t]); }
  }
};
window.addEventListener("error", function (e) {
  __call("ui.notify", ["Plugin error: " + e.message]);
});
`;

const SAMPLE_PLUGINS = [
  { id: "word-count-pro",
    manifest: "{\"actions\":[{\"id\":\"count\",\"title\":\"Word count (pro)\"}],\"description\":\"Word, character and line counts with top words and reading time, for the current file or selection.\",\"id\":\"word-count-pro\",\"name\":\"Word Count Pro\",\"version\":\"1.0.0\"}", code: "// Word Count Pro - a GhostIDE sample plugin.\n// Counts the current selection, or the whole open file,\n// and shows a small report in the plugin panel.\nfunction esc(s) {\n  return String(s).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\");\n}\n\nghost.onAction(\"count\", async function () {\n  var sel = await ghost.editor.selection();\n  var cur = await ghost.editor.current();\n  if (!cur) {\n    await ghost.ui.notify(\"Open a file first.\");\n    return;\n  }\n  var usingSel = !!(sel && sel.trim());\n  var text = usingSel ? sel : cur.content;\n  var label = (usingSel ? \"selection in \" : \"\") + cur.path;\n  var words = text.toLowerCase().match(/[a-z0-9']+/g) || [];\n  var freq = {};\n  words.forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });\n  var top = Object.keys(freq)\n    .sort(function (a, b) { return freq[b] - freq[a]; })\n    .slice(0, 5);\n  var lines = text ? text.split(\"\\n\").length : 0;\n  var minutes = Math.max(1, Math.round(words.length / 200));\n  var topRows = top.map(function (w) {\n    return \"<tr><td>\" + esc(w) + \"</td><td>\" + freq[w]\n      + \"</td></tr>\";\n  }).join(\"\");\n  document.body.innerHTML =\n    \"<h3>Word Count Pro</h3>\"\n    + \"<p class='dim'>\" + esc(label) + \"</p>\"\n    + \"<table>\"\n    + \"<tr><td>Words</td><td><b>\" + words.length\n    + \"</b></td></tr>\"\n    + \"<tr><td>Characters</td><td><b>\" + text.length\n    + \"</b></td></tr>\"\n    + \"<tr><td>Lines</td><td><b>\" + lines + \"</b></td></tr>\"\n    + \"<tr><td>Reading time</td><td><b>~\" + minutes\n    + \" min</b></td></tr>\"\n    + \"</table>\"\n    + \"<h4>Top words</h4><table>\" + topRows + \"</table>\";\n  await ghost.ui.show();\n});\n" },
  { id: "json-toolbox",
    manifest: "{\"actions\":[{\"id\":\"format\",\"title\":\"JSON: format\"},{\"id\":\"minify\",\"title\":\"JSON: minify\"},{\"id\":\"validate\",\"title\":\"JSON: validate\"}],\"description\":\"Format, minify and validate JSON in the current file or selection.\",\"id\":\"json-toolbox\",\"name\":\"JSON Toolbox\",\"version\":\"1.0.0\"}", code: "// JSON Toolbox - a GhostIDE sample plugin.\n// Format, minify and validate the current selection,\n// or the whole open file.\nfunction esc(s) {\n  return String(s).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\");\n}\n\nasync function target() {\n  var sel = await ghost.editor.selection();\n  var cur = await ghost.editor.current();\n  if (!cur) {\n    await ghost.ui.notify(\"Open a JSON file first.\");\n    return null;\n  }\n  var usingSel = !!(sel && sel.trim());\n  return {\n    cur: cur,\n    usingSel: usingSel,\n    text: usingSel ? sel : cur.content,\n  };\n}\n\nasync function apply(t, newText) {\n  if (t.usingSel) {\n    await ghost.editor.insert(newText);\n  } else {\n    await ghost.files.write(t.cur.path, newText);\n  }\n}\n\nghost.onAction(\"format\", async function () {\n  var t = await target();\n  if (!t) return;\n  try {\n    var v = JSON.parse(t.text);\n    await apply(t, JSON.stringify(v, null, 2));\n    await ghost.ui.notify(\"JSON formatted.\");\n  } catch (e) {\n    await ghost.ui.notify(\"Invalid JSON: \" + e.message);\n  }\n});\n\nghost.onAction(\"minify\", async function () {\n  var t = await target();\n  if (!t) return;\n  try {\n    var v = JSON.parse(t.text);\n    await apply(t, JSON.stringify(v));\n    await ghost.ui.notify(\"JSON minified.\");\n  } catch (e) {\n    await ghost.ui.notify(\"Invalid JSON: \" + e.message);\n  }\n});\n\nghost.onAction(\"validate\", async function () {\n  var t = await target();\n  if (!t) return;\n  try {\n    JSON.parse(t.text);\n    document.body.innerHTML =\n      \"<h3>JSON Toolbox</h3><p>Valid JSON \u2713</p>\"\n      + \"<p class='dim'>\" + esc(t.cur.path) + \"</p>\";\n  } catch (e) {\n    document.body.innerHTML =\n      \"<h3>JSON Toolbox</h3><p>Invalid JSON:</p>\"\n      + \"<pre>\" + esc(e.message) + \"</pre>\"\n      + \"<p class='dim'>\" + esc(t.cur.path) + \"</p>\";\n  }\n  await ghost.ui.show();\n});\n" },
];

function pluginsDisabled() {
  try {
    return JSON.parse(
      localStorage.getItem("ghostide-plugins-disabled")
      || "[]");
  } catch (e) { return []; }
}

function setPluginDisabled(id, off) {
  const arr = pluginsDisabled().filter((x) => x !== id);
  if (off) arr.push(id);
  localStorage.setItem("ghostide-plugins-disabled",
    JSON.stringify(arr));
}

async function discoverPlugins() {
  const host = $("pluginFrameHost");
  host.innerHTML = "";
  plugins = [];
  pluginCommands = [];
  activePlugin = null;
  $("pluginPanel").classList.add("hidden");
  let paths = [];
  try {
    const fr = await fetch("/api/files");
    const fd = await fr.json();
    paths = (fd.files || []).map((f) => f.path);
  } catch (e) { renderPluginTools(); return; }
  const dirs = [];
  for (const p of paths) {
    const m = p.match(
      /^plugins\/([^/]+)\/plugin\.json$/);
    if (m && !dirs.includes(m[1])) dirs.push(m[1]);
  }
  const disabled = pluginsDisabled();
  for (const dir of dirs) {
    try {
      const base = PLUGIN_DIR + "/" + dir;
      const mj = await (await fetch("/api/file?path="
        + encodeURIComponent(base + "/plugin.json"))).json();
      if (mj.error) continue;
      const man = JSON.parse(mj.content);
      const jj = await (await fetch("/api/file?path="
        + encodeURIComponent(base + "/plugin.js"))).json();
      if (jj.error) continue;
      const id = man.id || dir;
      plugins.push({
        id: id, name: man.name || id,
        version: man.version || "",
        description: man.description || "",
        actions: Array.isArray(man.actions) ? man.actions : [],
        dir: base, js: jj.content,
        enabled: !disabled.includes(id), frame: null,
      });
    } catch (e) { /* malformed plugin: skipped */ }
  }
  for (const p of plugins) if (p.enabled) makePluginFrame(p);
  renderPluginTools();
}

function makePluginFrame(p) {
  const f = document.createElement("iframe");
  f.className = "pluginFrame";
  f.setAttribute("sandbox", "allow-scripts");
  f.style.display = "none";
  f.srcdoc = "<!doctype html><html><head><meta charset='utf-8'>"
    + "<style>" + PLUGIN_CSS + "</style></head><body>"
    + "<script>" + PLUGIN_SHIM + "<\/script>"
    + "<script>" + p.js + "<\/script>"
    + "</body></html>";
  $("pluginFrameHost").appendChild(f);
  p.frame = f;
}

window.addEventListener("message", async (ev) => {
  const p = plugins.find((x) =>
    x.frame && x.frame.contentWindow === ev.source);
  if (!p) return;
  const m = ev.data || {};
  if (m.kind !== "rpc") return;
  try {
    const value = await pluginRpc(p, m.method, m.args || []);
    ev.source.postMessage({
      kind: "rpc-result", id: m.id, ok: true,
      value: value === undefined ? null : value,
    }, "*");
  } catch (e) {
    ev.source.postMessage({
      kind: "rpc-result", id: m.id, ok: false,
      error: String((e && e.message) || e),
    }, "*");
  }
});

async function pluginRpc(p, method, args) {
  switch (method) {
    case "files.list": {
      const fr = await fetch("/api/files");
      const fd = await fr.json();
      return (fd.files || []).map((f) => f.path);
    }
    case "files.read": {
      const r = await fetch("/api/file?path="
        + encodeURIComponent(args[0]));
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      return d.content;
    }
    case "files.write": {
      const d = await postJson("/api/file",
        { path: args[0], content: args[1] });
      if (d.error) throw new Error(d.error);
      if (args[0] === currentFile) {
        if (dirty) throw new Error(
          "the open file has unsaved changes - save it first");
        accepting = true;
        view.dispatch({ changes: {
          from: 0, to: view.state.doc.length,
          insert: args[1] } });
        accepting = false;
      }
      return true;
    }
    case "editor.current": {
      if (!currentFile) throw new Error("no file is open");
      return {
        path: currentFile,
        content: view.state.doc.toString(),
      };
    }
    case "editor.selection": {
      const sel = view.state.selection.main;
      return view.state.doc.sliceString(sel.from, sel.to);
    }
    case "editor.insert": {
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: args[0] },
        selection: { anchor: sel.from + args[0].length },
      });
      view.focus();
      return true;
    }
    case "editor.open": {
      await openFile(args[0]);
      return true;
    }
    case "ghost.ask": {
      return await collectChat(
        [{ role: "user", content: args[0] }], 1024);
    }
    case "ui.show": {
      showPluginPanel(p);
      return true;
    }
    case "ui.hide": {
      $("pluginPanel").classList.add("hidden");
      return true;
    }
    case "ui.notify": {
      addMsg("SYSTEM", "🔌 " + p.name + ": " + args[0]);
      return true;
    }
  }
  throw new Error("unknown plugin method: " + method);
}

function showPluginPanel(p) {
  activePlugin = p;
  $("pluginPanelTitle").textContent = "🔌 " + p.name;
  for (const x of plugins) {
    if (x.frame)
      x.frame.style.display = x === p ? "block" : "none";
  }
  $("pluginPanel").classList.remove("hidden");
}
$("pluginPanelClose").onclick = () =>
  $("pluginPanel").classList.add("hidden");

function runPluginAction(p, actionId) {
  if (!p.frame) makePluginFrame(p);
  if (p.frame.contentWindow)
    p.frame.contentWindow.postMessage(
      { kind: "action", action: actionId }, "*");
}

function renderPluginTools() {
  const grid = $("toolPlugins");
  grid.innerHTML = "";
  pluginCommands = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const a of p.actions) {
      const b = document.createElement("button");
      b.textContent = "🔌 " + (a.title || a.id);
      b.onclick = () => {
        hideTools();
        runPluginAction(p, a.id);
      };
      grid.appendChild(b);
      pluginCommands.push({
        title: (a.title || a.id) + " (" + p.name + ")",
        run: () => runPluginAction(p, a.id),
      });
    }
  }
  if (!grid.children.length)
    grid.innerHTML = '<span class="dim">No plugins yet. '
      + "Manage plugins… installs the samples.</span>";
}

async function openPlugins() {
  hideTools();
  $("todoTitle").textContent = "Plugins";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Scanning '
    + PLUGIN_DIR + "/ …</div>";
  $("todoPanel").classList.remove("hidden");
  await discoverPlugins();
  box.innerHTML = "";
  const note = document.createElement("div");
  note.className = "dim";
  note.textContent = "Plugins live in " + PLUGIN_DIR
    + "/<name>/ as plugin.json + plugin.js and run in a "
    + "sandbox with only the GhostIDE API. Remove deletes "
    + "the folder for good.";
  box.appendChild(note);
  for (const p of plugins) {
    const row = document.createElement("div");
    row.className = "findRow";
    const label = document.createElement("span");
    label.textContent = "🔌 " + p.name
      + (p.version ? " v" + p.version : "")
      + (p.enabled ? "" : " (disabled)")
      + (p.description ? " - " + p.description : "");
    row.appendChild(label);
    const tgl = document.createElement("button");
    tgl.textContent = p.enabled ? "Disable" : "Enable";
    tgl.onclick = async (ev) => {
      ev.stopPropagation();
      setPluginDisabled(p.id, p.enabled);
      await openPlugins();
    };
    row.appendChild(tgl);
    const rm = document.createElement("button");
    rm.textContent = "Remove";
    rm.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm("Remove plugin " + p.name
          + "? Its folder is deleted.")) return;
      const d = await postJson("/api/file/delete",
        { path: p.dir });
      if (d.error) { alert(d.error); return; }
      setPluginDisabled(p.id, false);
      await openPlugins();
    };
    row.appendChild(rm);
    box.appendChild(row);
  }
  const inst = document.createElement("div");
  inst.className = "findRow";
  inst.textContent = "⬇ Install the sample plugins "
    + "(Word Count Pro, JSON Toolbox)";
  inst.onclick = async () => {
    for (const s of SAMPLE_PLUGINS) {
      let d = await postJson("/api/file", {
        path: PLUGIN_DIR + "/" + s.id + "/plugin.json",
        content: s.manifest });
      if (d.error) { alert(d.error); return; }
      d = await postJson("/api/file", {
        path: PLUGIN_DIR + "/" + s.id + "/plugin.js",
        content: s.code });
      if (d.error) { alert(d.error); return; }
    }
    await openPlugins();
    addMsg("SYSTEM", "🔌 Sample plugins installed. "
      + "Their actions are in Tools, Plugins.");
  };
  box.appendChild(inst);
  const rs = document.createElement("div");
  rs.className = "findRow";
  rs.textContent = "↻ Rescan plugin folder";
  rs.onclick = () => openPlugins();
  box.appendChild(rs);
}
$("toolPluginsManage").onclick = openPlugins;

/* ---------------- Roadmap G14: project templates ----------------
   Defined once here and created through /api/file, so the
   same catalog works identically on desktop and phone.
   {{name}} / {{pkg}} / {{year}} are substituted at creation. */
const TEMPLATES = [
  {
    id: "python-cli", label: "Python CLI",
    blurb: "argparse skeleton that runs today",
    main: "main.py",
    starter: "This is {{name}}, a new Python CLI. Read "
      + "main.py, then suggest the first real feature to "
      + "build and start on it.",
    files: [
      ["main.py", `#!/usr/bin/env python3
"""{{name}} - a command-line tool.

Run: python3 main.py --help
"""
import argparse


def main():
    ap = argparse.ArgumentParser(prog="{{name}}")
    ap.add_argument("name", nargs="?", default="world",
                    help="who to greet")
    ap.add_argument("--shout", action="store_true",
                    help="say it loudly")
    args = ap.parse_args()
    msg = "hello, " + args.name
    print(msg.upper() if args.shout else msg)


if __name__ == "__main__":
    main()
`],
      ["README.md", `# {{name}}

A Python command-line tool.

Run it:

    python3 main.py your-name
    python3 main.py your-name --shout
`],
    ],
  },
  {
    id: "python-lib", label: "Python library + tests",
    blurb: "package layout with a passing test suite",
    main: "{{pkg}}/core.py",
    starter: "This is {{name}}, a new Python library. The "
      + "package is in {{pkg}}/ with tests in tests/. "
      + "Suggest a first useful function to add, with tests.",
    files: [
      ["{{pkg}}/__init__.py", `"""{{name}} package."""

from .core import greet

__all__ = ["greet"]
`],
      ["{{pkg}}/core.py", `"""Core logic for {{name}}."""


def greet(name):
    return "hello, " + name
`],
      ["tests/test_core.py", `import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), ".."))

from {{pkg}}.core import greet


def test_greet():
    assert greet("ghost") == "hello, ghost"


def test_greet_empty():
    assert greet("") == "hello, "
`],
      ["README.md", `# {{name}}

A Python library. Run its tests from the project folder
with GhostIDE's test runner (or any test runner you like).
`],
    ],
  },
  {
    id: "static-site", label: "Static site",
    blurb: "one-page site skeleton (the studio pattern)",
    main: "index.html",
    starter: "This is {{name}}, a new static site. Read "
      + "index.html and style.css, then help me write the "
      + "real copy for the 'What we do' section.",
    files: [
      ["index.html", `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{name}}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <h1>{{name}}</h1>
  <p>Your tagline goes here.</p>
</header>
<main>
  <section>
    <h2>What we do</h2>
    <p>Describe the offer in two honest sentences.</p>
  </section>
  <section>
    <h2>Contact</h2>
    <p>Phone: <a href="tel:">(555) 000-0000</a></p>
  </section>
</main>
<footer><small>&copy; {{year}} {{name}}</small></footer>
</body>
</html>
`],
      ["style.css", `body {
  font-family: system-ui, sans-serif;
  margin: 0 auto; max-width: 44rem; padding: 1rem;
  line-height: 1.55; color: #1c1e24; background: #fafafc;
}
header { padding: 2rem 0 1rem; }
h1 { margin: 0 0 .25rem; }
section { margin: 1.5rem 0; }
footer { margin-top: 3rem; color: #666; }
a { color: #5b4bc4; }
`],
      ["README.md", `# {{name}}

A static one-page site. Open index.html in a browser, or
use GhostIDE's Preview on the desktop build.
`],
    ],
  },
  {
    id: "node-cli", label: "Node CLI",
    blurb: "dependency-free Node tool (ES modules)",
    main: "index.mjs",
    starter: "This is {{name}}, a new Node CLI with no "
      + "dependencies. Read index.mjs, then suggest the "
      + "first real feature to build.",
    files: [
      ["index.mjs", `#!/usr/bin/env node
// {{name}} - a dependency-free Node CLI.
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("-")) || "world";
const shout = args.includes("--shout");
const msg = "hello, " + name;
console.log(shout ? msg.toUpperCase() : msg);
`],
      ["package.json", `{
  "name": "{{name}}",
  "version": "0.1.0",
  "type": "module",
  "bin": { "{{name}}": "./index.mjs" },
  "scripts": { "start": "node index.mjs" }
}
`],
      ["README.md", `# {{name}}

A dependency-free Node CLI.

    node index.mjs your-name --shout
`],
    ],
  },
  {
    id: "gguf-tool", label: "GGUF tool script",
    blurb: "Python script that talks to your local model",
    main: "gguf_tool.py",
    starter: "This is {{name}}, a small tool that talks "
      + "to a local llama.cpp server. Read gguf_tool.py "
      + "and suggest one improvement.",
    files: [
      ["gguf_tool.py", `#!/usr/bin/env python3
"""{{name}} - ask the local model a question.

Needs a llama.cpp server on 127.0.0.1:8080 (GhostIDE's
desktop model, or any llama-server):
    python3 gguf_tool.py "your question"
"""
import json
import sys
import urllib.request

URL = "http://127.0.0.1:8080/v1/chat/completions"


def ask(prompt):
    body = json.dumps({
        "model": "local",
        "messages": [
            {"role": "system",
             "content": "You are helpful and brief."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 512,
    }).encode()
    req = urllib.request.Request(
        URL, data=body,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.load(r)
    return data["choices"][0]["message"]["content"]


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "Say hello in one line."
    print(ask(q))
`],
      ["README.md", `# {{name}}

Ask your local model a question from the command line.
Start a llama.cpp server first (GhostIDE's desktop model
works), then:

    python3 gguf_tool.py "explain recursion simply"
`],
    ],
  },
  {
    id: "blank", label: "Blank",
    blurb: "just a README and a starter prompt",
    main: "README.md",
    starter: "This is {{name}}, a blank project. Ask me "
      + "what I want to build, then help me plan the "
      + "first files.",
    files: [
      ["README.md", `# {{name}}

A fresh project. Ask Ghost where to start, or just start.
`],
    ],
  },
];

function openTemplates() {
  hideTools();
  $("todoTitle").textContent = "New project from template";
  const box = $("todoResults");
  box.innerHTML = "";
  $("todoPanel").classList.remove("hidden");
  for (const t of TEMPLATES) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "📁 " + t.label + " - " + t.blurb;
    row.onclick = () => createFromTemplate(t);
    box.appendChild(row);
  }
}

async function createFromTemplate(t) {
  let name = prompt("Project name (letters, numbers, "
    + "dashes):", t.id);
  if (!name) return;
  name = name.trim().toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) {
    alert("That name has no usable characters in it.");
    return;
  }
  try {
    const fr = await fetch("/api/files");
    const fd = await fr.json();
    const clash = (fd.files || []).some((f) =>
      (f.path || "").startsWith(name + "/"));
    if (clash) {
      alert("A folder named " + name + " already has "
        + "files here. Pick another name.");
      return;
    }
  } catch (e) { /* clash check is best-effort */ }
  const pkg = name.replace(/-/g, "_");
  const subst = (s) => s.split("{{name}}").join(name)
    .split("{{pkg}}").join(pkg)
    .split("{{year}}").join(String(new Date().getFullYear()));
  for (const [rel, content] of t.files) {
    const d = await postJson("/api/file", {
      path: name + "/" + subst(rel),
      content: subst(content),
    });
    if (d.error) {
      alert("Could not create " + rel + ": " + d.error);
      return;
    }
  }
  await loadFiles();
  $("todoPanel").classList.add("hidden");
  await openFile(name + "/" + subst(t.main));
  $("chatText").value = subst(t.starter);
  addMsg("SYSTEM", "📁 Created " + name + " from the "
    + t.label + " template. Its starter prompt is in the "
    + "chat box - edit it or just press Send.");
}
$("toolTemplates").onclick = openTemplates;

/* ---------------- boot ---------------- */
loadFiles();
refreshWsLabel();
discoverPlugins();
pairInit();
/* Reaching this line proves the whole bundle evaluated without a
   startup crash - tell the watchdog in index.html, and surface
   anything the error trap caught on the way up. */
window.__ghostBooted = true;
if (window.__ghostErrs && window.__ghostErrs.length &&
    typeof __ghostShowErrs === "function") __ghostShowErrs();
