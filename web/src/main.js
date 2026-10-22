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
    whitespace: false, lang: "en", textSize: "normal",
    oneHand: false, chatStyle: "balanced",
    chatLength: "normal", customInstr: "",
    historyTurns: 0, sendKey: "enter",
    timestamps: false, compactChat: false,
    reduceMotion: false, fontFamily: "default",
    customTokens: 1024, lineHeight: "1.45",
    ligatures: true, lineNumbers: true,
    activeLine: true, chatFs: "13",
    chatWidth: "360", accent: "green", notifySound: "soft", autoScroll: true, density: false, chatFont: "default", bubbles: false, wrapChat: false, autosave: false,
    roleLabels: true, sliceBudget: 6000,
    attachSelection: true, attachDiff: false },
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
        const selM = u.state.selection.main;
        $("cursorPos").textContent = cursorStatus(
          line.number, head - line.from + 1,
          u.state.doc.lines, u.state.doc.length,
          selM.empty ? 0 : selM.to - selM.from,
          selM.empty ? 0 :
            u.state.doc.lineAt(selM.to).number -
            line.number + 1);
        $("fileType").textContent = langName(currentFile);
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
    menu.setAttribute("aria-label",
      "File options for " + f.path);
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
  if (window.innerWidth <= 900) setDrawer(false);
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


// Pairing (item 12): every fetch carries this host's
// pair token when one is stored; a 401 "pairing
// required" asks for the 6-digit code shown on the
// host, joins, and retries once. Loopback hosts never
// ask (their server does not gate them).
const PAIR_TOKEN_KEY = "ghostide-pair-token:"
  + location.host;
function storedPairRole() {
  try {
    return localStorage.getItem(
      "ghostide-pair-role:" + location.host) || "";
  } catch (e) { return ""; }
}
function storedPairToken() {
  try {
    return localStorage.getItem(PAIR_TOKEN_KEY) || "";
  } catch (e) { return ""; }
}
const _rawFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  init = init || {};
  const headers = new Headers(
    init.headers || (input && input.headers) || {});
  const tok = storedPairToken();
  if (tok && !headers.has("X-Pair-Token"))
    headers.set("X-Pair-Token", tok);
  init = Object.assign({}, init, { headers: headers });
  let resp = await _rawFetch(input, init);
  if (resp.status === 401) {
    let need = false;
    try {
      const d = await resp.clone().json();
      need = d && d.error === "pairing required";
    } catch (e) { /* not a pair gate */ }
    if (need) {
      const code = prompt(
        "This GhostIDE host asks for a pairing code. "
        + "It is shown in the pair panel on the host "
        + "device.");
      if (code) {
        const jr = await _rawFetch("/api/pair/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: code.trim(),
            id: typeof pairId !== "undefined"
              ? pairId : "",
            name: "guest device"
          })
        });
        const jd = await jr.json().catch(() => null);
        if (jd && jd.token) {
          try {
            localStorage.setItem(PAIR_TOKEN_KEY, jd.token);
            localStorage.setItem(
              "ghostide-pair-role:" + location.host,
              jd.role || "editor");
          } catch (e) { /* storage off */ }
          headers.set("X-Pair-Token", jd.token);
          init = Object.assign({}, init,
            { headers: headers });
          resp = await _rawFetch(input, init);
        }
      }
    }
  }
  return resp;
};

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
    if (d.updateAvailable && d.url
        && /^https?:\/\//i.test(d.url)) {
      // v2.36: only web URLs become links - the
      // version feed is remote data, and a
      // javascript: URL here would run on click.
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
/*@@CHIP@@*/
/* v1.49 polish: the header chip shows the short label
   ("1.5B · on-device") instead of the full model name;
   the full name still lives in Settings. */
function shortModelLabel(modelName) {
  const name = String(modelName || "");
  const m = name.match(/(\d+(?:\.\d+)?)\s*B\b/i);
  if (m) return m[1] + "B · on-device";
  if (!name) return "model";
  return name.length > 20 ? name.slice(0, 19) + "…" : name;
}
try { window.__ghostChip = { shortModelLabel }; }
catch (e) {}
/*@@CHIP-END@@*/

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
    pill.textContent = modelUp
      ? shortModelLabel(d.modelName) : "model: down";
    pill.title = d.modelName || "";
    pill.className = "pill " + (modelUp ? "up" : "down");
    $("startModelBtn").classList.toggle("hidden", modelUp);
  } catch (e) { /* backend hiccup; next poll retries */ }
}
$("startModelBtn").onclick = async () => {
  $("modelPill").textContent = "model: starting…";
  $("modelPill").className = "pill loading";
  $("startModelBtn").classList.add("hidden");
  await fetch("/api/model/start", { method: "POST" });
};
setInterval(pollHealth, 4000);
pollHealth();

/* v1.49 polish: chat options fold. */
$("chatOptsBtn").onclick = () =>
  $("chatOpts").classList.toggle("hidden");

/* v1.50 unified design: on phone widths the chat is a
   bottom sheet with three stops (min = slim bar, mid,
   full), Files is a slide-over drawer, and a bottom
   view bar switches between them. The state lives in
   body classes; CSS scopes the effects to <=900px, so
   wide screens simply keep the classic layout. */
/*@@SHEET@@*/
const SHEET_STOPS = ["min", "mid", "full"];
function cycleSheetStop(stop) {
  const i = SHEET_STOPS.indexOf(stop);
  return SHEET_STOPS[(i + 1) % SHEET_STOPS.length];
}
/* dir > 0 moves toward "full" (a drag up), dir < 0
   toward "min" (a drag down); clamped at the ends. */
function nextSheetStop(stop, dir) {
  const i = SHEET_STOPS.indexOf(stop);
  const j = Math.min(SHEET_STOPS.length - 1,
    Math.max(0, i + (dir > 0 ? 1 : -1)));
  return SHEET_STOPS[j];
}
try {
  window.__ghostSheet = { SHEET_STOPS, cycleSheetStop,
    nextSheetStop };
} catch (e) {}
/*@@SHEET-END@@*/

let drawerMode = "files";
function currentSheetStop() {
  if (document.body.classList.contains("chat-min"))
    return "min";
  if (document.body.classList.contains("sheet-full"))
    return "full";
  return "mid";
}
function setSheet(stop) {
  document.body.classList.toggle("chat-min",
    stop === "min");
  document.body.classList.toggle("sheet-full",
    stop === "full");
  try { localStorage.setItem("ghostide-sheet", stop); }
  catch (e) {}
  syncChatToggle();
  syncViewBar();
}
function syncChatToggle() {
  const stop = currentSheetStop();
  $("chatToggle").textContent = stop === "min" ? "▸" : "▾";
  $("chatToggle").setAttribute("aria-label",
    stop === "min" ? "Expand chat" :
    stop === "mid" ? "Expand chat fully" :
      "Collapse chat");
}
$("chatToggle").onclick = () =>
  setSheet(cycleSheetStop(currentSheetStop()));
let gripY = null;
$("sheetGrip").addEventListener("pointerdown", (e) => {
  gripY = e.clientY;
});
window.addEventListener("pointerup", (e) => {
  if (gripY === null) return;
  const dy = e.clientY - gripY;
  gripY = null;
  if (Math.abs(dy) < 36) return;
  setSheet(nextSheetStop(currentSheetStop(),
    dy < 0 ? 1 : -1));
});
function setDrawer(open, mode) {
  if (mode) drawerMode = mode;
  document.body.classList.toggle("drawer-open", open);
  syncViewBar();
}
function syncViewBar() {
  const drawer =
    document.body.classList.contains("drawer-open");
  const stop = currentSheetStop();
  $("viewFiles").classList.toggle("active",
    drawer && drawerMode === "files");
  $("viewGit").classList.toggle("active",
    drawer && drawerMode === "git");
  $("viewChat").classList.toggle("active",
    stop !== "min");
  $("viewCode").classList.toggle("active",
    !drawer && stop === "min");
}
$("viewFiles").onclick = () => setDrawer(
  !(document.body.classList.contains("drawer-open") &&
    drawerMode === "files"), "files");
$("viewGit").onclick = () => {
  const wasGit =
    document.body.classList.contains("drawer-open") &&
    drawerMode === "git";
  setDrawer(!wasGit, "git");
  if (!wasGit) setTimeout(() => {
    const g = $("gitPanel");
    if (g) g.scrollIntoView({ block: "start" });
  }, 90);
};
$("viewCode").onclick = () => {
  setDrawer(false);
  setSheet("min");
};
$("viewChat").onclick = () => setSheet(
  currentSheetStop() === "min" ? "mid" : "min");
try {
  let stop = localStorage.getItem("ghostide-sheet");
  if (!stop) {
    const legacy =
      localStorage.getItem("ghostide-chat-min");
    stop = legacy === "1" ? "min" :
      legacy === "0" ? "mid" :
      (window.innerWidth <= 900 ? "min" : "mid");
  }
  setSheet(stop);
} catch (e) { syncChatToggle(); syncViewBar(); }

/*@@CHATOPTS@@*/
/* Chat options expansion: answer styles, answer length,
   history windowing, quick prompts, message stamps. The
   pure steps live here so the headless harness can prove
   them; sendChat and the settings wiring call them. */
const CHAT_STYLES = {
  balanced: { label: "Balanced", instruction: "" },
  teacher: { label: "Teacher", instruction:
    "Answer like a patient teacher: explain the idea " +
    "first in plain words, then show the code, then give " +
    "one short example. Define any term the first time " +
    "you use it." },
  codeonly: { label: "Code only", instruction:
    "Answer with code only, plus at most one short " +
    "comment line per block. No explanations before or " +
    "after the code unless I ask for them." },
  reviewer: { label: "Reviewer", instruction:
    "Answer like a strict code reviewer: lead with " +
    "problems (bugs, edge cases, risks) in priority " +
    "order, each with the line it is on and a concrete " +
    "fix. Skip praise and summaries." },
  rubberduck: { label: "Rubber duck", instruction:
    "Act as a rubber duck: do not write the fix or the " +
    "answer. Ask one focused question at a time about " +
    "my code and my thinking, and reflect back what I " +
    "say, until I see the answer myself." },
};
const QUICK_PROMPTS = [
  { id: "explain", label: "Explain this file",
    text: "Explain how {file} works, section by " +
      "section, in plain words." },
  { id: "bugs", label: "Find bugs",
    text: "Look for bugs and edge cases in {file}. " +
      "List each one with the line it is on and a fix." },
  { id: "tests", label: "Write tests",
    text: "Write tests for the main behavior in " +
      "{file}. Cover the happy path and the edge cases." },
  { id: "simplify", label: "Simplify",
    text: "Show a simpler version of the hardest part " +
      "of {file}, and say what changed and why." },
  { id: "document", label: "Document",
    text: "Write clear comments and a short header " +
      "doc for {file}, without changing its behavior." },
];
function personaSuffix(styleId, custom) {
  let s = "";
  const st = CHAT_STYLES[styleId];
  if (st && st.instruction)
    s += "\n\nAnswer style: " + st.instruction;
  const c = (custom || "").trim().slice(0, 1000);
  if (c) s += "\n\nThe user's own instructions for " +
    "every answer:\n" + c;
  return s;
}
function answerMaxTokens(lenId, shortLegacy, base, custom) {
  if (lenId === "short") return 512;
  if (lenId === "long") return 2048;
  if (lenId === "custom") {
    const n = parseInt(custom, 10);
    return (n >= 128 && n <= 2048) ? n : base;
  }
  if (lenId === "normal") return base;
  return shortLegacy ? 512 : base;
}
function windowHistory(msgs, turns) {
  const t = parseInt(turns, 10);
  if (!t || t <= 0) return msgs.slice();
  return msgs.slice(-t * 2);
}
function quickPromptText(id, fileName) {
  const p = QUICK_PROMPTS.find((q) => q.id === id);
  if (!p) return "";
  return p.text.split("{file}").join(fileName || "this file");
}
function msgStamp(d) {
  const p2 = (n) => String(n).padStart(2, "0");
  return p2(d.getHours()) + ":" + p2(d.getMinutes());
}
try { window.__ghostChatOpts = { CHAT_STYLES, QUICK_PROMPTS,
  personaSuffix, answerMaxTokens, windowHistory,
  quickPromptText, msgStamp }; } catch (e) {}
/*@@CHATOPTS-END@@*/

/*@@COMPOSER@@*/
/* Chat composer pack (v1.58): the pure steps behind the
   input counter, the per-project chat draft and the
   Continue action. */
const CONTINUE_TEXT =
  "Continue exactly where you left off. Finish the " +
  "answer; do not repeat what you already said.";
function estTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
function counterText(text) {
  if (!text) return "";
  return text.length + " chars · ~" + estTokens(text) + " tok";
}
function chatDraftKey(scope) {
  return "ghostide-chatdraft:" + scope;
}
try { window.__ghostComposer = { CONTINUE_TEXT, estTokens,
  counterText, chatDraftKey }; } catch (e) {}
/*@@COMPOSER-END@@*/

/*@@SESSIONS@@*/
/* Chat sessions (v1.59): several named chats per
   project. The default session keeps the pre-v1.59
   history key, so existing chats survive the upgrade;
   later sessions suffix theirs. */
const DEFAULT_SESSION = { id: "s1", name: "Chat 1" };
function normalizeSessions(list) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(list)) {
    for (const s of list) {
      if (!s || typeof s.id !== "string" || !s.id) continue;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({ id: s.id,
        name: (typeof s.name === "string" && s.name.trim())
          ? s.name.trim().slice(0, 40) : "Chat" });
    }
  }
  if (!out.length) out.push({ id: DEFAULT_SESSION.id,
    name: DEFAULT_SESSION.name });
  return out;
}
function sessionHistoryKey(scope, id) {
  const base = "ghostide-history:" + scope;
  return (!id || id === DEFAULT_SESSION.id)
    ? base : base + ":" + id;
}
function nextSessionName(list) {
  const used = new Set(list.map((s) => s.name));
  let n = list.length + 1;
  while (used.has("Chat " + n)) n++;
  return "Chat " + n;
}
function removeSession(list, id) {
  if (list.length <= 1) return { list, removed: false };
  const next = list.filter((s) => s.id !== id);
  return { list: next, removed: next.length !== list.length };
}
try { window.__ghostSessions = { DEFAULT_SESSION,
  normalizeSessions, sessionHistoryKey, nextSessionName,
  removeSession }; } catch (e) {}
/*@@SESSIONS-END@@*/

/*@@PROMPTS@@*/
/* Prompt library (v1.60): named prompts the user saves
   from the chat box and reuses in any project. Stored
   globally (they are personal tooling, not project
   data) under ghostide-prompts. */
function normalizePrompts(list) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(list)) {
    for (const p of list) {
      if (!p || typeof p.name !== "string" ||
          typeof p.text !== "string") continue;
      const name = p.name.trim().slice(0, 40);
      const text = p.text.trim().slice(0, 4000);
      if (!name || !text || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, text });
    }
  }
  return out;
}
function upsertPrompt(list, name, text) {
  const clean = normalizePrompts([{ name, text }]);
  if (!clean.length) return normalizePrompts(list);
  const rest = normalizePrompts(list)
    .filter((p) => p.name !== clean[0].name);
  rest.push(clean[0]);
  return rest;
}
function removePrompt(list, name) {
  return normalizePrompts(list)
    .filter((p) => p.name !== name);
}
function promptByName(list, name) {
  return normalizePrompts(list)
    .find((p) => p.name === name) || null;
}
try { window.__ghostPrompts = { normalizePrompts,
  upsertPrompt, removePrompt, promptByName }; }
catch (e) {}
/*@@PROMPTS-END@@*/

/*@@SAMPLING@@*/
/* Sampling controls (v1.61): temperature presets and
   the generation stats line. Only controls the model
   path really honors on BOTH builds live here - the
   phone bridge takes temperature + max tokens, and
   the desktop proxies the same fields. */
const TEMP_PRESETS = { precise: 0.1, balanced: 0.3,
  creative: 0.7 };
function genStats(chars, ms) {
  if (!chars || !ms || ms <= 0) return "";
  const tok = Math.ceil(chars / 4);
  const secs = (ms / 1000).toFixed(1);
  const rate = Math.max(1, Math.round(tok / (ms / 1000)));
  return "answered in " + secs + "s · ~" + tok +
    " tok · ~" + rate + " tok/s (estimates)";
}
try { window.__ghostSampling = { TEMP_PRESETS, genStats }; }
catch (e) {}
/*@@SAMPLING-END@@*/

/*@@READING@@*/
/* Editor reading pack (v1.62): line spacing, ligatures,
   line numbers and the current-line highlight as real
   display settings. readingState is the pure mapping
   from settings to the CSS variable + body classes. */
const LINE_HEIGHTS = ["1.3", "1.45", "1.6", "1.8"];
function readingState(s) {
  return {
    lineHeight: LINE_HEIGHTS.includes(s.lineHeight)
      ? s.lineHeight : "1.45",
    classes: [
      s.ligatures === false ? "lig-off" : "",
      s.lineNumbers === false ? "linenums-off" : "",
      s.activeLine === false ? "activeline-off" : "",
    ].filter(Boolean),
  };
}
try { window.__ghostReading = { LINE_HEIGHTS,
  readingState }; } catch (e) {}
/*@@READING-END@@*/

/*@@EXPORT@@*/
/* Chat export pack (v1.63): one history, three honest
   renderings. Markdown matches the format the Tools
   export has always written; HTML escapes everything
   (chat text can never inject markup into the file). */
function escHtmlBasic(s) {
  return String(s).replace(/&/g, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function chatToMarkdown(hist) {
  return "# GhostIDE chat export\n\n" + hist.map((m) =>
    (m.role === "user" ? "**You:** " : "**Ghost:** ") +
    m.content).join("\n\n---\n\n") + "\n";
}
function chatToText(hist) {
  return "GhostIDE chat export\n\n" + hist.map((m) =>
    (m.role === "user" ? "You: " : "Ghost: ") +
    m.content).join("\n\n---\n\n") + "\n";
}
function chatToHtml(hist) {
  const parts = hist.map((m) =>
    "<h3>" + (m.role === "user" ? "You" : "Ghost") +
    "</h3>\n<pre>" + escHtmlBasic(m.content) + "</pre>");
  return "<!doctype html>\n<html><head>" +
    "<meta charset=\"utf-8\">" +
    "<title>GhostIDE chat export</title><style>" +
    "body{font-family:system-ui;background:#131519;" +
    "color:#e6e6e6;max-width:760px;margin:24px auto;" +
    "padding:0 16px}h3{color:#9a9fb0;margin:18px 0 4px}" +
    "pre{white-space:pre-wrap;margin:0}</style></head>" +
    "<body><h1>GhostIDE chat export</h1>\n" +
    parts.join("\n") + "\n</body></html>\n";
}
function chatStats(hist) {
  let words = 0;
  for (const m of hist)
    words += (m.content.match(/\S+/g) || []).length;
  return { messages: hist.length, words,
    estTokens: Math.ceil(hist.reduce((a, m) =>
      a + m.content.length, 0) / 4) };
}
function chatStatsText(hist) {
  const s = chatStats(hist);
  if (!s.messages) return "No messages yet.";
  return s.messages + " messages · ~" +
    s.words.toLocaleString() + " words · ~" +
    s.estTokens.toLocaleString() + " tok (estimates)";
}
try { window.__ghostExport = { chatToMarkdown, chatToText,
  chatToHtml, chatStats, chatStatsText }; } catch (e) {}
/*@@EXPORT-END@@*/

/*@@SLASH@@*/
/* Slash commands (v1.64): a leading /word in the chat
   box runs a command instead of going to the model.
   AI commands reuse the Tools quick actions (with an
   optional note appended); local ones drive the
   existing buttons, so there is one code path each. */
const SLASH_COMMANDS = [
  { cmd: "explain", kind: "ai",
    blurb: "Explain the current file or selection" },
  { cmd: "fix", kind: "ai",
    blurb: "Find and fix bugs in the current file or selection" },
  { cmd: "tests", kind: "ai",
    blurb: "Write tests for the current file or selection" },
  { cmd: "doc", kind: "ai",
    blurb: "Document the current file or selection" },
  { cmd: "rename", kind: "local",
    blurb: "Rename this chat: /rename My chat" },
  { cmd: "star", kind: "local",
    blurb: "Star or unstar this chat" },
  { cmd: "scratch", kind: "local",
    blurb: "Open the scratchpad" },
  { cmd: "backup", kind: "local",
    blurb: "Export all GhostIDE data" },
  { cmd: "sees", kind: "local",
    blurb: "Preview what Ghost sees" },
  { cmd: "clear", kind: "local", blurb: "Clear this chat" },
  { cmd: "export", kind: "local",
    blurb: "Export this chat (selected format)" },
  { cmd: "regen", kind: "local",
    blurb: "Regenerate the last answer" },
  { cmd: "help", kind: "local", blurb: "Show this list" },
];
function parseSlash(text) {
  if (!text || text[0] !== "/") return null;
  const m = text.slice(1).match(/^(\w+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const hit = SLASH_COMMANDS.find(
    (c) => c.cmd === m[1].toLowerCase());
  if (!hit) return null;
  return { cmd: hit.cmd, kind: hit.kind,
    arg: (m[2] || "").trim() };
}
function slashHelpText() {
  return "Slash commands:\n" + SLASH_COMMANDS.map(
    (c) => "/" + c.cmd + " - " + c.blurb).join("\n");
}
try { window.__ghostSlash = { SLASH_COMMANDS, parseSlash,
  slashHelpText }; } catch (e) {}
/*@@SLASH-END@@*/

/*@@DISPLAY@@*/
/* Chat display pack (v1.65): chat text size, panel
   width, message bubbles and who labels. Pure mapping
   from settings to CSS variables + body classes; the
   Compact chat density still wins over the text size
   when both are set (its rule is more specific). */
const CHAT_FS = ["12", "13", "15"];
const CHAT_WIDTHS = ["320", "360", "460", "560"];
function displayState(s) {
  return {
    chatFs: CHAT_FS.includes(String(s.chatFs))
      ? String(s.chatFs) : "13",
    chatW: CHAT_WIDTHS.includes(String(s.chatWidth))
      ? String(s.chatWidth) : "360",
    classes: [
      s.bubbles === true ? "chat-bubbles" : "",
      s.roleLabels === false ? "no-roles" : "",
    ].filter(Boolean),
  };
}
try { window.__ghostDisplay = { CHAT_FS, CHAT_WIDTHS,
  displayState }; } catch (e) {}
/*@@DISPLAY-END@@*/

/*@@CONTEXTCTL@@*/
/* Context control pack (v1.66): how much project
   context rides along with a message. The slice
   budget replaces the fixed BEHAVIOR value at every
   call site; the diff snippet is capped so a huge
   work-in-progress cannot flood the model. */
const SLICE_BUDGETS = [3000, 6000, 12000, 20000];
function clampSliceBudget(v) {
  const n = parseInt(v, 10);
  return SLICE_BUDGETS.includes(n) ? n : 6000;
}
function sliceBudget() {
  return clampSliceBudget(settings.sliceBudget);
}
const DIFF_CAP = 6000;
function diffSnippet(diff) {
  if (!diff || !diff.trim()) return "";
  if (diff.length <= DIFF_CAP) return diff;
  return diff.slice(0, DIFF_CAP) + "\n... (diff truncated)";
}
try { window.__ghostContextCtl = { SLICE_BUDGETS,
  clampSliceBudget, diffSnippet }; } catch (e) {}
/*@@CONTEXTCTL-END@@*/

/*@@SETUTIL@@*/
/* Settings utilities (v1.67): the panel is long now,
   so it gets a filter; and settings can be reset or
   carried between devices as JSON. Import is strict:
   only known keys with matching types survive. */
function rowMatches(text, q) {
  if (!q) return true;
  return String(text).toLowerCase()
    .includes(String(q).toLowerCase());
}
function sanitizeImportedSettings(obj, schema) {
  if (!obj || typeof obj !== "object" ||
      Array.isArray(obj)) return null;
  const out = {};
  for (const k of Object.keys(schema)) {
    if (k in obj && typeof obj[k] === typeof schema[k]) {
      // R13: an imported string is capped; anything
      // longer is not a setting, it is a payload.
      if (typeof obj[k] === "string"
          && obj[k].length > 20000) continue;
      out[k] = obj[k];
    }
  }
  return Object.keys(out).length ? out : null;
}
try { window.__ghostSetUtil = { rowMatches,
  sanitizeImportedSettings }; } catch (e) {}
/*@@SETUTIL-END@@*/

/*@@MSGTOOLS@@*/
/* Message tools (v1.68): what you can do with a single
   message - save it as a file, copy only its code
   blocks, or rewind the chat to one of your turns and
   edit it. trimForEdit is the pure rewind step. */
function extractCodeBlocks(text) {
  const out = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null)
    out.push(m[1].replace(/\n$/, ""));
  return out;
}
function trimForEdit(hist, idx) {
  if (idx < 0 || idx >= hist.length) return null;
  if (hist[idx].role !== "user") return null;
  return { kept: hist.slice(0, idx), text: hist[idx].content };
}
function answerFilename(d) {
  const p = (n) => String(n).padStart(2, "0");
  return "answer-" + d.getFullYear() + "-" +
    p(d.getMonth() + 1) + "-" + p(d.getDate()) + "-" +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
    ".md";
}
try { window.__ghostMsgTools = { extractCodeBlocks,
  trimForEdit, answerFilename }; } catch (e) {}
/*@@MSGTOOLS-END@@*/

/*@@FINDCHAT@@*/
/* Find in chat (v1.69): a live filter over the visible
   messages. It works on the rendered messages, so it
   covers greetings, system notes and answers alike,
   with no fragile index bookkeeping. */
function msgMatches(text, q) {
  if (!q) return true;
  return String(text).toLowerCase()
    .includes(String(q).toLowerCase());
}
try { window.__ghostFindChat = { msgMatches }; }
catch (e) {}
/*@@FINDCHAT-END@@*/

/*@@SHORTCUTS@@*/
/* Keyboard shortcuts (v1.70): chat-focused keys that
   stay out of the code editor's way (CodeMirror owns
   its keys; only Ctrl+. is taken there). The table is
   the single source for the help text. */
const SHORTCUTS = [
  { keys: "Ctrl + .", what: "Jump to the chat box" },
  { keys: "Ctrl + /", what: "Show or hide Chat options" },
  { keys: "Ctrl + L", what: "Clear this chat (asks first)" },
  { keys: "Ctrl + Shift + Down", what: "Next chat" },
  { keys: "Ctrl + Shift + Up", what: "Previous chat" },
  { keys: "Ctrl + K", what: "Quick open (existing)" },
  { keys: "Ctrl + Shift + P", what: "Command palette (existing)" },
  { keys: "Ctrl + Shift + O", what: "Symbol search (existing)" },
];
function stepSession(list, activeId, dir) {
  if (!list.length) return activeId;
  const i = list.findIndex((s) => s.id === activeId);
  if (i < 0) return list[0].id;
  return list[(i + dir + list.length) % list.length].id;
}
function shortcutHelpText() {
  return "Keyboard shortcuts (outside the code editor):\n" +
    SHORTCUTS.map((s) => s.keys + " - " + s.what).join("\n");
}
try { window.__ghostShortcuts = { SHORTCUTS, stepSession,
  shortcutHelpText }; } catch (e) {}
/*@@SHORTCUTS-END@@*/

/*@@SPEAK@@*/
/* Speak answer (v1.71): answers read aloud with the
   platform voice. speakText flattens markdown into
   something listenable - code blocks become a spoken
   placeholder instead of a stream of symbols. */
function speakText(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}
try { window.__ghostSpeak = { speakText }; } catch (e) {}
/*@@SPEAK-END@@*/

/*@@STATUS@@*/
/* Editor status pack (v1.72): the status bar learns
   the selection size and the file type. cursorStatus
   keeps the long-standing base format and appends the
   selection only when there is one. */
const LANG_NAMES = { js: "JavaScript", mjs: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", jsx: "JavaScript",
  py: "Python", html: "HTML", css: "CSS", json: "JSON",
  md: "Markdown", java: "Java", kt: "Kotlin",
  sh: "Shell", yaml: "YAML", yml: "YAML", toml: "TOML",
  xml: "XML", sql: "SQL", c: "C", h: "C", cpp: "C++",
  rs: "Rust", go: "Go", php: "PHP", rb: "Ruby",
  txt: "Text" };
function langName(path) {
  if (!path) return "";
  const ext = path.split(".").pop().toLowerCase();
  if (!ext || ext === path.toLowerCase()) return "Text";
  return LANG_NAMES[ext] || ext.toUpperCase();
}
function cursorStatus(line, col, lines, chars, selLen,
                      selLines) {
  let s = "Ln " + line + ", Col " + col + " · " +
    lines + " lines · " + chars + " chars";
  if (selLen > 0) {
    s += " · " + selLen + " selected";
    if (selLines > 1) s += " (" + selLines + " lines)";
  }
  return s;
}
try { window.__ghostStatus = { LANG_NAMES, langName,
  cursorStatus }; } catch (e) {}
/*@@STATUS-END@@*/

/*@@HELP@@*/
/* Help pack (v1.73): one help text assembled from the
   live tables - chat styles, slash commands, keyboard
   shortcuts - so it can never drift from what the app
   actually does. */
function buildHelpText() {
  return "GhostIDE help\n" +
    "Answer styles: " +
    Object.keys(CHAT_STYLES).join(", ") + "\n" +
    "Quick prompts: " +
    QUICK_PROMPTS.map((q) => q.label).join(", ") + "\n" +
    "Slash commands: " +
    SLASH_COMMANDS.map((c) => "/" + c.name).join(" ") + "\n" +
    shortcutHelpText() + "\n" +
    "Tips: quick prompts fill the box without sending. " +
    "Continue asks for the next part of a cut-off answer. " +
    "Edit & resend on one of your messages rewinds the " +
    "chat to it. Find in chat lives in Chat options.";
}
try { window.__ghostHelp = { buildHelpText }; }
catch (e) {}
/*@@HELP-END@@*/

/*@@ACCENT@@*/
/* Accent color (v1.74): one CSS variable pair drives
   the primary buttons and highlights. Green is the
   long-standing default from the v1.49 polish; the
   pair for it reproduces the old hexes exactly. */
const ACCENTS = {
  green:  { base: "#2c6e49", hi: "#35855a" },
  violet: { base: "#6716f3", hi: "#7d3bff" },
  blue:   { base: "#2563eb", hi: "#3b82f6" },
  amber:  { base: "#b45309", hi: "#d97706" },
  rose:   { base: "#be2f4a", hi: "#e0445f" },
  teal:   { base: "#0f766e", hi: "#14b8a6" },
};
function accentPair(name) {
  return ACCENTS[name] || ACCENTS.green;
}
try { window.__ghostAccent = { ACCENTS, accentPair }; }
catch (e) {}
/*@@ACCENT-END@@*/

/*@@SOUND@@*/
/* Notification sounds (v1.75): synthesized with
   WebAudio, no audio files. A sound is a short list
   of notes (frequency, duration, offset in seconds),
   which keeps the pure step trivially checkable. */
const NOTIFY_SOUNDS = {
  off: [],
  soft: [{ f: 880, d: 0.12, at: 0 }],
  chime: [{ f: 660, d: 0.14, at: 0 },
          { f: 990, d: 0.2, at: 0.13 }],
  pop: [{ f: 520, d: 0.07, at: 0 },
        { f: 780, d: 0.09, at: 0.06 }],
};
function beepSpec(name) {
  return NOTIFY_SOUNDS[name] || NOTIFY_SOUNDS.soft;
}
try { window.__ghostSound = { NOTIFY_SOUNDS, beepSpec }; }
catch (e) {}
/*@@SOUND-END@@*/

/*@@BACKUP@@*/
/* Data backup (v1.76): one JSON file with everything
   the app keeps locally - settings, prompts, chat
   history and sessions, drafts, bookmarks and the
   rest of the ghostide- namespace. Import validates
   strictly: right envelope, namespaced keys only,
   string values, sane sizes. */
function backupKeyOk(key) {
  return typeof key === "string" &&
    key.startsWith("ghostide-") && key.length > 9 &&
    key.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(key);
}
function buildBackup(map) {
  const data = {};
  for (const k of Object.keys(map)) {
    if (backupKeyOk(k) && typeof map[k] === "string")
      data[k] = map[k];
  }
  return { app: "ghostide-backup", version: 1, data };
}
function parseBackup(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { return null; }
  if (!o || o.app !== "ghostide-backup" ||
      o.version !== 1 || !o.data ||
      typeof o.data !== "object") return null;
  const keys = Object.keys(o.data);
  if (!keys.length || keys.length > 500) return null;
  const out = {};
  for (const k of keys) {
    if (!backupKeyOk(k)) return null;
    if (typeof o.data[k] !== "string" ||
        o.data[k].length > 2000000) return null;
    out[k] = o.data[k];
  }
  return out;
}
try { window.__ghostBackup = { backupKeyOk, buildBackup,
  parseBackup }; } catch (e) {}
/*@@BACKUP-END@@*/

/*@@SCROLL@@*/
/* Auto-scroll control (v1.77): with auto-scroll on
   (the long-standing behavior) the chat always jumps
   to the newest message. With it off, the view only
   follows when you were already near the bottom, so
   reading back is never interrupted. */
function isNearBottom(st, ch, sh, thr) {
  return sh - (st + ch) <= (thr || 80);
}
function shouldChatScroll(auto, wasNear) {
  return auto !== false || !!wasNear;
}
try { window.__ghostScroll = { isNearBottom,
  shouldChatScroll }; } catch (e) {}
/*@@SCROLL-END@@*/

/*@@INPUTHIST@@*/
/* Input history (v1.78): shell-style recall for the
   chat box. pushSent keeps the last 50 submissions,
   de-duplicated; navSent walks them - index -1 means
   "your current draft", stepping newer past the last
   entry returns to it. */
const SENT_CAP = 50;
function pushSent(list, text) {
  const t = String(text || "").trim();
  const out = list.filter((x) => x !== t);
  if (t) out.push(t);
  return out.slice(-SENT_CAP);
}
function navSent(list, idx, dir) {
  if (!list.length) return { idx: -1, text: null };
  if (dir < 0) {
    const n = idx === -1 ? list.length - 1 :
      Math.max(0, idx - 1);
    return { idx: n, text: list[n] };
  }
  if (idx === -1 || idx + 1 >= list.length)
    return { idx: -1, text: null };
  return { idx: idx + 1, text: list[idx + 1] };
}
try { window.__ghostInputHist = { SENT_CAP, pushSent,
  navSent }; } catch (e) {}
/*@@INPUTHIST-END@@*/

/*@@INSERT@@*/
/* Insert answer (v1.79): what lands in the editor
   when you tap Insert on an answer - just the code
   when the answer has code blocks, the full text
   otherwise. */
function insertionText(text) {
  const blocks = extractCodeBlocks(text);
  return blocks.length ? blocks.join("\n\n") : String(text);
}
try { window.__ghostInsert = { insertionText }; }
catch (e) {}
/*@@INSERT-END@@*/

/*@@SESSIONS2@@*/
/* Sessions pack 2 (v1.80): duplicate a chat (list and
   stored history) and see message counts in the
   picker. planDuplicate is the pure list step; the
   history copy itself is a raw storage copy. */
function dupSessionName(name) {
  return (name || "Chat") + " copy";
}
function sessionOptionLabel(s, count) {
  return s.name + " (" + count + ")";
}
function planDuplicate(list, activeId, newId) {
  const src = list.find((s) => s.id === activeId);
  if (!src) return null;
  const copy = { id: newId, name: dupSessionName(src.name) };
  return { list: [...list, copy], copy };
}
try { window.__ghostSessions2 = { dupSessionName,
  sessionOptionLabel, planDuplicate }; } catch (e) {}
/*@@SESSIONS2-END@@*/

/*@@PROFILES@@*/
/* Settings profiles (v1.81): named snapshots of the
   settings object. Applying one runs it through the
   same strict sanitize as JSON import, so a profile
   can never smuggle in a bad value. */
function applyProfile(current, profile) {
  if (!profile || typeof profile !== "object" ||
      Array.isArray(profile)) return { ...current };
  const clean = sanitizeImportedSettings(profile, current);
  return { ...current, ...(clean || {}) };
}
function profileNames(map) {
  if (!map || typeof map !== "object") return [];
  return Object.keys(map)
    .sort((a, b) => a.localeCompare(b));
}
try { window.__ghostProfiles = { applyProfile,
  profileNames }; } catch (e) {}
/*@@PROFILES-END@@*/

/*@@PINFILES@@*/
/* Pinned files (v1.82): up to 3 files per project
   that ride along on every send, like a standing
   @mention. togglePin is the pure list step: pinning
   an already-pinned file unpins it, and the cap
   drops the oldest pin. */
const PIN_CAP = 3;
function togglePin(list, path) {
  if (!path) return list.slice();
  if (list.includes(path))
    return list.filter((p) => p !== path);
  return [...list, path].slice(-PIN_CAP);
}
function pinKey(scope) {
  return "ghostide-pinned:" + scope;
}
try { window.__ghostPinFiles = { PIN_CAP, togglePin,
  pinKey }; } catch (e) {}
/*@@PINFILES-END@@*/

/*@@SCRATCH@@*/
/* Scratchpad (v1.83): one persistent note. trimScratch
   is the shared gate for its actions - an empty pad
   does nothing, anywhere. */
function trimScratch(text) {
  const t = String(text || "").trim();
  return t ? t : null;
}
try { window.__ghostScratch = { trimScratch }; }
catch (e) {}
/*@@SCRATCH-END@@*/

/*@@APPEAR2@@*/
/* Appearance pack 2 (v1.84): a compact density for
   the whole UI and a font family for the chat,
   riding the same variable pattern as the chat text
   size. Empty stack means "leave the default". */
const CHAT_FONTS = {
  default: "",
  system: "ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, Menlo, Consolas, monospace",
  serif: "Georgia, 'Times New Roman', serif",
};
function chatFontStack(name) {
  return CHAT_FONTS[name] || "";
}
try { window.__ghostAppear2 = { CHAT_FONTS,
  chatFontStack }; } catch (e) {}
/*@@APPEAR2-END@@*/

/*@@LASTRUN@@*/
/* Last run (v1.85): the generation stats, kept. The
   completion stats used to flash in the context
   meter and vanish; this line keeps the latest one,
   with the temperature and token cap that produced
   it, and survives restarts. */
function lastRunText(stats, temp, maxTok) {
  if (!stats) return "";
  return "Last run: " + stats + " · temp " + temp +
    " · max " + maxTok + " tok";
}
try { window.__ghostLastRun = { lastRunText }; }
catch (e) {}
/*@@LASTRUN-END@@*/

/*@@EXPORT2@@*/
/* Export pack 2 (v1.86): every chat in the project
   in one document. Each chat keeps the standard
   export format, retitled with its session name. */
function titledMarkdown(md, name) {
  return md.replace("# GhostIDE chat export",
    "# " + name);
}
function allChatsExport(parts) {
  return parts.filter((p) => p && p.trim())
    .join("\n---\n\n");
}
try { window.__ghostExport2 = { titledMarkdown,
  allChatsExport }; } catch (e) {}
/*@@EXPORT2-END@@*/

/*@@WHATSNEW@@*/
/* What's new (v1.87): after an update, one quiet
   system message names the newest change. First run
   on a device only sets the baseline - no message -
   and only the single newest entry is ever shown,
   however many versions were skipped. */
function cmpVer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
function whatsNew(entries, seen) {
  if (!entries || !entries.length) return null;
  if (!seen) return null;
  const top = entries[0];
  return cmpVer(top.version, seen) > 0 ? top : null;
}
function whatsNewText(e) {
  return "What's new in v" + e.version + " (" +
    e.goal + "): " + e.summary;
}
try { window.__ghostWhatsNew = { cmpVer, whatsNew,
  whatsNewText }; } catch (e) {}
/*@@WHATSNEW-END@@*/

/*@@FILEACT@@*/
/* File header actions (v1.88): one-tap copies for the
   open file. pathBase is the label helper - the part
   of the path you actually recognize. */
function pathBase(path) {
  if (!path) return "";
  const parts = String(path).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
try { window.__ghostFileAct = { pathBase }; }
catch (e) {}
/*@@FILEACT-END@@*/

/*@@LINEOPS@@*/
/* Line operations (v1.89): duplicate / move / delete
   the cursor's line. planLineOp is pure over an array
   of line strings and returns the new array plus the
   line the cursor should land on. */
function planLineOp(lines, idx, op) {
  if (idx < 0 || idx >= lines.length) return null;
  const out = lines.slice();
  if (op === "dup") {
    out.splice(idx + 1, 0, lines[idx]);
    return { lines: out, idx: idx + 1 };
  }
  if (op === "del") {
    out.splice(idx, 1);
    if (!out.length) out.push("");
    return { lines: out,
      idx: Math.min(idx, out.length - 1) };
  }
  if (op === "up") {
    if (idx === 0) return { lines: out, idx };
    const t = out[idx - 1];
    out[idx - 1] = out[idx];
    out[idx] = t;
    return { lines: out, idx: idx - 1 };
  }
  if (op === "down") {
    if (idx === lines.length - 1)
      return { lines: out, idx };
    const t = out[idx + 1];
    out[idx + 1] = out[idx];
    out[idx] = t;
    return { lines: out, idx: idx + 1 };
  }
  return null;
}
try { window.__ghostLineOps = { planLineOp }; }
catch (e) {}
/*@@LINEOPS-END@@*/

/*@@AUTONAME@@*/
/* Auto-name (v1.90): a chat that still has its
   default name renames itself from its first user
   message - the first 28 characters, whitespace
   collapsed. Renamed chats are never touched. */
function autoChatName(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > 28
    ? clean.slice(0, 27).trim() + "…" : clean;
}
function isDefaultChatName(name) {
  return /^Chat( \d+)?$/.test(String(name || ""));
}
try { window.__ghostAutoName = { autoChatName,
  isDefaultChatName }; } catch (e) {}
/*@@AUTONAME-END@@*/

/*@@STARS@@*/
/* Starred sessions (v1.91): star the chats you live
   in; they sort to the top of the picker with a star
   prefix. Stars live under their own per-project key
   so the session records stay untouched. */
function parseStars(raw) {
  try {
    const a = JSON.parse(raw || "[]");
    return Array.isArray(a)
      ? a.filter((x) => typeof x === "string") : [];
  } catch (e) { return []; }
}
function toggleStar(list, id) {
  return list.includes(id)
    ? list.filter((x) => x !== id) : list.concat([id]);
}
try { window.__ghostStars = { parseStars,
  toggleStar }; } catch (e) {}
/*@@STARS-END@@*/

/*@@SYSPREV@@*/
/* What-Ghost-sees (v1.92): the invisible half of the
   conversation, on one screen. Display only - the
   preview is rendered as a system message and never
   enters history or the model's context. */
function systemPreview(o) {
  return [
    "Style: " + o.style,
    "Persona: " + (o.persona || "(none)"),
    "Custom instructions: " + (o.custom || "(none)"),
    "Sampling: temp " + o.temp + " · max " + o.maxTok +
      " tok",
    "Context: slice budget " + o.budget +
      " chars · history window " + o.window,
  ].join("\n");
}
try { window.__ghostSysPrev = { systemPreview }; }
catch (e) {}
/*@@SYSPREV-END@@*/

/*@@STARANS@@*/
/* Starred answers (v1.93): keep the answers worth
   coming back to. Identity is the answer's first
   120 chars; the list caps at 50, newest last. */
function starKeyOf(text) {
  return String(text || "").slice(0, 120);
}
function parseStarAnswers(raw) {
  try {
    const a = JSON.parse(raw || "[]");
    return Array.isArray(a) ? a.filter((x) => x &&
      typeof x.text === "string") : [];
  } catch (e) { return []; }
}
function toggleStarAnswer(list, item) {
  const k = starKeyOf(item.text);
  const has = list.some(
    (x) => starKeyOf(x.text) === k);
  const out = has
    ? list.filter((x) => starKeyOf(x.text) !== k)
    : list.concat([item]);
  return out.slice(-50);
}
function isStarAnswer(list, text) {
  const k = starKeyOf(text);
  return list.some((x) => starKeyOf(x.text) === k);
}
try { window.__ghostStarAns = { starKeyOf,
  parseStarAnswers, toggleStarAnswer,
  isStarAnswer }; } catch (e) {}
/*@@STARANS-END@@*/

/*@@RETRY@@*/
/* Retry last send (v1.95): a failed send leaves
   history ending on the user's message. retryText
   returns that message, or "" when the last turn
   already has its answer. */
function retryText(hist) {
  if (!hist || !hist.length) return "";
  const last = hist[hist.length - 1];
  return last && last.role === "user"
    ? String(last.content || "") : "";
}
try { window.__ghostRetry = { retryText }; }
catch (e) {}
/*@@RETRY-END@@*/

/*@@TABSPACK@@*/
/* Tabs pack (v1.96): bulk closes computed from a
   snapshot of the open order - closeTab mutates the
   live order as it goes, so callers iterate a copy. */
function othersOf(order, keep) {
  return order.filter((p) => p !== keep);
}
try { window.__ghostTabsPack = { othersOf }; }
catch (e) {}
/*@@TABSPACK-END@@*/

/*@@APPINFO@@*/
/* App info (v1.97): one honest line in Settings -
   the running version (from the bundled changelog,
   the same source What's new reads) and live counts
   of the libraries on this device. */
function appInfoText(o) {
  return "GhostIDE v" + o.version + " · " + o.chats +
    " chats · " + o.prompts + " prompts · " +
    o.profiles + " profiles · " + o.starred +
    " starred answers · eco bundle " + o.eco;
}
try { window.__ghostAppInfo = { appInfoText }; }
catch (e) {}
/*@@APPINFO-END@@*/

/*@@WRAPCHAT@@*/
/* Chat wrap (v1.98): one body class flips the chat
   to soft wrapping. Pure step maps the setting. */
function wrapChatClass(on) {
  return on ? "chat-wrap" : "";
}
try { window.__ghostWrapChat = { wrapChatClass }; }
catch (e) {}
/*@@WRAPCHAT-END@@*/

/*@@FSQUICK@@*/
/* Chat size quick-step (v1.99): A- and A+ walk the
   same size list the Settings picker offers, clamped
   at both ends. Unknown values land on the middle. */
const FS_STEPS = ["12", "13", "15"];
function stepFs(cur, dir) {
  let i = FS_STEPS.indexOf(String(cur));
  if (i < 0) i = 1;
  i = Math.min(FS_STEPS.length - 1, Math.max(0, i + dir));
  return FS_STEPS[i];
}
try { window.__ghostFsQuick = { FS_STEPS, stepFs }; }
catch (e) {}
/*@@FSQUICK-END@@*/

/*@@CHATSEARCH@@*/
/* Search all chats (v2.00): case-insensitive scan
   of every stored chat in the project. Hits carry
   the chat name, who said it, and a window around
   the match. Capped so one common word cannot flood
   the chat. */
function searchChats(chats, q, cap) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return [];
  const limit = cap || 12;
  const out = [];
  for (const c of chats || []) {
    for (const m of c.messages || []) {
      const text = String(m.content || "");
      const i = text.toLowerCase().indexOf(needle);
      if (i < 0) continue;
      const from = Math.max(0, i - 40);
      out.push({ chat: c.name, role: m.role,
        excerpt: (from ? "\u2026" : "") +
          text.slice(from, i + needle.length + 60)
            .replace(/\s+/g, " ") + "\u2026" });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
function searchResultsText(q, hits) {
  if (!hits.length)
    return "No matches for \"" + q + "\" in this project.";
  return hits.length + " match" +
    (hits.length === 1 ? "" : "es") + " for \"" + q +
    "\":\n\n" + hits.map((h) => "[" + h.chat + "] " +
    (h.role === "user" ? "You" : "Ghost") + ": " +
    h.excerpt).join("\n\n");
}
try { window.__ghostChatSearch = { searchChats,
  searchResultsText }; } catch (e) {}
/*@@CHATSEARCH-END@@*/

/*@@AUTOSAVE@@*/
/* Autosave (v2.01): the poller snapshots the doc
   every 1.5s; autosave is due only when the setting
   is on, a file is open and dirty, and the snapshot
   has been stable for two ticks (about 3 idle
   seconds). Typing resets the clock by changing
   the snapshot. */
function autosaveDue(on, hasFile, isDirty, idleTicks) {
  return !!(on && hasFile && isDirty && idleTicks >= 2);
}
try { window.__ghostAutosave = { autosaveDue }; }
catch (e) {}
/*@@AUTOSAVE-END@@*/

/*@@SUMMARIZE@@*/
/* Summarize chat (v2.02): not a new pipeline - a
   standing instruction sent as a normal message.
   The model's history window does the rest. Needs
   at least one full exchange to be worth asking. */
function summaryRequest(hist) {
  if (!hist || hist.length < 2) return "";
  return "Summarize our conversation so far in at " +
    "most 5 short bullet points: what we set out " +
    "to do, what we decided, and what is still " +
    "open. Plain language, no code unless it " +
    "matters.";
}
try { window.__ghostSummarize = { summaryRequest }; }
catch (e) {}
/*@@SUMMARIZE-END@@*/

/*@@DUPFILE@@*/
/* Duplicate file (v2.03): the suggested name puts
   " copy" before the extension, in the same folder.
   Dotfiles and extensionless names take it at the
   end. */
function copyName(path) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot > 0)
    return dir + base.slice(0, dot) + " copy" +
      base.slice(dot);
  return dir + base + " copy";
}
try { window.__ghostDupFile = { copyName }; }
catch (e) {}
/*@@DUPFILE-END@@*/

/*@@JUMP@@*/
/* Jump to latest (v2.04): the button shows only
   when the reader is well above the bottom - the
   inverse of the auto-scroll pack's near-bottom
   test, with a wider threshold so it does not
   flicker over a line or two. */
function showJump(st, ch, sh) {
  return !isNearBottom(st, ch, sh, 120);
}
try { window.__ghostJump = { showJump }; }
catch (e) {}
/*@@JUMP-END@@*/

/*@@CLEARCHATS@@*/
/* Clear all chats (v2.05): the key list comes from
   the real sessionHistoryKey, so the default
   session's bare key and the named sessions' keys
   are all covered - nothing else in storage is
   touched. */
function projectHistoryKeys(scope, sessions) {
  return (sessions || []).map(
    (s) => sessionHistoryKey(scope, s.id));
}
try { window.__ghostClearChats = { projectHistoryKeys }; }
catch (e) {}
/*@@CLEARCHATS-END@@*/

/*@@SPEAKLAST@@*/
/* Speak last answer (v2.06): the newest assistant
   message in history, or "" when there is none. */
function lastAnswerOf(hist) {
  const h = hist || [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].role === "assistant")
      return String(h[i].content || "");
  }
  return "";
}
try { window.__ghostSpeakLast = { lastAnswerOf }; }
catch (e) {}
/*@@SPEAKLAST-END@@*/


// @@GHCONNECT@@ GitHub connect (v2.08): pure helpers
// for the git panel's remote section. The token is
// sent per request to the local server only and used
// through git's askpass env; it is never written to
// .git/config by these endpoints.
export function repoNameFromUrl(url) {
  const clean = String(url || "").trim().replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const parts = clean.split(/[/:]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
export function validRemoteUrl(url) {
  const u = String(url || "").trim();
  return !!u && !u.startsWith("-");
}
// @@GHCONNECT-END@@

/*@@ABOUT@@*/
/* About this build (v2.07): the Settings info line
   plus the newest changelog entry, in the chat.
   Missing changelog data degrades to the info line
   alone - never an error. */
function aboutText(info, entry, evidence) {
  let out = info;
  if (entry) out += "\n\nLatest change (v" + entry.version +
    ", " + entry.goal + "): " + entry.summary;
  if (evidence) out += "\n\nBuild evidence: " + evidence;
  return out;
}
try { window.__ghostAbout = { aboutText }; }
catch (e) {}
/*@@ABOUT-END@@*/

/* ---------------- chat ---------------- */
const history = [];

/* Roadmap ECO E4: when a chat is primed, its GhostPrimer
   bundle (PRIMER.md) is the chat's first context and rides
   in the system message on every send until the chat is
   cleared or another prime replaces it. Session-scoped:
   a reload starts unprimed, like a fresh session. */
let primerContext = null;

/* Roadmap ECO E5: recalled project memory - the
   GhostRecall bundle export (PROMPT.md) for a task, attached
   from the Recall action's results. Rides in the system
   message behind the primer until the chat is cleared or
   another recall replaces it. Session-scoped, like the
   primer. */
let recallContext = null;
let recallTaskLabel = "";

/* Session continuity (Phase 3.4): chat history is saved per project
   (keyed by workspace path; the phone's scope is "on-device") and
   restored when you come back to that project. */
const GREETING =
  "Hey - I'm Ghost, your offline coding partner. Open a " +
  "file and ask about it, or pause while typing for " +
  "inline suggestions. Nothing leaves this device.";
let historyScope = null;
function historyKey() {
  return sessionHistoryKey(historyScope, activeSession);
}
function saveHistory() {
  if (!historyScope) return;
  try {
    localStorage.setItem(historyKey(),
      JSON.stringify(history.slice(-60)));
  } catch (e) { /* best-effort */ }
  updateChatStats();
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
      const body = addMsg("YOU", m.content);
      attachEditBtn(body.parentElement, history.length - 1);
    } else {
      renderRich(addMsg("GHOST", ""), m.content);
    }
  }
  if (!items.length) addMsg("GHOST", GREETING);
  restoreChatDraft();
  updateChatStats();
  applyChatFind();
  loadPinned();
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
  if (text && text.trim()) {
    const cp = document.createElement("button");
    cp.className = "msgCopy";
    cp.textContent = "⧉ Copy";
    cp.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        cp.textContent = "✓ Copied";
        setTimeout(() => { cp.textContent = "⧉ Copy"; }, 1200);
      } catch (e) {}
    };
    el.appendChild(cp);
    const sv = document.createElement("button");
    sv.className = "msgCopy";
    sv.textContent = "💾 Save";
    sv.onclick = async () => {
      const d = await postJson("/api/file",
        { path: answerFilename(new Date()), content: text });
      if (d.error) { alert(d.error); return; }
      await loadFiles();
      sv.textContent = "✓ Saved";
      setTimeout(() => { sv.textContent = "💾 Save"; }, 1200);
    };
    el.appendChild(sv);
    const sp = document.createElement("button");
    sp.className = "msgCopy";
    sp.textContent = "🔊 Speak";
    sp.onclick = () => {
      if (!("speechSynthesis" in window)) {
        alert("Speech is not available on this device.");
        return;
      }
      if (speechSynthesis.speaking) {
        speechSynthesis.cancel();
        return;
      }
      speechSynthesis.speak(
        new SpeechSynthesisUtterance(speakText(text)));
    };
    el.appendChild(sp);
    const ins = document.createElement("button");
    ins.className = "msgCopy";
    ins.textContent = "⤵ Insert";
    ins.title = "Insert into the editor at the cursor";
    ins.onclick = () => {
      if (!currentFile) {
        alert("Open a file first, then insert.");
        return;
      }
      const sel = view.state.selection.main;
      const payload = insertionText(text);
      view.dispatch({
        changes: { from: sel.from, to: sel.to,
          insert: payload },
        selection: { anchor: sel.from + payload.length },
      });
      view.focus();
      ins.textContent = "✓ Inserted";
      setTimeout(() => {
        ins.textContent = "⤵ Insert";
      }, 1200);
    };
    el.appendChild(ins);
    const star = document.createElement("button");
    star.className = "msgCopy";
    star.textContent = isStarAnswer(loadStarAnswers(),
      text) ? "\u2605 Starred" : "\u2606 Star";
    star.title = "Keep this answer in Starred answers";
    star.onclick = () => {
      const list = toggleStarAnswer(loadStarAnswers(),
        { ts: Date.now(), text });
      persistStarAnswers(list);
      star.textContent = isStarAnswer(list, text)
        ? "\u2605 Starred" : "\u2606 Star";
    };
    el.appendChild(star);
    const blocks = extractCodeBlocks(text);
    if (blocks.length) {
      const cb2 = document.createElement("button");
      cb2.className = "msgCopy";
      cb2.textContent = "</> Code (" + blocks.length + ")";
      cb2.onclick = async () => {
        try {
          await navigator.clipboard.writeText(
            blocks.join("\n\n"));
          cb2.textContent = "✓ Copied";
          setTimeout(() => {
            cb2.textContent = "</> Code (" + blocks.length + ")";
          }, 1200);
        } catch (e) {}
      };
      el.appendChild(cb2);
    }
  }
}

function addMsg(who, text, stamp) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  const w = document.createElement("div");
  w.className = "who";
  w.textContent = who;
  if (settings.timestamps && stamp) {
    const st = document.createElement("span");
    st.className = "stamp";
    st.textContent = " · " + msgStamp(new Date());
    w.appendChild(st);
  }
  const body = document.createElement("div");
  body.textContent = text;
  wrap.appendChild(w);
  wrap.appendChild(body);
  const logEl = $("chatLog");
  const wasNear = isNearBottom(logEl.scrollTop,
    logEl.clientHeight, logEl.scrollHeight);
  logEl.appendChild(wrap);
  if (shouldChatScroll(settings.autoScroll, wasNear))
    logEl.scrollTop = logEl.scrollHeight;
  return body;
}

async function sendChat() {
  const ta = $("chatText");
  const text = ta.value.trim();
  if (!text) return;
  recordSent(text);
  const slash = parseSlash(text);
  if (slash) {
    ta.value = "";
    clearChatDraft();
    updateChatCount();
    runSlash(slash);
    return;
  }
  if (!modelUp) { addMsg("SYSTEM", "Model is down - hit Start model first."); return; }
  if ($("planToggle") && $("planToggle").checked) {
    ta.value = "";
    runPlan(text);
    return;
  }
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
  sysContent += personaSuffix(settings.chatStyle,
    settings.customInstr);
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
        mode, budget: sliceBudget(),
        seed: currentFile || undefined });
      if (d.error) {
        addMsg("SYSTEM", "Project slice unavailable: " + d.error +
          " - sending with no project context.");
        $("ctxMeter").textContent = "context: none (slice failed)";
      } else if (d.over) {
        addMsg("SYSTEM", "Project slice is ~" + d.tokens +
          " tokens - over the " + sliceBudget().toLocaleString() + " budget, so this message was NOT " +
          "sent. Switch context to current file, or shrink the project.");
        return;
      } else {
        sysContent = SYS + "\nProject context (" + d.mode +
          " slice, " + d.files + " files):\n" + d.text;
        $("ctxMeter").textContent = "context: " + d.mode + " slice · " +
          d.tokens.toLocaleString() + " / " + sliceBudget().toLocaleString() + " tok · " + d.files +
          " files (full project ~" +
          d.originalTokens.toLocaleString() + " tok)";
        if (d.mode === "smart" && d.included) {
          $("ctxMeter").textContent += " · " +
            d.included.map((i) => i.path).join(", ");
        }
      }
    }
  }

  /* Roadmap ECO E4: a primed chat's first context - the
     GhostPrimer bundle rides in the system message ahead
     of the per-message attachments. */
  if (primerContext) {
    sysContent += "\n\nProject primer (GhostPrimer starter " +
      "bundle for this project, built in this IDE and " +
      "verified by the tool's own check):\n" + primerContext;
  }

  /* Roadmap ECO E5: recalled project memory rides behind
     the primer (see the Recall action). */
  if (recallContext) {
    sysContent += "\n\nProject memory (GhostRecall selection" +
      (recallTaskLabel
        ? " for the task \"" + recallTaskLabel + "\"" : "") +
      ", exported by the tool itself under the context " +
      "budget; token counts in it are the tool's " +
      "estimates):\n" + recallContext;
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
  for (const p of pinnedFiles) {
    try {
      const rp = await fetch("/api/file?path=" +
        encodeURIComponent(p));
      const dp = await rp.json();
      if (!dp.error && dp.content != null) {
        sysContent += "\nPinned file " + p + ":\n```\n" +
          dp.content.slice(0, BEHAVIOR.context.fileChars) +
          "\n```";
        attachedNames.push("📌 " + p);
      }
    } catch (e) { /* pinned files are best-effort */ }
  }
  const selNow = view.state.selection.main;
  if (!selNow.empty && currentFile &&
      settings.attachSelection !== false) {
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
  clearChatDraft();
  updateChatCount();
  addMsg("YOU", text, true);
  history.push({ role: "user", content: text });
  maybeAutoName(text);
  saveHistory();
  const messages = [{ role: "system", content: sysContent },
    ...windowHistory(history, settings.historyTurns)];

  const chatT0 = Date.now();
  const body = addMsg("GHOST", "", true);
  let full = "";
  thermalWarned = false;
  let thermalStopped = false;
  chatAbort = new AbortController();
  const thermTimer = setInterval(() => {
    if (thermalWatchdog() === "stop") {
      thermalStopped = true;
      if (chatAbort) chatAbort.abort();
    }
  }, 8000);
  const sendBtn = $("chatSend");
  sendBtn.textContent = "■ Stop";
  sendBtn.onclick = () => { if (chatAbort) chatAbort.abort(); };
  if (settings.attachDiff) {
    try {
      const dr = await fetch("/api/git/diff-all");
      const dg = await dr.json();
      const snip = diffSnippet(dg.diff || "");
      if (snip) sysContent += "\nUncommitted changes " +
        "(git diff vs HEAD):\n" + snip;
    } catch (e) {}
  }
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: chatAbort.signal,
      body: JSON.stringify({
        messages, stream: true,
        max_tokens: answerMaxTokens(settings.chatLength,
          settings.shortAnswers, BEHAVIOR.chat.maxTokens,
          settings.customTokens),
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
          const logS = $("chatLog");
          if (shouldChatScroll(settings.autoScroll,
              isNearBottom(logS.scrollTop,
                logS.clientHeight, logS.scrollHeight)))
            logS.scrollTop = logS.scrollHeight;
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
  clearInterval(thermTimer);
  if (thermalStopped)
    addMsg("SYSTEM", "🌡 Generation stopped: the device " +
      "reached severe heat. Let it cool, then ask again. " +
      "(Thermal guard, Roadmap G40.)");
  chatAbort = null;
  sendBtn.textContent = "Send";
  sendBtn.onclick = sendChat;
  renderRich(body, full);
  const stats = genStats(full.length, Date.now() - chatT0);
  if (stats) {
    $("ctxMeter").textContent = stats;
    const lr = lastRunText(stats, settings.temperature,
      answerMaxTokens(settings.chatLength,
        settings.shortAnswers, BEHAVIOR.chat.maxTokens,
        settings.customTokens));
    $("lastRun").textContent = lr;
    try {
      localStorage.setItem("ghostide-lastrun", lr);
    } catch (e) {}
  }
  history.push({ role: "assistant", content: full });
  saveHistory();
  notifyDone("Ghost answered", "Your chat reply is ready.",
    chatT0);
}

let chatAbort = null;
// R18: a reload or close mid-stream throws the
// in-flight answer away; warn where the platform
// surfaces beforeunload.
window.addEventListener("beforeunload", (e) => {
  if (chatAbort) {
    e.preventDefault();
    e.returnValue = "";
  }
});
$("chatSend").onclick = sendChat;
$("chatText").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  if (settings.sendKey === "ctrl" &&
      !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault(); sendChat();
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
  tourObserve({ type: "run", file: currentFile,
    code: d.code, text: (d.stderr || "") +
      (d.stdout || "") });
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
  refreshGhRemote();
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

// GitHub connect (v2.08): panel wiring. The token
// persists on this device only (localStorage) and is
// sent per request to the local server.
function ghToken() {
  const el = $("ghToken");
  return el ? el.value.trim() : "";
}
function ghSay(text) {
  const out = $("ghOut");
  if (out) out.textContent = text || "";
}
async function ghPost(path, extra) {
  ghSay("working...");
  const r = await postJson(path,
    Object.assign({ token: ghToken() }, extra || {}));
  if (r.error) { ghSay("Error: " + r.error); return null; }
  ghSay(r.output || "Done.");
  return r;
}
async function refreshGhRemote() {
  const info = $("ghRemoteInfo");
  if (!info) return;
  try {
    const r = await fetch("/api/git/remote");
    const d = await r.json();
    if (!d.repo || !d.remotes || !d.remotes.length) {
      info.textContent = "No remote set on this repo yet.";
      return;
    }
    info.textContent = d.remotes.map(function (x) {
      return x.name + ": " + (x.url || "(no url)");
    }).join("  ");
    const origin = d.remotes.filter(function (x) {
      return x.name === "origin";
    })[0] || d.remotes[0];
    const urlEl = $("ghRemoteUrl");
    if (origin && urlEl && !urlEl.value) urlEl.value = origin.url;
  } catch (e) { /* panel still loading */ }
}
(function wireGhConnect() {
  const tok = $("ghToken");
  if (!tok) return;
  try {
    tok.value = localStorage.getItem("ghostide-gh-token") || "";
  } catch (e) { /* storage off */ }
  tok.addEventListener("change", function () {
    try {
      localStorage.setItem("ghostide-gh-token", tok.value.trim());
    } catch (e) { /* storage off */ }
  });
  $("ghSaveRemote").onclick = async () => {
    const url = $("ghRemoteUrl").value.trim();
    if (!validRemoteUrl(url)) {
      ghSay("Paste a remote URL first."); return;
    }
    const r = await ghPost("/api/git/remote-set",
      { name: "origin", url: url });
    if (r) { ghSay("Remote saved."); refreshGhRemote(); }
  };
  $("ghClone").onclick = async () => {
    const url = $("ghRemoteUrl").value.trim();
    if (!validRemoteUrl(url)) {
      ghSay("Paste a repo URL to clone first."); return;
    }
    const dir = prompt("Clone into folder:",
      repoNameFromUrl(url));
    if (!dir) return;
    const r = await ghPost("/api/git/clone",
      { url: url, dir: dir.trim() });
    if (r) { loadFiles(); refreshGit(); }
  };
  $("ghFetch").onclick = async () => {
    await ghPost("/api/git/fetch", {});
  };
  $("ghPull").onclick = async () => {
    const r = await ghPost("/api/git/pull", {});
    if (r) { loadFiles(); refreshGit(); }
  };
  $("ghPush").onclick = async () => {
    const r = await ghPost("/api/git/push", {});
    if (r) refreshGit();
  };
})();

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
      loadSessions();
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
/* Roadmap ECO E3: indexed search. The server (re)builds the
   workspace FTS5 index with the GhostIndex tool itself and
   returns the tool's own JSON; the excerpts below are the
   CLI's excerpts, rendered untouched, and open at the hit. */
$("findIndexed").onclick = async () => {
  const q = $("findQuery").value;
  const box = $("findResults");
  if (!q.trim()) return;
  box.textContent = "indexing + searching…";
  const d = await postJson("/api/eco/search", { query: q });
  if (d.error) { box.textContent = d.error; return; }
  box.innerHTML = "";
  if (!d.hits || !d.hits.length) {
    box.textContent = "No matches in the index.";
    return;
  }
  for (const h of d.hits) {
    const wins = h.windows || [];
    const firstLine = (wins.length && wins[0].match_lines &&
      wins[0].match_lines.length) ? wins[0].match_lines[0] : 1;
    const head = document.createElement("div");
    head.className = "findRow";
    head.textContent = "🔎 " + h.rel + "  (~" +
      (h.excerpt_tokens_est || 0) + " tok excerpt)";
    head.onclick = async () => {
      await openFile(h.rel);
      jumpToLine(firstLine);
    };
    box.appendChild(head);
    for (const w of wins) {
      const pre = document.createElement("pre");
      pre.className = "findExcerpt";
      const wLines = (w.text || "").split("\n");
      pre.textContent = wLines.map((t, i) =>
        (w.start_line + i) + "  " + t).join("\n");
      const target = (w.match_lines && w.match_lines.length)
        ? w.match_lines[0] : w.start_line;
      pre.onclick = async () => {
        await openFile(h.rel);
        jumpToLine(target);
      };
      box.appendChild(pre);
    }
  }
  const n = document.createElement("div");
  n.className = "dim";
  n.textContent = "GhostIndex FTS5: " + d.shown + " of " +
    d.total_matches + " file(s) shown, excerpts token-budgeted" +
    (d.capped ? " (capped by " + (d.capped_by || []).join(", ") +
      ")" : "") + ". Counts are the tool's estimates.";
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

/* ---------------- Agent v2: checkpoints + resume wiring ---- */
$("ckptBtn").onclick = () => openCheckpointsPanel();
$("agentResumeBtn").onclick = () => {
  const active = agentActiveLoad();
  if (!active || !active.task) {
    addMsg("SYSTEM", "No saved agent task to resume.");
    return;
  }
  addMsg("SYSTEM", "Resuming the saved agent task: " +
    active.task);
  runAgent(active.task, { plan: active.plan || "",
    todos: active.todos || [], staged: active.staged || {},
    deletions: active.deletions || [] });
};

/* ---------------- Phase 6: clear chat ---------------- */
$("clearChatBtn").onclick = () => {
  if (!confirm("Clear this project's chat history?")) return;
  history.length = 0;
  primerContext = null;
  recallContext = null;
  recallTaskLabel = "";
  saveHistory();
  $("chatLog").innerHTML = "";
  addMsg("GHOST", GREETING);
};

/*@@E4@@*/
/* Roadmap ECO E4: the pure state step behind the two chat
   actions, kept free of DOM access so the headless harness
   can drive it. A successful prime response starts a NEW
   chat: the history is empty and the bundle (PRIMER.md)
   becomes the chat's first context. The check verdict is
   the tool's own (its report's ok flag + files checked).
   Returns null when the response is not a usable prime. */
function primerChatState(resp) {
  if (!resp || resp.error || !resp.primer) return null;
  const chk = resp.check || {};
  return {
    history: [],
    primerContext: resp.primer,
    passed: chk.ok === true,
    filesChecked: chk.files_checked || 0,
    errors: chk.errors || [],
  };
}
/* A handoff response is usable exactly when it carries
   the pack's HANDOFF.md text. */
function handoffText(resp) {
  if (!resp || resp.error || !resp.handoff) return null;
  return resp.handoff;
}
/*@@E4-END@@*/

/* ---------------- Roadmap ECO E4: prime + handoff -----
   Both actions run the ecosystem tool itself on the
   server; this side only starts a fresh chat around the
   primer bundle or renders the handoff draft in place. */
$("primeBtn").onclick = async () => {
  const btn = $("primeBtn");
  btn.disabled = true;
  addMsg("SYSTEM", "🧭 Building a starter bundle for " +
    "this project with GhostPrimer…");
  try {
    const d = await postJson("/api/eco/prime", {});
    const st = primerChatState(d);
    if (!st) {
      addMsg("SYSTEM", "Primer failed: " +
        (d.error || "the tool could not run."));
      return;
    }
    history.length = 0;
    primerContext = st.primerContext;
    saveHistory();
    $("chatLog").innerHTML = "";
    addMsg("SYSTEM", "🧭 New chat, primed with this " +
      "project. GhostPrimer check " +
      (st.passed ? "passed" : "FAILED") + " (" +
      st.filesChecked + " bundle file(s) verified). The " +
      "bundle below is this chat's first context; it is " +
      "saved in the project at .ghostide/primer/.");
    renderRich(addMsg("GHOST", ""), st.primerContext);
  } catch (e) {
    addMsg("SYSTEM", "Primer failed to reach the server.");
  } finally {
    btn.disabled = false;
  }
};
$("handoffBtn").onclick = async () => {
  const btn = $("handoffBtn");
  btn.disabled = true;
  addMsg("SYSTEM", "📦 Drafting a handoff pack from " +
    "repo facts with GhostHandoff (propose-only: nothing " +
    "is committed, sent, or changed)…");
  try {
    const d = await postJson("/api/eco/handoff", {});
    const md = handoffText(d);
    if (!md) {
      addMsg("SYSTEM", "Handoff failed: " +
        (d.error || "the tool could not build a pack."));
      return;
    }
    addMsg("SYSTEM", "📦 Handoff draft saved in the " +
      "project at .ghostide/handoff/HANDOFF.md - a draft " +
      "for you to read; nothing was sent anywhere.");
    renderRich(addMsg("GHOST", ""), md);
  } catch (e) {
    addMsg("SYSTEM", "Handoff failed to reach the server.");
  } finally {
    btn.disabled = false;
  }
};

/*@@E5@@*/
/* Roadmap ECO E5: the pure state steps behind the Atlas
   view and the Recall chat action, kept free of DOM access
   so the headless harness can drive them. An atlas response
   is usable when it carries the tool's files array; the
   total is the sum of the tool's own per-file token
   estimates. A recall response is usable in "recall" mode
   (the tool's ranked selection) or "scan" mode (every item
   by estimated cost); both normalize to one row shape
   carrying the tool's provenance and estimated costs. */
function atlasState(resp) {
  if (!resp || resp.error || !Array.isArray(resp.files))
    return null;
  let totalTokens = 0;
  for (const f of resp.files) totalTokens += f.tokens || 0;
  return {
    title: resp.title || "",
    files: resp.files,
    totalTokens: totalTokens,
    packages: Array.isArray(resp.packages) ? resp.packages : [],
    dead: Array.isArray(resp.dead_candidates)
      ? resp.dead_candidates : [],
    git: resp.git || null,
  };
}
function recallRows(resp) {
  if (!resp || resp.error) return null;
  if (resp.mode === "recall") {
    const rows = (resp.selected || []).map((e) => {
      const p = e.provenance || {};
      return {
        id: e.id, title: e.title,
        tokens: e.tokens_estimate || 0,
        score: typeof e.score === "number" ? e.score : null,
        pinned: !!e.pinned,
        path: p.path || "", line: p.line || null,
        date: p.date || null, commit: p.commit || null,
        sourceType: "", status: "", blocked: false,
      };
    });
    return {
      mode: "recall", task: resp.task || "", rows: rows,
      notSelected: resp.not_selected || [],
      conflicts: resp.conflicts || [],
    };
  }
  if (resp.mode === "scan") {
    const rows = (resp.items || []).map((e) => ({
      id: e.id, title: e.title,
      tokens: e.tokens_estimate || 0,
      score: null, pinned: false,
      path: e.path || "", line: e.line || null,
      date: e.date || null, commit: null,
      sourceType: e.source_type || "",
      status: e.status || "", blocked: !!e.blocked,
    }));
    return { mode: "scan", task: "", rows: rows,
             notSelected: [], conflicts: [] };
  }
  return null;
}
/* A context response is usable exactly when it carries the
   bundle's merged PROMPT.md text. */
function recallContextState(resp) {
  if (!resp || resp.error || !resp.context) return null;
  return { context: resp.context, totals: resp.totals || null };
}
/*@@E5-END@@*/

/* ---------------- Roadmap ECO E5: recall action --------
   Runs the GhostRecall tool itself on the server; this
   side renders its ranked output and, on request, carries
   the tool's own bundle export as chat context (the same
   system-message carriage as the E4 primer). */
async function addRecallToContext(task) {
  try {
    const d = await postJson("/api/eco/recall", {
      task: task || "",
      budget: sliceBudget(), context: true });
    const st = recallContextState(d);
    if (!st) {
      addMsg("SYSTEM", "Recall could not build its bundle: " +
        (d.error || "the tool could not run."));
      return;
    }
    recallContext = st.context;
    recallTaskLabel = task || "";
    const t = st.totals || {};
    $("ctxMeter").textContent = "context: recall memory · " +
      (t.memory_items != null
        ? t.memory_items + " items · " : "") +
      "~" + (t.prompt_tokens_estimate != null
        ? t.prompt_tokens_estimate : "?") +
      " est tok (GhostRecall estimates)";
    addMsg("SYSTEM", "📚 Recalled memory is attached to " +
      "this chat's context" +
      (task ? " for: " + task : "") +
      ". The bundle is saved in the project at " +
      ".ghostide/recall/; clear the chat to drop it.");
  } catch (e) {
    addMsg("SYSTEM", "Recall failed to reach the server.");
  }
}
function renderRecallResults(st) {
  const body = addMsg("GHOST", "");
  const head = document.createElement("div");
  head.textContent = st.mode === "recall"
    ? "📚 GhostRecall ranked this project's memory for: "
      + st.task
    : "📚 GhostRecall found this project's memory:";
  body.appendChild(head);
  if (!st.rows.length) {
    const none = document.createElement("div");
    none.className = "dim";
    none.textContent = "No memory items were selected. " +
      "Recall reads DECISIONS.md, notes, docs, changelogs " +
      "and git history inside the project.";
    body.appendChild(none);
  }
  for (const r of st.rows) {
    const row = document.createElement("div");
    row.className = "findRow";
    const main = document.createElement("span");
    main.textContent = (r.pinned ? "📌 " : "") + r.title;
    row.appendChild(main);
    const meta = document.createElement("span");
    meta.className = "dim";
    let prov = r.commit
      ? "git " + String(r.commit).slice(0, 10)
      : r.path + (r.line ? ":" + r.line : "");
    meta.textContent = " · ~" + r.tokens + " est tok · " +
      prov +
      (r.date ? " · " + r.date : "") +
      (r.score != null
        ? " · score " + r.score.toFixed(3) : "") +
      (r.sourceType ? " · " + r.sourceType : "") +
      (r.status && r.status !== "active"
        ? " · " + r.status : "") +
      (r.blocked ? " · blocked (secret findings)" : "");
    row.appendChild(meta);
    if (r.path && !r.commit) {
      row.onclick = () => {
        openFile(r.path).then(() => {
          if (r.line) jumpToLine(r.line);
        }).catch(() => {});
      };
    }
    body.appendChild(row);
  }
  for (const c of st.conflicts) {
    const row = document.createElement("div");
    row.className = "dim";
    row.textContent = "⚠ conflict (" + (c.type || "") +
      "): " + (c.note || "");
    body.appendChild(row);
  }
  if (st.notSelected.length) {
    const ns = document.createElement("div");
    ns.className = "dim";
    const reasons = [...new Set(
      st.notSelected.map((e) => e.reason))].join(", ");
    ns.textContent = "Not selected: " +
      st.notSelected.length + " item(s) (" + reasons + ").";
    body.appendChild(ns);
  }
  if (st.rows.length) {
    const add = document.createElement("button");
    add.className = "ghostbtn";
    add.textContent =
      "➕ Add the selected memory to chat context";
    add.onclick = async () => {
      add.disabled = true;
      add.textContent = "Adding…";
      await addRecallToContext(st.task);
      add.textContent =
        "✓ Added - it rides with your next messages";
    };
    body.appendChild(add);
  }
  const note = document.createElement("div");
  note.className = "dim";
  note.textContent = "Token counts are GhostRecall " +
    "estimates, not exact tokenizer counts.";
  body.appendChild(note);
}
$("recallBtn").onclick = async () => {
  const btn = $("recallBtn");
  btn.disabled = true;
  const task = $("chatText").value.trim();
  addMsg("SYSTEM", task
    ? "📚 Recalling project memory for: " + task + "…"
    : "📚 Listing this project's memory with GhostRecall…");
  try {
    const d = await postJson("/api/eco/recall", { task: task });
    const st = recallRows(d);
    if (!st) {
      addMsg("SYSTEM", "Recall failed: " +
        (d.error || "the tool could not run."));
      return;
    }
    renderRecallResults(st);
  } catch (e) {
    addMsg("SYSTEM", "Recall failed to reach the server.");
  } finally {
    btn.disabled = false;
  }
};

/*@@E6@@*/
/* Roadmap ECO E6: the pure state steps behind the Context
   lab's GhostConvert export. parseLosses turns a LOSSES.md
   into the named loss list (each loss is a "## " heading
   with its detail paragraph), and convertState normalizes
   a convert response into render rows: per format, the
   artifacts the tool wrote and the losses it named. A
   response is usable exactly when it carries outputs. */
function parseLosses(lossesMd) {
  const out = [];
  if (!lossesMd) return out;
  let cur = null;
  for (const ln of String(lossesMd).split("\n")) {
    if (ln.startsWith("## ")) {
      cur = { name: ln.slice(3).trim(), detail: "" };
      out.push(cur);
    } else if (cur && ln.trim()) {
      cur.detail = cur.detail
        ? cur.detail + " " + ln.trim() : ln.trim();
    }
  }
  return out;
}
function convertState(resp) {
  if (!resp || resp.error || !resp.ok
      || !Array.isArray(resp.outputs)) return null;
  return {
    target: resp.target || "",
    bundle: resp.bundle || ".ghostide/slice",
    slice: resp.slice || null,
    verify: resp.verify || null,
    outputs: resp.outputs.map((o) => {
      const parsed = parseLosses(o.losses || "");
      return {
        target: o.target || "",
        dir: o.dir || "",
        artifacts: (o.artifacts || []).map((a) => ({
          path: a.path || "", content: a.content || "" })),
        lossesList: parsed.length ? parsed
          : (o.losses_names || []).map((n) => ({
              name: n, detail: "" })),
      };
    }),
  };
}
/*@@E6-END@@*/

/* ---------------- Roadmap ECO E6: convert export ------
   From the Context lab: the server materialises the
   current slice as a GhostSlice bundle and runs the
   GhostConvert tool itself on it; this side renders the
   artifacts, names the losses per format (from the
   tool's own LOSSES.md), and saves artifacts through the
   same Blob download the file menu uses. The slice mode
   is the chat's selected slice (file/smart export as a
   signatures project slice, the Save-slice mapping). */
function downloadConverted(name, content) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content],
    { type: "text/plain" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function renderCtxExport(st) {
  const out = $("ctxExportOut");
  out.innerHTML = "";
  const s = st.slice || {};
  const head = document.createElement("div");
  head.textContent = "Exported the current slice (" +
    (s.mode || "?") + " · " + (s.files || 0) + " files · ~" +
    (s.tokens || 0) + " est tok) from " + st.bundle +
    " · output verified by GhostConvert ✓";
  out.appendChild(head);
  for (const o of st.outputs) {
    const sec = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = o.target + " → " + o.dir;
    sec.appendChild(title);
    for (const a of o.artifacts) {
      const row = document.createElement("div");
      row.className = "ctxRow";
      const label = document.createElement("span");
      label.textContent = a.path + " (" + a.content.length +
        " chars)";
      row.appendChild(label);
      const dl = document.createElement("button");
      dl.textContent = "⬇ Save";
      dl.onclick = () => downloadConverted(
        a.path.split("/").pop(), a.content);
      row.appendChild(dl);
      sec.appendChild(row);
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "View " + a.path;
      const pre = document.createElement("pre");
      pre.textContent = a.content;
      det.appendChild(sum);
      det.appendChild(pre);
      sec.appendChild(det);
    }
    const ldiv = document.createElement("div");
    if (o.lossesList.length) {
      const lh = document.createElement("div");
      lh.textContent = "Losses for " + o.target + " (" +
        o.lossesList.length + ", from LOSSES.md):";
      ldiv.appendChild(lh);
      const ul = document.createElement("ul");
      for (const l of o.lossesList) {
        const li = document.createElement("li");
        li.textContent = l.detail
          ? l.name + " - " + l.detail : l.name;
        ul.appendChild(li);
      }
      ldiv.appendChild(ul);
    } else {
      ldiv.textContent = "Losses for " + o.target +
        ": none recorded.";
    }
    sec.appendChild(ldiv);
    out.appendChild(sec);
  }
}
$("ctxExportBtn").onclick = async () => {
  const out = $("ctxExportOut");
  const target = $("ctxExportTarget").value;
  const raw = $("ctxMode").value;
  const mode = (raw === "file" || raw === "smart")
    ? "signatures" : raw;
  out.textContent = "Slicing this project and converting " +
    "with GhostConvert…";
  try {
    const d = await postJson("/api/eco/convert", {
      target, mode,
      budget: sliceBudget() });
    const st = convertState(d);
    if (!st) {
      out.textContent = "Export failed: " +
        (d.error || "the tool could not run.");
      return;
    }
    renderCtxExport(st);
  } catch (e) {
    out.textContent = "Export failed to reach the server.";
  }
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
/* ---------------- Roadmap G36: language + access ------ */
/* ---------------- Roadmap ECO E1: ecosystem tools ----------
   The panel lists the Ghost ecosystem catalog with each tool's
   state. Runnable tools execute on the server (the tool itself,
   never a reimplementation) and their own report renders here. */
async function openEco() {
  hideTools();
  $("todoTitle").textContent = "Ecosystem tools";
  $("todoResults").textContent = "Loading the catalog…";
  $("todoPanel").classList.remove("hidden");
  let r;
  try { r = await (await fetch("/api/eco/tools")).json(); }
  catch (e) { $("todoResults").textContent = "Could not load the catalog."; return; }
  const tools = r.tools || [];
  $("todoResults").textContent = "";
  const ecoHead = document.createElement("div");
  ecoHead.className = "dim";
  ecoHead.textContent = tools.length + " tools in the catalog. " +
    "Ready tools run here against this workspace; the rest land " +
    "with their roadmap goals.";
  $("todoResults").appendChild(ecoHead);
  for (const t of tools) {
    const row = document.createElement("div");
    row.className = "todorow";
    const label = document.createElement("span");
    label.textContent = t.name + " — " + t.blurb;
    row.appendChild(label);
    const chip = document.createElement("span");
    chip.className = "symkind";
    chip.textContent = t.state === "ready" ? "ready" :
      t.state === "bundled" ? ("on-device" +
        (t.tests ? " · " + t.tests + " tests" : "")) :
      t.state === "native" ? "built in" :
      t.state === "absent" ? "not found" : t.goal;
    row.appendChild(chip);
    if (t.runnable) {
      const b = document.createElement("button");
      b.className = "ghostbtn";
      b.textContent = "Run";
      b.onclick = async () => {
        b.disabled = true; b.textContent = "Running…";
        try {
          const rr = await (await fetch("/api/eco/run", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: t.id }) })).json();
          $("todoResults").textContent = rr.error ||
            (t.name + " report:\n\n" + (rr.output || "(no output)"));
        } catch (e) { $("todoResults").textContent = "The run failed to reach the server."; }
        b.disabled = false; b.textContent = "Run";
      };
      row.appendChild(b);
    }
    $("todoResults").appendChild(row);
  }
}

/*@@I18N@@*/
/* The translatable chrome, keyed by element id. Stateful
   labels (the completion-ping toggle, plugin counts, the
   model pill) manage their own text and are not in here.
   Spanish covers the main surface in this pass; deeper
   panels join the same table as they are translated. */
const I18N = {
  brandTag: { en: "offline AI editor", es: "editor de IA sin conexión" },
  saveBtn: { en: "Save", es: "Guardar" },
  startModelBtn: { en: "Start model", es: "Iniciar modelo" },
  runBtn: { en: "▶ Run", es: "▶ Ejecutar" },
  splitBtn: { en: "◫ Split", es: "◫ Dividir" },
  filesHeadTxt: { en: "FILES", es: "ARCHIVOS" },
  gitHeadTxt: { en: "GIT", es: "GIT" },
  chatHeadTxt: { en: "GHOST CHAT", es: "CHAT DE GHOST" },
  toolsTitle: { en: "🧰 Tools", es: "🧰 Herramientas" },
  findTitle: { en: "Find in project", es: "Buscar en el proyecto" },
  newFileBtn: { en: "+ New", es: "+ Nuevo" },
  mentionBtn: { en: "@ File", es: "@ Archivo" },
  clearChatBtn: { en: "Clear chat", es: "Borrar chat" },
  regenBtn: { en: "↻ Regenerate", es: "↻ Regenerar" },
  copyLastBtn: { en: "⧉ Copy last answer", es: "⧉ Copiar última respuesta" },
  exportChatBtn: { en: "⬇ Export chat", es: "⬇ Exportar chat" },
  continueBtn: { en: "⏩ Continue", es: "⏩ Continuar" },
  primeBtn: { en: "🧭 Prime this project", es: "🧭 Preparar este proyecto" },
  handoffBtn: { en: "📦 Draft handoff", es: "📦 Borrador de traspaso" },
  recallBtn: { en: "📚 Recall memory", es: "📚 Recuperar memoria" },
  findGo: { en: "Find", es: "Buscar" },
  findSemantic: { en: "🧠 Meaning", es: "🧠 Significado" },
  findIndexed: { en: "🔎 Indexed", es: "🔎 Indexado" },
  findReplace: { en: "Replace all", es: "Reemplazar todo" },
  findClose: { en: "Close", es: "Cerrar" },
  settingsClose: { en: "Close", es: "Cerrar" },
  toolPreview: { en: "Preview", es: "Vista previa" },
  toolCheck: { en: "Check syntax", es: "Revisar sintaxis" },
  toolDup: { en: "Duplicate file", es: "Duplicar archivo" },
  toolSnippets: { en: "Snippets", es: "Fragmentos" },
  toolFindFile: { en: "Find in file", es: "Buscar en el archivo" },
  toolFold: { en: "Fold all", es: "Plegar todo" },
  toolUnfold: { en: "Unfold all", es: "Desplegar todo" },
  toolDef: { en: "Go to definition", es: "Ir a la definición" },
  toolRefs: { en: "Find all references", es: "Buscar referencias" },
  toolExtractFn: { en: "Extract function…", es: "Extraer función…" },
  toolExtractVar: { en: "Extract variable…", es: "Extraer variable…" },
  toolInline: { en: "Inline variable", es: "Incrustar variable" },
  toolRename: { en: "Rename symbol…", es: "Renombrar símbolo…" },
  toolSort: { en: "Sort lines", es: "Ordenar líneas" },
  toolDedupe: { en: "Remove duplicate lines", es: "Quitar líneas duplicadas" },
  toolTrim: { en: "Trim trailing spaces", es: "Quitar espacios finales" },
  toolCase: { en: "Toggle case (selection)", es: "Cambiar mayúsculas (selección)" },
  toolRegen: { en: "Regenerate answer", es: "Regenerar respuesta" },
  toolExportChat: { en: "Export chat as file", es: "Exportar chat como archivo" },
  toolQuick: { en: "Quick open (Ctrl+K)", es: "Apertura rápida (Ctrl+K)" },
  toolPalette: { en: "Command palette (Ctrl+Shift+P)", es: "Paleta de comandos (Ctrl+Shift+P)" },
  toolOutline: { en: "Outline", es: "Esquema" },
  toolSymbols: { en: "Go to symbol (Ctrl+Shift+O)", es: "Ir al símbolo (Ctrl+Shift+O)" },
  toolBookmarks: { en: "Bookmarks", es: "Marcadores" },
  toolGoto: { en: "Go to line", es: "Ir a la línea" },
  toolTodos: { en: "TODO / FIXME scan", es: "Escanear TODO / FIXME" },
  toolStats: { en: "Project stats", es: "Estadísticas del proyecto" },
  toolSlice: { en: "Save slice as file", es: "Guardar recorte como archivo" },
  toolHistory: { en: "Local history", es: "Historial local" },
  toolRepoMap: { en: "Repo map", es: "Mapa del repositorio" },
  toolTests: { en: "Test runner", es: "Ejecutar pruebas" },
  toolDebug: { en: "Debug this file", es: "Depurar este archivo" },
  toolFix: { en: "Fix my tests (AI)", es: "Reparar mis pruebas (IA)" },
  toolTemplates: { en: "New project from template", es: "Nuevo proyecto desde plantilla" },
  toolPair: { en: "Pair mode", es: "Modo en pareja" },
  toolBackup: { en: "Encrypted backup", es: "Copia de seguridad cifrada" },
  toolApi: { en: "API client", es: "Cliente API" },
  toolDocs: { en: "Export docs site", es: "Exportar sitio de documentación" },
  toolAssets: { en: "Asset browser", es: "Explorador de recursos" },
  toolContext: { en: "Context lab", es: "Laboratorio de contexto" },
  toolRefdocs: { en: "Reference docs", es: "Documentación de referencia" },
  toolErrorMem: { en: "Error memory", es: "Memoria de errores" },
  toolMacros: { en: "Macros", es: "Macros" },
  toolVerify: { en: "Verify pipeline", es: "Verificación completa" },
  toolBigscreen: { en: "Big-screen mode", es: "Modo pantalla grande" },
  toolKeys: { en: "Keyboard shortcuts", es: "Atajos de teclado" },
  toolStateExport: { en: "Export app state", es: "Exportar estado de la app" },
  toolStateImport: { en: "Import app state", es: "Importar estado de la app" },
  toolCheckAll: { en: "Check whole project", es: "Revisar todo el proyecto" },
  toolTerminal: { en: "Terminal", es: "Terminal" },
  toolRepl: { en: "Python REPL", es: "REPL de Python" },
  toolZip: { en: "Download workspace (.zip)", es: "Descargar proyecto (.zip)" },
  toolPluginsManage: { en: "Manage plugins…", es: "Gestionar plugins…" },
  toolRegistry: { en: "Registry", es: "Registro" },
  toolClassroom: { en: "Classroom view", es: "Vista de aula" },
  toolTour: { en: "Take the tour", es: "Hacer el recorrido" },
  toolChangelog: { en: "What's new", es: "Novedades" },
  chatOptsBtn: { en: "⚙ Chat options", es: "⚙ Opciones del chat" },
  handRun: { en: "▶ Run", es: "▶ Ejecutar" },
  handSave: { en: "Save", es: "Guardar" },
  handSend: { en: "Send", es: "Enviar" },
};
const I18N_PH = {
  chatText: { en: "Ask about your code… (Enter to send, Shift+Enter for newline)", es: "Pregunta sobre tu código… (Enter para enviar, Mayús+Enter para una línea nueva)" },
  quickInput: { en: "Open file by name… (Enter opens, Esc closes)", es: "Abrir archivo por nombre… (Enter abre, Esc cierra)" },
  findQuery: { en: "Search for…", es: "Buscar…" },
  findReplacement: { en: "Replace with… (for Replace all)", es: "Reemplazar con… (para Reemplazar todo)" },
};
try { window.__ghostI18n = { I18N, I18N_PH }; } catch (e) {}
/*@@I18N-END@@*/

function applyLang() {
  const lang = settings.lang === "es" ? "es" : "en";
  document.documentElement.lang = lang;
  for (const id of Object.keys(I18N)) {
    const el = document.getElementById(id);
    if (el) el.textContent = I18N[id][lang];
  }
  for (const id of Object.keys(I18N_PH)) {
    const el = document.getElementById(id);
    if (el) el.placeholder = I18N_PH[id][lang];
  }
}
function applyAccess() {
  document.body.classList.toggle("text-lg",
    settings.textSize === "large");
  document.body.classList.toggle("text-xl",
    settings.textSize === "xl");
  document.body.classList.toggle("onehand", !!settings.oneHand);
  $("handBar").classList.toggle("hidden", !settings.oneHand);
}
$("setLang").value = settings.lang;
$("setLang").onchange = (e) => {
  settings.lang = e.target.value;
  saveSettings();
  applyLang();
};
$("setTextSize").value = settings.textSize;
$("setTextSize").onchange = (e) => {
  settings.textSize = e.target.value;
  saveSettings();
  applyAccess();
};
$("setOneHand").checked = !!settings.oneHand;
$("setOneHand").onchange = (e) => {
  settings.oneHand = e.target.checked;
  saveSettings();
  applyAccess();
};
$("handRun").onclick = () => $("runBtn").click();
$("handSave").onclick = () => $("saveBtn").click();
$("handSend").onclick = () => $("chatSend").click();
$("handFind").onclick = () => $("findBtn").click();
$("handTools").onclick = () => $("toolsBtn").click();
applyLang();
applyAccess();

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
/* ---------------- Chat options + settings expansion ------
   Answer style / length live in BOTH the chat options fold
   and Settings; the two control pairs stay in sync through
   syncChatControls. The Short answers checkbox is the same
   choice as Answer length: Short, so this block replaces
   the Phase 6 setShort handler with the syncing one. */
function syncChatControls() {
  const style = settings.chatStyle || "balanced";
  const len = settings.chatLength ||
    (settings.shortAnswers ? "short" : "normal");
  $("chatStyle").value = style;
  $("setChatStyle").value = style;
  $("chatLength").value = len;
  $("setChatLen").value = len;
  $("setShort").checked = len === "short";
}
function setAnswerLength(len) {
  settings.chatLength = len;
  settings.shortAnswers = len === "short";
  saveSettings();
  syncChatControls();
}
$("chatStyle").onchange = (e) => {
  settings.chatStyle = e.target.value;
  saveSettings();
  syncChatControls();
};
$("setChatStyle").onchange = $("chatStyle").onchange;
$("chatLength").onchange = (e) =>
  setAnswerLength(e.target.value);
$("setChatLen").onchange = $("chatLength").onchange;
$("setShort").onchange = (e) =>
  setAnswerLength(e.target.checked ? "short" : "normal");
$("setCustomInstr").value = settings.customInstr || "";
$("setCustomInstr").onchange = (e) => {
  settings.customInstr = e.target.value.slice(0, 1000);
  saveSettings();
};
$("setHistTurns").value = String(settings.historyTurns || 0);
$("setHistTurns").onchange = (e) => {
  settings.historyTurns = parseInt(e.target.value, 10) || 0;
  saveSettings();
};
$("setSendKey").value = settings.sendKey || "enter";
$("setSendKey").onchange = (e) => {
  settings.sendKey = e.target.value;
  saveSettings();
};
$("setPing").checked = notifyEnabled();
$("setPing").onchange = (e) => {
  try { localStorage.setItem("ghostide-notify",
    e.target.checked ? "1" : "0"); } catch (err) {}
  if (e.target.checked && "Notification" in window &&
      Notification.permission === "default")
    Notification.requestPermission().catch(() => {});
  refreshNotifyBtn();
};
$("setTimestamps").checked = !!settings.timestamps;
$("setTimestamps").onchange = (e) => {
  settings.timestamps = e.target.checked;
  saveSettings();
};
function applyChatDisplay() {
  document.body.classList.toggle("chat-compact",
    !!settings.compactChat);
  document.body.classList.toggle("reduce-motion",
    !!settings.reduceMotion);
  const fam = { consolas: "Consolas, 'Courier New', monospace",
    courier: "'Courier New', Courier, monospace" }[
      settings.fontFamily];
  if (fam) document.documentElement.style.setProperty(
    "--ghost-font-family", fam);
  else document.documentElement.style.removeProperty(
    "--ghost-font-family");
}
$("setFontFamily").value = settings.fontFamily || "default";
$("setFontFamily").onchange = (e) => {
  settings.fontFamily = e.target.value;
  saveSettings();
  applyChatDisplay();
};
$("setCompactChat").checked = !!settings.compactChat;
$("setCompactChat").onchange = (e) => {
  settings.compactChat = e.target.checked;
  saveSettings();
  applyChatDisplay();
};
$("setReduceMotion").checked = !!settings.reduceMotion;
$("setReduceMotion").onchange = (e) => {
  settings.reduceMotion = e.target.checked;
  saveSettings();
  applyChatDisplay();
};
applyChatDisplay();
syncChatControls();

/* Quick prompt chips: fill the chat box (never auto-send),
   so the prompt can be edited before it goes. */
for (const p of QUICK_PROMPTS) {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = p.label;
  b.title = "Fill the chat box with this prompt";
  b.onclick = () => {
    $("chatText").value = quickPromptText(p.id, currentFile);
    $("chatText").focus();
  };
  $("chatChips").appendChild(b);
}
$("regenBtn").onclick = () => $("toolRegen").click();
$("exportChatBtn").onclick = () => exportChatAs($("exportFmt").value);
$("copyLastBtn").onclick = async () => {
  let last = "";
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      last = history[i].content; break;
    }
  }
  if (!last) { alert("No answer to copy yet."); return; }
  try {
    await navigator.clipboard.writeText(last);
    $("copyLastBtn").textContent = "✓ Copied";
    setTimeout(() => {
      $("copyLastBtn").textContent = "⧉ Copy last answer";
    }, 1500);
  } catch (e) {
    alert("Copy is not available here - the answer is " +
      "in the chat log above.");
  }
};



/* ---------------- Chat composer pack (v1.58) ------ */
function draftStorageKey() {
  return historyScope
    ? chatDraftKey(historyScope) + ":" + activeSession
    : null;
}
function saveChatDraft() {
  const k = draftStorageKey();
  if (!k) return;
  try {
    const v = $("chatText").value;
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch (e) {}
}
function clearChatDraft() {
  const k = draftStorageKey();
  if (k) { try { localStorage.removeItem(k); } catch (e) {} }
}
function growChatText() {
  const ta = $("chatText");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
}
function updateChatCount() {
  $("chatCount").textContent =
    counterText($("chatText").value);
}
function restoreChatDraft() {
  const k = draftStorageKey();
  if (!k) return;
  try {
    const v = localStorage.getItem(k);
    if (v && !$("chatText").value) {
      $("chatText").value = v;
      growChatText();
      updateChatCount();
    }
  } catch (e) {}
}
$("chatText").addEventListener("input", () => {
  growChatText();
  updateChatCount();
  saveChatDraft();
});
updateChatCount();
$("continueBtn").onclick = () => {
  if (chatAbort) return;
  if (!history.length) {
    alert("Nothing to continue yet - ask something first.");
    return;
  }
  $("chatText").value = CONTINUE_TEXT;
  sendChat();
};


/* ---------------- Chat sessions (v1.59) ------------ */
let chatSessions = [{ id: "s1", name: "Chat 1" }];
let activeSession = "s1";
function sessionsKey() {
  return "ghostide-sessions:" + historyScope;
}
function activeSessionKey() {
  return "ghostide-activesession:" + historyScope;
}
function persistSessions() {
  if (!historyScope) return;
  try {
    localStorage.setItem(sessionsKey(),
      JSON.stringify(chatSessions));
    localStorage.setItem(activeSessionKey(), activeSession);
  } catch (e) {}
}
function renderSessionSel() {
  const sel = $("sessionSel");
  sel.innerHTML = "";
  for (const s of chatSessions) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = (loadStars().includes(s.id) ? "\u2605 " : "") +
      sessionOptionLabel(s, storedHistLen(s.id));
    sel.appendChild(o);
  }
  sel.value = activeSession;
}
function loadSessions() {
  chatSessions = [{ id: "s1", name: "Chat 1" }];
  activeSession = "s1";
  if (historyScope) {
    try {
      chatSessions = normalizeSessions(JSON.parse(
        localStorage.getItem(sessionsKey()) || "[]"));
      const saved = localStorage.getItem(activeSessionKey());
      if (saved && chatSessions.some((s) => s.id === saved))
        activeSession = saved;
    } catch (e) {}
  }
  renderSessionSel();
}
function switchSession(id) {
  if (id === activeSession) { renderSessionSel(); return; }
  saveHistory();
  activeSession = id;
  primerContext = null;
  recallContext = null;
  recallTaskLabel = "";
  persistSessions();
  renderSessionSel();
  loadHistory();
}
$("sessionSel").onchange = (e) => switchSession(e.target.value);
$("sessionNew").onclick = () => {
  const id = "s" + Date.now().toString(36);
  chatSessions.push({ id, name: nextSessionName(chatSessions) });
  persistSessions();
  switchSession(id);
};
$("sessionRename").onclick = () => {
  const cur = chatSessions.find((s) => s.id === activeSession);
  if (!cur) return;
  const name = prompt("Rename this chat", cur.name);
  if (name === null) return;
  const clean = name.trim().slice(0, 40);
  if (clean) { cur.name = clean; persistSessions(); }
  renderSessionSel();
};
$("sessionDel").onclick = () => {
  const cur = chatSessions.find((s) => s.id === activeSession);
  if (!cur) return;
  const r = removeSession(chatSessions, cur.id);
  if (!r.removed) {
    alert("This is the only chat for this project.");
    return;
  }
  if (!confirm("Delete the chat \"" + cur.name + "\"?")) return;
  try {
    localStorage.removeItem(
      sessionHistoryKey(historyScope, cur.id));
  } catch (e) {}
  chatSessions = r.list;
  activeSession = chatSessions[0].id;
  persistSessions();
  renderSessionSel();
  loadHistory();
};


/* ---------------- Prompt library (v1.60) ---------- */
let promptLib = [];
try {
  promptLib = normalizePrompts(JSON.parse(
    localStorage.getItem("ghostide-prompts") || "[]"));
} catch (e) { promptLib = []; }
function persistPrompts() {
  try {
    localStorage.setItem("ghostide-prompts",
      JSON.stringify(promptLib));
  } catch (e) {}
}
function renderPromptSel() {
  const sel = $("promptSel");
  sel.innerHTML = "";
  const head = document.createElement("option");
  head.value = "";
  head.textContent = promptLib.length
    ? "Saved prompts…" : "No saved prompts yet";
  sel.appendChild(head);
  for (const p of promptLib) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.name;
    sel.appendChild(o);
  }
}
renderPromptSel();
$("promptSave").onclick = () => {
  const text = $("chatText").value.trim();
  if (!text) {
    alert("Type the prompt in the chat box first.");
    return;
  }
  const name = prompt("Name this prompt",
    text.slice(0, 30));
  if (name === null) return;
  promptLib = upsertPrompt(promptLib, name, text);
  persistPrompts();
  renderPromptSel();
  $("promptSel").value = name.trim().slice(0, 40);
};
$("promptInsert").onclick = () => {
  const p = promptByName(promptLib, $("promptSel").value);
  if (!p) { alert("Pick a saved prompt first."); return; }
  $("chatText").value = p.text;
  growChatText();
  updateChatCount();
  saveChatDraft();
  $("chatText").focus();
};
$("promptDel").onclick = () => {
  const name = $("promptSel").value;
  if (!name) { alert("Pick a saved prompt first."); return; }
  if (!confirm("Delete the prompt \"" + name + "\"?")) return;
  promptLib = removePrompt(promptLib, name);
  persistPrompts();
  renderPromptSel();
};


/* ---------------- Sampling controls (v1.61) ------- */
function syncTempControls() {
  $("setTemp").value = settings.temperature;
  $("setTempVal").textContent = settings.temperature;
  $("chatTemp").value = settings.temperature;
  $("chatTempVal").textContent = settings.temperature;
}
function setTemperature(v) {
  settings.temperature = v;
  saveSettings();
  syncTempControls();
}
/* Replaces the Phase 1.6 setTemp handler so the chat
   slider and the Settings slider never drift apart. */
$("setTemp").oninput = () =>
  setTemperature(parseFloat($("setTemp").value));
$("chatTemp").oninput = () =>
  setTemperature(parseFloat($("chatTemp").value));
$("tempPrecise").onclick = () =>
  setTemperature(TEMP_PRESETS.precise);
$("tempBalanced").onclick = () =>
  setTemperature(TEMP_PRESETS.balanced);
$("tempCreative").onclick = () =>
  setTemperature(TEMP_PRESETS.creative);
$("setCustomTokens").value = settings.customTokens || 1024;
$("setCustomTokens").onchange = (e) => {
  const n = parseInt(e.target.value, 10);
  if (n >= 128 && n <= 2048) {
    settings.customTokens = n;
    saveSettings();
  }
};
syncTempControls();


/* ---------------- Editor reading pack (v1.62) ------ */
function applyEditorReading() {
  const st = readingState(settings);
  document.documentElement.style.setProperty(
    "--ghost-line-height", st.lineHeight);
  for (const cl of ["lig-off", "linenums-off",
                    "activeline-off"])
    document.body.classList.toggle(cl, st.classes.includes(cl));
}
$("setLineHeight").value = settings.lineHeight || "1.45";
$("setLineHeight").onchange = (e) => {
  settings.lineHeight = e.target.value;
  saveSettings();
  applyEditorReading();
};
$("setLigatures").checked = settings.ligatures !== false;
$("setLigatures").onchange = (e) => {
  settings.ligatures = e.target.checked;
  saveSettings();
  applyEditorReading();
};
$("setLineNumbers").checked = settings.lineNumbers !== false;
$("setLineNumbers").onchange = (e) => {
  settings.lineNumbers = e.target.checked;
  saveSettings();
  applyEditorReading();
};
$("setActiveLine").checked = settings.activeLine !== false;
$("setActiveLine").onchange = (e) => {
  settings.activeLine = e.target.checked;
  saveSettings();
  applyEditorReading();
};
applyEditorReading();


/* ---------------- Chat export pack (v1.63) --------- */
function updateChatStats() {
  const el = $("chatStats");
  if (el) el.textContent = chatStatsText(history);
}
async function exportChatAs(format) {
  hideTools();
  if (!history.length) {
    alert("No chat to export yet.");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19)
    .replace(/[:T]/g, "-");
  const build = { md: chatToMarkdown, txt: chatToText,
    html: chatToHtml }[format] || chatToMarkdown;
  const ext = { md: "md", txt: "txt",
    html: "html" }[format] || "md";
  const name = "chat-export-" + stamp + "." + ext;
  const d = await postJson("/api/file",
    { path: name, content: build(history) });
  if (d.error) { alert(d.error); return; }
  await loadFiles();
  alert("Chat saved to " + name + " in the workspace.");
}
$("copyWholeBtn").onclick = async () => {
  if (!history.length) {
    alert("No chat to copy yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(
      chatToText(history));
    $("copyWholeBtn").textContent = "✓ Copied";
    setTimeout(() => {
      $("copyWholeBtn").textContent = "⧉ Whole chat";
    }, 1500);
  } catch (e) {
    alert("Copy is not available here.");
  }
};
updateChatStats();


/* ---------------- Slash commands (v1.64) ----------- */
function runSlash(s) {
  if (s.kind === "ai") { aiAction(s.cmd, s.arg); return; }
  if (s.cmd === "clear") { $("clearChatBtn").click(); return; }
  if (s.cmd === "export") {
    exportChatAs($("exportFmt").value);
    return;
  }
  if (s.cmd === "regen") { $("toolRegen").click(); return; }
  if (s.cmd === "rename") {
    const name = String(s.arg || "").trim().slice(0, 60);
    const cur = chatSessions.find(
      (x) => x.id === activeSession);
    if (name && cur) {
      cur.name = name;
      persistSessions();
      renderSessionSel();
      addMsg("SYSTEM", "Chat renamed to " + name + ".");
    }
    return;
  }
  if (s.cmd === "star") { $("sessionStar").click(); return; }
  if (s.cmd === "scratch") { $("toolScratch").click(); return; }
  if (s.cmd === "backup") { $("toolBackup").click(); return; }
  if (s.cmd === "sees") { $("sysPreviewBtn").click(); return; }
  if (s.cmd === "help") {
    addMsg("SYSTEM", slashHelpText());
    return;
  }
}


/* ---------------- Chat display pack (v1.65) -------- */
function applyChatLook() {
  const st = displayState(settings);
  document.documentElement.style.setProperty(
    "--ghost-chat-fs", st.chatFs + "px");
  document.documentElement.style.setProperty(
    "--ghost-chat-w", st.chatW + "px");
  for (const cl of ["chat-bubbles", "no-roles"])
    document.body.classList.toggle(cl, st.classes.includes(cl));
}
$("setChatFs").value = String(settings.chatFs || "13");
$("setChatFs").onchange = (e) => {
  settings.chatFs = e.target.value;
  saveSettings();
  applyChatLook();
};
$("setChatWidth").value = String(settings.chatWidth || "360");
$("setChatWidth").onchange = (e) => {
  settings.chatWidth = e.target.value;
  saveSettings();
  applyChatLook();
};
$("setBubbles").checked = settings.bubbles === true;
$("setBubbles").onchange = (e) => {
  settings.bubbles = e.target.checked;
  saveSettings();
  applyChatLook();
};
$("setRoleLabels").checked = settings.roleLabels !== false;
$("setRoleLabels").onchange = (e) => {
  settings.roleLabels = e.target.checked;
  saveSettings();
  applyChatLook();
};
applyChatLook();


/* ---------------- Context control pack (v1.66) ---- */
$("setSliceBudget").value =
  String(clampSliceBudget(settings.sliceBudget));
$("setSliceBudget").onchange = (e) => {
  settings.sliceBudget = parseInt(e.target.value, 10);
  saveSettings();
};
$("setAttachSelection").checked =
  settings.attachSelection !== false;
$("setAttachSelection").onchange = (e) => {
  settings.attachSelection = e.target.checked;
  saveSettings();
};
$("setAttachDiff").checked = settings.attachDiff === true;
$("setAttachDiff").onchange = (e) => {
  settings.attachDiff = e.target.checked;
  saveSettings();
};


/* ---------------- Settings utilities (v1.67) ------- */
let setFirstHit = null;
function filterSettings() {
  setFirstHit = null;
  const q = $("setSearch").value.trim().toLowerCase();
  const rows = $("settingsPanel")
    .querySelectorAll("h4, label, .optRow");
  let h4 = null;
  let anyVisible = false;
  const flush = () => {
    if (h4) h4.style.display =
      (!q || anyVisible) ? "" : "none";
  };
  for (const el of rows) {
    if (el.tagName === "H4") {
      flush();
      h4 = el;
      anyVisible = false;
      continue;
    }
    const show = rowMatches(el.textContent, q);
    el.style.display = show ? "" : "none";
    el.classList.toggle("setHit", !!q && show);
    if (show) {
      anyVisible = true;
      if (q && !setFirstHit) setFirstHit = el;
    }
  }
  flush();
}
$("setSearch").addEventListener("input", filterSettings);
$("setSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && setFirstHit) {
    e.preventDefault();
    setFirstHit.scrollIntoView({ block: "center" });
  }
});
$("setResetBtn").onclick = () => {
  if (!confirm("Reset ALL settings to defaults? " +
      "Chats and files are not touched.")) return;
  try {
    localStorage.removeItem("ghostide-settings");
    localStorage.removeItem("ghostide-notify");
  } catch (e) {}
  location.reload();
};
$("setExportBtn").onclick = () => {
  const blob = new Blob(
    [JSON.stringify(settings, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ghostide-settings.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$("setImportBtn").onclick = () => $("setImportFile").click();
$("setImportFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    const clean = sanitizeImportedSettings(obj, settings);
    if (!clean) {
      alert("That file has no recognizable settings.");
      return;
    }
    Object.assign(settings, clean);
    saveSettings();
    alert("Settings imported. Reloading to apply them.");
    location.reload();
  } catch (err) {
    alert("Could not read that settings file.");
  }
  e.target.value = "";
};


/* ---------------- Message tools (v1.68) ------------ */
function attachEditBtn(wrap, idx) {
  if (!wrap) return;
  const b = document.createElement("button");
  b.className = "msgCopy";
  b.textContent = "✎ Edit & resend";
  b.onclick = () => editUserTurn(idx);
  wrap.appendChild(b);
}
function editUserTurn(idx) {
  const t = trimForEdit(history, idx);
  if (!t) return;
  if (!confirm("Edit this message? Everything after it " +
      "in this chat will be removed.")) return;
  history.length = 0;
  for (const m of t.kept) history.push(m);
  saveHistory();
  loadHistory();
  $("chatText").value = t.text;
  growChatText();
  updateChatCount();
  saveChatDraft();
  $("chatText").focus();
}


/* ---------------- Find in chat (v1.69) ------------- */
function applyChatFind() {
  const q = $("chatFind").value.trim().toLowerCase();
  const msgs = $("chatLog").querySelectorAll(".msg");
  let shown = 0;
  msgs.forEach((el) => {
    const hit = msgMatches(el.textContent, q);
    el.style.display = hit ? "" : "none";
    if (hit && q) shown++;
  });
  $("chatFindCount").textContent = q
    ? shown + " of " + msgs.length + " messages match"
    : "";
}
$("chatFind").addEventListener("input", applyChatFind);


/* ---------------- Shortcuts pack (v1.70) ----------- */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const inEditor = e.target && e.target.closest &&
    e.target.closest(".cm-editor");
  if (e.key === ".") {
    e.preventDefault();
    $("chatText").focus();
    return;
  }
  if (inEditor) return;
  if (e.key === "/") {
    e.preventDefault();
    $("chatOptsBtn").click();
  } else if (e.key.toLowerCase() === "l" && !e.shiftKey) {
    e.preventDefault();
    $("clearChatBtn").click();
  } else if (e.shiftKey && e.key === "ArrowDown") {
    e.preventDefault();
    switchSession(stepSession(chatSessions, activeSession, 1));
  } else if (e.shiftKey && e.key === "ArrowUp") {
    e.preventDefault();
    switchSession(stepSession(chatSessions, activeSession, -1));
  }
});
$("shortcutBtn").onclick = () =>
  addMsg("SYSTEM", shortcutHelpText());


/* ---------------- Help pack (v1.73) ---------------- */
$("toolHelp").onclick = () => {
  hideTools();
  addMsg("SYSTEM", buildHelpText());
};


/* ---------------- Accent color (v1.74) ------------- */
function applyAccent() {
  const p = accentPair(settings.accent);
  document.documentElement.style
    .setProperty("--ghost-accent", p.base);
  document.documentElement.style
    .setProperty("--ghost-accent-hi", p.hi);
}
$("setAccent").value = settings.accent;
$("setAccent").onchange = (e) => {
  settings.accent = e.target.value;
  saveSettings();
  applyAccent();
};
applyAccent();


/* ---------------- Notify sounds (v1.75) ------------ */
let actx = null;
function playNotifySound() {
  const spec = beepSpec(settings.notifySound);
  if (!spec.length) return;
  try {
    const AC = window.AudioContext ||
      window.webkitAudioContext;
    if (!AC) return;
    actx = actx || new AC();
    if (actx.state === "suspended") actx.resume();
    const t0 = actx.currentTime;
    for (const b of spec) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "sine";
      o.frequency.value = b.f;
      g.gain.setValueAtTime(0.0001, t0 + b.at);
      g.gain.exponentialRampToValueAtTime(0.18,
        t0 + b.at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,
        t0 + b.at + b.d);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t0 + b.at);
      o.stop(t0 + b.at + b.d + 0.05);
    }
  } catch (e) {}
}
$("setSound").value = settings.notifySound;
$("setSound").onchange = (e) => {
  settings.notifySound = e.target.value;
  saveSettings();
  playNotifySound();
};
$("setSoundTest").onclick = () => playNotifySound();


/* ---------------- Data backup (v1.76) -------------- */
function collectLocalMap() {
  const map = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      map[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  return map;
}
$("setExportData").onclick = () => {
  download("ghostide-backup.json",
    JSON.stringify(buildBackup(collectLocalMap()), null, 1),
    "application/json");
};
$("setImportData").onclick = () => pickTextFile((text) => {
  const data = parseBackup(text);
  if (!data) {
    alert("That file is not a valid GhostIDE backup.");
    return;
  }
  if (!confirm("Import this backup? It replaces the " +
      "matching local data (settings, prompts, chats, " +
      "drafts) and reloads the app.")) return;
  for (const k of Object.keys(data)) {
    try { localStorage.setItem(k, data[k]); } catch (e) {}
  }
  location.reload();
});


/* ---------------- Auto-scroll (v1.77) -------------- */
$("setAutoScroll").checked = settings.autoScroll !== false;
$("setAutoScroll").onchange = (e) => {
  settings.autoScroll = e.target.checked;
  saveSettings();
};


/* ---------------- Input history (v1.78) ------------ */
let sentList = [];
try {
  sentList = JSON.parse(
    localStorage.getItem("ghostide-sent") || "[]");
  if (!Array.isArray(sentList)) sentList = [];
} catch (e) { sentList = []; }
let sentIdx = -1;
let sentDraft = "";
function recordSent(text) {
  sentList = pushSent(sentList, text);
  sentIdx = -1;
  try {
    localStorage.setItem("ghostide-sent",
      JSON.stringify(sentList));
  } catch (e) {}
}
$("chatText").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const ta = $("chatText");
  const before = ta.value.slice(0, ta.selectionStart);
  const after = ta.value.slice(ta.selectionEnd);
  if (e.key === "ArrowUp" && before.includes("\n")) return;
  if (e.key === "ArrowDown" && after.includes("\n")) return;
  const step = navSent(sentList, sentIdx,
    e.key === "ArrowUp" ? -1 : 1);
  if (step.idx === sentIdx && step.text === null) return;
  e.preventDefault();
  if (sentIdx === -1 && step.idx !== -1)
    sentDraft = ta.value;
  sentIdx = step.idx;
  ta.value = step.idx === -1 ? sentDraft : step.text;
  growChatText();
  updateChatCount();
  ta.setSelectionRange(ta.value.length, ta.value.length);
});


/* ---------------- Sessions pack 2 (v1.80) ---------- */
function storedHistLen(sid) {
  try {
    const items = JSON.parse(localStorage.getItem(
      sessionHistoryKey(historyScope, sid)) || "[]");
    return Array.isArray(items) ? items.length : 0;
  } catch (e) { return 0; }
}
$("sessionDup").onclick = () => {
  const plan = planDuplicate(chatSessions, activeSession,
    "s" + Date.now().toString(36));
  if (!plan) return;
  saveHistory();
  try {
    const raw = localStorage.getItem(
      sessionHistoryKey(historyScope, activeSession));
    if (raw) localStorage.setItem(
      sessionHistoryKey(historyScope, plan.copy.id), raw);
  } catch (e) {}
  chatSessions = plan.list;
  persistSessions();
  switchSession(plan.copy.id);
  addMsg("SYSTEM", "Duplicated this chat as \"" +
    plan.copy.name + "\".");
};


/* ---------------- Settings profiles (v1.81) -------- */
function loadProfiles() {
  try {
    const o = JSON.parse(
      localStorage.getItem("ghostide-profiles") || "{}");
    return o && typeof o === "object" &&
      !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}
function saveProfiles(all) {
  try {
    localStorage.setItem("ghostide-profiles",
      JSON.stringify(all));
  } catch (e) {}
}
function renderProfSel() {
  const sel = $("profSel");
  sel.innerHTML = "";
  for (const n of profileNames(loadProfiles())) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
}
$("profSave").onclick = () => {
  const name = (prompt("Profile name:", "My setup") || "")
    .trim().slice(0, 40);
  if (!name) return;
  const all = loadProfiles();
  all[name] = JSON.parse(JSON.stringify(settings));
  saveProfiles(all);
  renderProfSel();
  $("profSel").value = name;
};
$("profApply").onclick = () => {
  const name = $("profSel").value;
  const all = loadProfiles();
  if (!name || !all[name]) {
    alert("Pick a profile first.");
    return;
  }
  Object.assign(settings, applyProfile(settings, all[name]));
  saveSettings();
  location.reload();
};
$("profDelete").onclick = () => {
  const name = $("profSel").value;
  const all = loadProfiles();
  if (!name || !all[name]) return;
  if (!confirm("Delete profile \"" + name + "\"?")) return;
  delete all[name];
  saveProfiles(all);
  renderProfSel();
};
renderProfSel();


/* ---------------- Pinned files (v1.82) ------------ */
let pinnedFiles = [];
function loadPinned() {
  pinnedFiles = [];
  try {
    const a = JSON.parse(localStorage.getItem(
      pinKey(historyScope)) || "[]");
    if (Array.isArray(a))
      pinnedFiles = a.filter((p) =>
        typeof p === "string").slice(-PIN_CAP);
  } catch (e) {}
  renderPinChips();
}
function savePinned() {
  try {
    localStorage.setItem(pinKey(historyScope),
      JSON.stringify(pinnedFiles));
  } catch (e) {}
  renderPinChips();
}
function renderPinChips() {
  const box = $("pinChips");
  if (!box) return;
  box.innerHTML = "";
  for (const p of pinnedFiles) {
    const c = document.createElement("button");
    c.textContent = "📌 " + p + " ×";
    c.title = "Unpin " + p;
    c.onclick = () => {
      pinnedFiles = togglePin(pinnedFiles, p);
      savePinned();
    };
    box.appendChild(c);
  }
}
$("pinFileBtn").onclick = () => {
  if (!currentFile) {
    alert("Open a file first, then pin it.");
    return;
  }
  pinnedFiles = togglePin(pinnedFiles, currentFile);
  savePinned();
};


/* ---------------- Scratchpad (v1.83) --------------- */
$("toolScratch").onclick = () => {
  hideTools();
  try {
    $("scratchText").value =
      localStorage.getItem("ghostide-scratch") || "";
  } catch (e) {}
  $("scratchPanel").classList.remove("hidden");
  $("scratchText").focus();
};
$("scratchClose").onclick = () =>
  $("scratchPanel").classList.add("hidden");
$("scratchText").addEventListener("input", (e) => {
  try {
    localStorage.setItem("ghostide-scratch", e.target.value);
  } catch (err) {}
});
$("scratchToChat").onclick = () => {
  const t = trimScratch($("scratchText").value);
  if (!t) { alert("The scratchpad is empty."); return; }
  $("chatText").value = t;
  growChatText();
  updateChatCount();
  saveChatDraft();
  $("scratchPanel").classList.add("hidden");
  $("chatText").focus();
};
$("scratchSave").onclick = async () => {
  const t = trimScratch($("scratchText").value);
  if (!t) { alert("The scratchpad is empty."); return; }
  const d = await postJson("/api/file",
    { path: "scratchpad.md", content: t });
  if (d.error) { alert(d.error); return; }
  await loadFiles();
  addMsg("SYSTEM", "Scratchpad saved as scratchpad.md.");
};


/* ---------------- Appearance pack 2 (v1.84) -------- */
function applyAppear2() {
  document.body.classList.toggle("density-compact",
    !!settings.density);
  const stack = chatFontStack(settings.chatFont);
  if (stack)
    document.documentElement.style
      .setProperty("--ghost-chat-font", stack);
  else
    document.documentElement.style
      .removeProperty("--ghost-chat-font");
}
$("setDensity").checked = !!settings.density;
$("setDensity").onchange = (e) => {
  settings.density = e.target.checked;
  saveSettings();
  applyAppear2();
};
$("setChatFont").value = settings.chatFont;
$("setChatFont").onchange = (e) => {
  settings.chatFont = e.target.value;
  saveSettings();
  applyAppear2();
};
applyAppear2();


/* ---------------- Last run (v1.85) ----------------- */
try {
  const lr = localStorage.getItem("ghostide-lastrun");
  if (lr) $("lastRun").textContent = lr;
} catch (e) {}


/* ---------------- Export pack 2 (v1.86) ------------ */
$("toolExportAll").onclick = () => {
  hideTools();
  saveHistory();
  const parts = [];
  for (const s of chatSessions) {
    let items = [];
    try {
      items = JSON.parse(localStorage.getItem(
        sessionHistoryKey(historyScope, s.id)) || "[]");
    } catch (e) {}
    if (Array.isArray(items) && items.length)
      parts.push(titledMarkdown(chatToMarkdown(items),
        s.name));
  }
  const out = allChatsExport(parts);
  if (!out) {
    alert("No chats with messages in this project yet.");
    return;
  }
  download("ghostide-all-chats.md", out, "text/markdown");
};
$("promptExport").onclick = () => {
  const list = promptLib;
  if (!list.length) {
    alert("No saved prompts yet.");
    return;
  }
  download("ghostide-prompts.json",
    JSON.stringify(list, null, 1), "application/json");
};


/* ---------------- What's new (v1.87) --------------- */
async function checkWhatsNew() {
  try {
    const r = await fetch("changelog.json");
    const d = await r.json();
    const entries = d.entries || [];
    if (!entries.length) return;
    const seen = localStorage.getItem(
      "ghostide-seen-version");
    const fresh = whatsNew(entries, seen);
    localStorage.setItem("ghostide-seen-version",
      entries[0].version);
    if (fresh) addMsg("SYSTEM", whatsNewText(fresh));
  } catch (e) {}
}
setTimeout(checkWhatsNew, 1200);


/* ---------------- File header actions (v1.88) ----- */
$("copyPathBtn").onclick = async () => {
  if (!currentFile) {
    alert("No file is open.");
    return;
  }
  try {
    await navigator.clipboard.writeText(currentFile);
    $("copyPathBtn").textContent = "✓ Path";
    setTimeout(() => {
      $("copyPathBtn").textContent = "⧉ Path";
    }, 1200);
  } catch (e) {}
};
$("copyFileBtn").onclick = async () => {
  if (!currentFile) {
    alert("No file is open.");
    return;
  }
  try {
    await navigator.clipboard.writeText(
      view.state.doc.toString());
    $("copyFileBtn").textContent = "✓ File";
    setTimeout(() => {
      $("copyFileBtn").textContent = "⧉ File";
    }, 1200);
  } catch (e) {}
};


/* ---------------- Line operations (v1.89) ---------- */
function applyLineOp(op) {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const line = doc.lineAt(head);
  const idx = line.number - 1;
  const col = head - line.from;
  const lines = [];
  for (let i = 1; i <= doc.lines; i++)
    lines.push(doc.line(i).text);
  const plan = planLineOp(lines, idx, op);
  if (!plan) return;
  let anchor = 0;
  for (let i = 0; i < plan.idx; i++)
    anchor += plan.lines[i].length + 1;
  anchor += Math.min(col, plan.lines[plan.idx].length);
  view.dispatch({
    changes: { from: 0, to: doc.length,
      insert: plan.lines.join("\n") },
    selection: { anchor },
  });
  view.focus();
}
$("lineDup").onclick = () => applyLineOp("dup");
$("lineUp").onclick = () => applyLineOp("up");
$("lineDown").onclick = () => applyLineOp("down");
$("lineDel").onclick = () => applyLineOp("del");
document.addEventListener("keydown", (e) => {
  if (!e.altKey) return;
  const inEditor = e.target && e.target.closest &&
    e.target.closest(".cm-editor");
  if (!inEditor) return;
  if (e.key === "ArrowUp") {
    e.preventDefault();
    applyLineOp("up");
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    applyLineOp("down");
  } else if (e.key.toLowerCase() === "d") {
    e.preventDefault();
    applyLineOp("dup");
  }
});


/* ---------------- Auto-name (v1.90) ---------------- */
function maybeAutoName(text) {
  const s = chatSessions.find(
    (x) => x.id === activeSession);
  if (!s || !isDefaultChatName(s.name)) return;
  const users = history.filter(
    (m) => m.role === "user").length;
  if (users !== 1) return;
  const name = autoChatName(text);
  if (!name) return;
  s.name = name;
  persistSessions();
  renderSessionSel();
}


/* ---------------- Starred sessions (v1.91) --------- */
function starredKey() {
  return "ghostide-starred:" + historyScope;
}
function loadStars() {
  try {
    return parseStars(localStorage.getItem(starredKey()));
  } catch (e) { return []; }
}
function persistStars(list) {
  try {
    localStorage.setItem(starredKey(),
      JSON.stringify(list));
  } catch (e) {}
}
function sortSessionsByStars() {
  const stars = loadStars();
  chatSessions.sort((a, b) =>
    (stars.includes(b.id) ? 1 : 0) -
    (stars.includes(a.id) ? 1 : 0));
}
$("sessionStar").onclick = () => {
  persistStars(toggleStar(loadStars(), activeSession));
  sortSessionsByStars();
  persistSessions();
  renderSessionSel();
};


/* ---------------- What-Ghost-sees (v1.92) ---------- */
$("sysPreviewBtn").onclick = () => {
  addMsg("SYSTEM", "What Ghost sees:\n" + systemPreview({
    style: settings.chatStyle,
    persona: personaSuffix(settings.chatStyle),
    custom: (settings.customInstructions || "").trim(),
    temp: settings.temperature,
    maxTok: answerMaxTokens(settings.chatLength,
      settings.shortAnswers, BEHAVIOR.chat.maxTokens,
      settings.customTokens),
    budget: sliceBudget(),
    window: settings.historyWindow,
  }));
};


/* ---------------- Starred answers (v1.93) ---------- */
function loadStarAnswers() {
  try {
    return parseStarAnswers(localStorage.getItem(
      "ghostide-starred-answers"));
  } catch (e) { return []; }
}
function persistStarAnswers(list) {
  try {
    localStorage.setItem("ghostide-starred-answers",
      JSON.stringify(list));
  } catch (e) {}
}
$("toolStarred").onclick = () => {
  hideTools();
  const list = loadStarAnswers();
  if (!list.length) {
    addMsg("SYSTEM", "No starred answers yet. " +
      "Star one from its message buttons.");
    return;
  }
  const recent = list.slice(-10).reverse();
  addMsg("SYSTEM", "Starred answers (" + list.length +
    ", showing " + recent.length + "):\n\n" +
    recent.map((x) => x.text).join("\n\n---\n\n"));
};


/* ---------------- Retry last send (v1.95) ---------- */
$("retryBtn").onclick = () => {
  const text = retryText(history);
  if (!text) {
    alert("Nothing to retry: the last message " +
      "already has its answer.");
    return;
  }
  history.pop();
  saveHistory();
  $("chatText").value = text;
  sendChat();
};


/* ---------------- Tabs pack (v1.96) ---------------- */
$("tabCloseOthers").onclick = () => {
  if (!currentFile) return;
  for (const p of othersOf(tabOrder.slice(), currentFile))
    closeTab(p);
  renderTabs();
};
$("tabCloseAll").onclick = () => {
  for (const p of tabOrder.slice()) closeTab(p);
  renderTabs();
};


/* ---------------- App info (v1.97) ----------------- */
async function refreshAppInfo() {
  let version = "?";
  try {
    const r = await fetch("changelog.json");
    const d = await r.json();
    if (d.entries && d.entries.length)
      version = d.entries[0].version;
  } catch (e) {}
  const el = $("appInfo");
  if (el) el.textContent = appInfoText({
    version,
    chats: chatSessions.length,
    prompts: promptLib.length,
    profiles: Object.keys(loadProfiles()).length,
    starred: loadStarAnswers().length,
    eco: "25 packages / 2,642 tests",
  });
}
setTimeout(refreshAppInfo, 900);


/* ---------------- Chat wrap (v1.98) ---------------- */
function applyWrapChat() {
  document.body.classList.toggle("chat-wrap",
    !!settings.wrapChat);
}
$("setWrapChat").checked = !!settings.wrapChat;
$("setWrapChat").onchange = (e) => {
  settings.wrapChat = e.target.checked;
  saveSettings();
  applyWrapChat();
};
applyWrapChat();


/* ---------------- Chat size quick-step (v1.99) ----- */
function bumpChatFs(dir) {
  settings.chatFs = stepFs(settings.chatFs, dir);
  $("setChatFs").value = String(settings.chatFs);
  saveSettings();
  applyChatLook();
}
$("fsDown").onclick = () => bumpChatFs(-1);
$("fsUp").onclick = () => bumpChatFs(1);


/* ---------------- Search all chats (v2.00) --------- */
$("toolSearchChats").onclick = () => {
  hideTools();
  const q = prompt("Search all chats in this project:");
  if (!q || !q.trim()) return;
  saveHistory();
  const chats = [];
  for (const s of chatSessions) {
    let items = [];
    try {
      items = JSON.parse(localStorage.getItem(
        sessionHistoryKey(historyScope, s.id)) || "[]");
    } catch (e) {}
    if (Array.isArray(items) && items.length)
      chats.push({ name: s.name, messages: items });
  }
  addMsg("SYSTEM", searchResultsText(q.trim(),
    searchChats(chats, q, 12)));
};


/* ---------------- Autosave (v2.01) ----------------- */
$("setAutosave").checked = !!settings.autosave;
$("setAutosave").onchange = (e) => {
  settings.autosave = e.target.checked;
  saveSettings();
};
let asSnap = null, asIdle = 0;
setInterval(() => {
  if (!settings.autosave || !currentFile || !dirty) {
    asSnap = null;
    asIdle = 0;
    return;
  }
  const cur = view.state.doc.toString();
  if (cur === asSnap) asIdle++;
  else { asSnap = cur; asIdle = 0; }
  if (autosaveDue(settings.autosave, !!currentFile,
      dirty, asIdle)) {
    asIdle = 0;
    saveFile();
  }
}, 1500);


/* ---------------- Summarize chat (v2.02) ----------- */
$("summarizeBtn").onclick = () => {
  const req = summaryRequest(history);
  if (!req) {
    alert("Not enough conversation to summarize yet.");
    return;
  }
  $("chatText").value = req;
  sendChat();
};


/* ---------------- Duplicate file (v2.03) ----------- */
$("dupFileBtn").onclick = async () => {
  if (!currentFile) {
    alert("No file is open.");
    return;
  }
  const name = prompt("Duplicate as:", copyName(currentFile));
  if (!name || name === currentFile) return;
  const r = await fetch("/api/file?path=" +
    encodeURIComponent(currentFile));
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  const w = await fetch("/api/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: name,
      content: d.content || "" }),
  });
  const wd = await w.json();
  if (wd.error) { alert(wd.error); return; }
  await loadFiles();
  openFile(name);
};


/* ---------------- Jump to latest (v2.04) ----------- */
function syncJumpBtn() {
  const el = $("chatLog");
  $("jumpLatest").classList.toggle("hidden",
    !showJump(el.scrollTop, el.clientHeight,
      el.scrollHeight));
}
$("chatLog").addEventListener("scroll", syncJumpBtn);
$("jumpLatest").onclick = () => {
  const el = $("chatLog");
  el.scrollTop = el.scrollHeight;
  syncJumpBtn();
};


/* ---------------- Clear all chats (v2.05) ---------- */
$("clearChatsBtn").onclick = () => {
  if (!confirm("Delete every chat in this project? " +
      "This cannot be undone.")) return;
  for (const k of projectHistoryKeys(historyScope,
      chatSessions)) {
    try { localStorage.removeItem(k); } catch (e) {}
  }
  loadHistory();
  renderSessionSel();
};


/* ---------------- Speak last answer (v2.06) -------- */
$("speakLastBtn").onclick = () => {
  const text = lastAnswerOf(history);
  if (!text) {
    alert("No answer to speak yet.");
    return;
  }
  if (!("speechSynthesis" in window)) {
    alert("Speech is not available on this device.");
    return;
  }
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    return;
  }
  speechSynthesis.speak(
    new SpeechSynthesisUtterance(speakText(text)));
};


/* ---------------- About this build (v2.07) --------- */
$("toolAbout").onclick = async () => {
  hideTools();
  let entry = null, version = "?";
  try {
    const r = await fetch("changelog.json");
    const d = await r.json();
    if (d.entries && d.entries.length) {
      entry = d.entries[0];
      version = entry.version;
    }
  } catch (e) {}
  let evidence = "";
  try {
    const hr = await fetch("/api/health");
    const h = await hr.json();
    const parts = [];
    if (h.backupFormats) parts.push(
      "backups v" + h.backupFormats.join(" + v"));
    if (h.pairRequired) parts.push(
      "pairing required for other devices");
    if (h.targetSdk) parts.push("target SDK " + h.targetSdk);
    evidence = parts.join(" \u00b7 ");
  } catch (e) { /* evidence is best-effort */ }
  addMsg("SYSTEM", aboutText(appInfoText({
    version,
    chats: chatSessions.length,
    prompts: promptLib.length,
    profiles: Object.keys(loadProfiles()).length,
    starred: loadStarAnswers().length,
    eco: "25 packages / 2,642 tests",
  }), entry, evidence));
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
function aiAction(kind, note) {
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
  $("chatText").value = prompts[kind] +
    (note ? "\n\nAlso: " + note : "");
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
  // v2.36: attribute values are quote-escaped at
  // interpolation. escHtml already ran over the
  // source, but it leaves double quotes alone, so
  // a quote in alt text or a URL used to break out
  // of the attribute - a stored-XSS hole in any
  // previewed .md, on an origin that holds the
  // GitHub and pair tokens.
  const escQ = (s) => s.replace(/"/g, "&quot;");
  const inline = (t) => t
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, s) =>
      "<img alt=\"" + escQ(alt) + "\" src=\"" +
      (/^(https?:|data:)/i.test(s) ? escQ(s)
        : "/api/raw?path=" + encodeURIComponent(mdResolve(base, s))) +
      "\">")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
      if (/^https?:/i.test(href) || href.startsWith("//")) {
        return "<a href=\"" + escQ(href) +
          "\" target=\"_blank\" rel=\"noopener\">" + text + "</a>";
      }
      if (/^mailto:/i.test(href)) {
        return "<a href=\"" + escQ(href) + "\">" + text + "</a>";
      }
      // v2.36: any other scheme (javascript:,
      // data:, vbscript:, file:) renders as plain
      // text - the link is inert, the words stay
      // readable.
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        return text;
      }
      const resolved = mdResolve(base, href);
      if (/\.md$/i.test(resolved)) {
        return "<a href=\"#" + escQ(resolved) + "\" data-md=\"" +
          escQ(resolved) + "\">" + text + "</a>";
      }
      return "<a href=\"" + escQ(href) + "\">" + text + "</a>";
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
    mode, budget: sliceBudget() });
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

$("toolExportChat").onclick = () => exportChatAs("md");

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
  { title: "Verify pipeline", run: () => $("toolVerify").click() },
  { title: "Big-screen mode", run: () => $("toolBigscreen").click() },
  { title: "Keyboard shortcuts", run: () => $("toolKeys").click() },
  { title: "Export app state", run: () => $("toolStateExport").click() },
  { title: "Import app state", run: () => $("toolStateImport").click() },
  { title: "Toggle completion ping", run: () => $("toolNotify").click() },
  { title: "Registry", run: () => $("toolRegistry").click() },
  { title: "Classroom view", run: () => $("toolClassroom").click() },
  { title: "Take the tour", run: () => $("toolTour").click() },
  { title: "What's new", run: () => $("toolChangelog").click() },
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

/* Roadmap ECO E5: the Atlas half of the repo map panel -
   renders the GhostAtlas tool's own scan data. Every number
   on it is the tool's (token counts are its estimates). */
function renderAtlas(box, st) {
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "dim";
  head.textContent = "🗺 " + (st.title || "project") + " - " +
    st.files.length + " files · ~" + st.totalTokens +
    " est tokens (GhostAtlas, built on GhostSlice data; " +
    "counts are estimates)";
  box.appendChild(head);
  if (st.git) {
    const g = document.createElement("div");
    g.className = "dim";
    g.textContent = st.git.available
      ? "git: " + st.git.total_commits + " commits (" +
        (st.git.window || "recent window") + ")"
      : "git: not available for this project";
    box.appendChild(g);
  }
  for (const p of st.packages) {
    const row = document.createElement("div");
    row.className = "todorow";
    const label = document.createElement("span");
    label.textContent = "📦 " + (p.label || p.path || "(root)") +
      " - " + p.files + " files";
    row.appendChild(label);
    const chip = document.createElement("span");
    chip.className = "symkind";
    chip.textContent = "~" + (p.tokens || 0) + " tok" +
      (p.share != null ? " · " + p.share + "%" : "");
    row.appendChild(chip);
    box.appendChild(row);
  }
  for (const f of st.files) {
    const row = document.createElement("div");
    row.className = "findRow";
    const main = document.createElement("span");
    main.textContent = f.path;
    row.appendChild(main);
    const meta = document.createElement("span");
    meta.className = "dim";
    meta.textContent = " · ~" + (f.tokens || 0) + " tok" +
      (f.symbols && f.symbols.length
        ? " · " + f.symbols.length + " symbols" : "") +
      (f.importer_count
        ? " · " + f.importer_count + " importers" : "");
    row.appendChild(meta);
    row.onclick = () => { openFile(f.path); };
    box.appendChild(row);
  }
  if (st.dead.length) {
    const dh = document.createElement("div");
    dh.className = "dim";
    dh.textContent = "Dead-code candidates (the tool's list):";
    box.appendChild(dh);
    for (const d of st.dead) {
      const row = document.createElement("div");
      row.className = "findRow";
      row.textContent = d.path + " - " + (d.reason || "");
      row.onclick = () => { openFile(d.path); };
      box.appendChild(row);
    }
  }
}

$("toolRepoMap").onclick = async () => {
  hideTools();
  $("todoTitle").textContent = "Repo map";
  const box = $("todoResults");
  box.innerHTML = "";
  $("todoPanel").classList.remove("hidden");
  /* Roadmap ECO E5: two views of the project - the native
     ranked map, and the Atlas view fed by the GhostAtlas
     tool itself (/api/eco/atlas). */
  const tabs = document.createElement("div");
  tabs.className = "findRow";
  const tabMap = document.createElement("button");
  tabMap.className = "ghostbtn";
  tabMap.textContent = "Repo map";
  const tabAtlas = document.createElement("button");
  tabAtlas.className = "ghostbtn";
  tabAtlas.textContent = "🗺 Atlas";
  tabs.appendChild(tabMap);
  tabs.appendChild(tabAtlas);
  box.appendChild(tabs);
  const viewBox = document.createElement("div");
  box.appendChild(viewBox);
  let atlasCache = null;
  const showMap = async () => {
    tabMap.disabled = true;
    tabAtlas.disabled = false;
    viewBox.innerHTML =
      '<div class="dim">Building the map…</div>';
    try {
      const mapText = await getRepoMap();
      viewBox.innerHTML = "";
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
      viewBox.appendChild(arm);
      const pre = document.createElement("div");
      pre.className = "mapText";
      pre.textContent = mapText || "(no symbols yet)";
      viewBox.appendChild(pre);
    } catch (e) {
      viewBox.innerHTML = "";
      const el = document.createElement("div");
      el.className = "dim";
      el.textContent = "Repo map unavailable: " + e.message;
      viewBox.appendChild(el);
    }
  };
  const showAtlas = async () => {
    tabAtlas.disabled = true;
    tabMap.disabled = false;
    viewBox.innerHTML = '<div class="dim">Building the ' +
      'atlas with GhostAtlas…</div>';
    try {
      if (!atlasCache) {
        const d = await postJson("/api/eco/atlas", {});
        atlasCache = atlasState(d);
        if (!atlasCache)
          throw new Error(d.error || "the tool could not run");
      }
      renderAtlas(viewBox, atlasCache);
    } catch (e) {
      viewBox.innerHTML = "";
      const el = document.createElement("div");
      el.className = "dim";
      el.textContent = "Atlas unavailable: " + e.message;
      viewBox.appendChild(el);
    }
  };
  tabMap.onclick = showMap;
  tabAtlas.onclick = showAtlas;
  showMap();
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

/* ---------------- Agent v2 (Beat Cline C1-C3) ----------------
   Plan / Act / Checkpoints, pure offline, same local model.
   PLAN mode: read-only loop (READ / SEARCH / LIST / TODO) that
   ends in a written plan the user approves before anything is
   edited. ACT mode (agent mode): a multi-step loop, one action
   per reply:
     READ <path>     SEARCH <query>    LIST [path]
     WRITE <path>    + fenced block with the COMPLETE new content
     EDIT <path>     + two fenced blocks (exact old text, new text)
                       or one block with <<<<<<< SEARCH / ======= /
                       >>>>>>> REPLACE markers
     RUN <command>   terminal command, approval-gated per command
     DELETE <path>   staged deletion
     TODO <text>     STEP_DONE <text or number>
     CHECK           DONE <summary>    ASK <question>
   Writes and deletes are STAGED, never on disk, until the user
   approves them in the review panel. After every staged change
   the loop snapshots a checkpoint of the staged state, so the
   review can roll the agent back to any step. Before an approved
   apply touches disk, the originals are saved as an on-disk
   checkpoint under .ghostide/checkpoints/ so the whole apply
   can be undone later from the Checkpoints panel. */
const AGENT_MAX_STEPS = 50;
const AGENT_PLAN_MAX_STEPS = 20;
let agentRunning = false;
let agentStop = false;
const AGENT_RULES = [
  "You are Ghost in AGENT MODE. Complete the task by",
  "replying with exactly ONE action per message:",
  "READ <path> - ask for a file's current content",
  "SEARCH <query> - search the whole workspace for text",
  "LIST [path] - list workspace files (optionally under a path)",
  "WRITE <path> - on the next line a fenced code block with",
  "  the file's complete new content (whole file, no fragments)",
  "EDIT <path> - on the following lines TWO fenced blocks:",
  "  the first holds the exact existing text to replace, the",
  "  second the replacement text. Prefer EDIT for small changes.",
  "RUN <command> - run a terminal command in the workspace",
  "  (the user approves each command; output comes back to you)",
  "DELETE <path> - stage a file for deletion",
  "TODO <text> - add an item to the task plan list",
  "STEP_DONE <text or number> - mark a plan item done",
  "CHECK - syntax-check everything you have staged",
  "DONE <one-line summary> - the task is complete",
  "ASK <question> - you need the user to decide something",
  "Rules: never invent file contents - READ a file before",
  "rewriting it. Keep every WRITE and EDIT syntactically valid.",
  "Do not explain outside the action line. You have at most "
    + AGENT_MAX_STEPS + " actions.",
].join("\n");
const AGENT_PLAN_RULES = [
  "You are Ghost in PLAN MODE. Research the task and write a",
  "plan. You may NOT edit anything. Reply with exactly ONE",
  "action per message:",
  "READ <path> - ask for a file's current content",
  "SEARCH <query> - search the whole workspace for text",
  "LIST [path] - list workspace files",
  "TODO <text> - add one step of the plan",
  "DONE <one-line summary> - on the following lines, a fenced",
  "  block with the full written plan in markdown",
  "ASK <question> - you need the user to decide something",
  "Add each plan step as a TODO as you work it out, then finish",
  "with DONE and the written plan. You have at most "
    + AGENT_PLAN_MAX_STEPS + " actions.",
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

/*@@AGENT2@@*/
function parseAgent2Action(reply) {
  const text = reply || "";
  let m = text.match(/^\s*EDIT\s+(\S+)\s*\n```[a-zA-Z0-9]*\n([\s\S]*?)```\s*\n```[a-zA-Z0-9]*\n([\s\S]*?)```/m);
  if (m) return { type: "edit", path: m[1], oldText: m[2], newText: m[3] };
  m = text.match(/^\s*EDIT\s+(\S+)\s*\n```[a-zA-Z0-9]*\n([\s\S]*?)```/m);
  if (m) {
    const parts = splitEditMarkers(m[2]);
    if (parts) return { type: "edit", path: m[1],
      oldText: parts[0], newText: parts[1] };
    return { type: "editbad", path: m[1] };
  }
  m = text.match(/^\s*SEARCH\s+(.+)$/m);
  if (m) return { type: "search", query: m[1].trim() };
  m = text.match(/^\s*LIST(?:\s+(\S+))?\s*$/m);
  if (m) return { type: "list", path: m[1] || "" };
  m = text.match(/^\s*RUN\s+(.+)$/m);
  if (m) return { type: "run", command: m[1].trim() };
  m = text.match(/^\s*DELETE\s+(\S+)\s*$/m);
  if (m) return { type: "delete", path: m[1] };
  m = text.match(/^\s*TODO\s+(.+)$/m);
  if (m) return { type: "todo", text: m[1].trim() };
  m = text.match(/^\s*STEP_DONE\s+(.+)$/m);
  if (m) return { type: "stepdone", text: m[1].trim() };
  m = text.match(/^\s*DONE\s*(.*)$/m);
  if (m) {
    const fm = text.match(/```[a-zA-Z0-9]*\n([\s\S]*?)```/);
    return { type: "done", summary: (m[1] || "").trim(),
      plan: fm ? fm[1] : "" };
  }
  /* The v1 actions, handled inline so this block stays
     self-contained for the harness. */
  m = text.match(/^\s*READ\s+(\S+)\s*$/m);
  if (m) return { type: "read", path: m[1] };
  m = text.match(/^\s*WRITE\s+(\S+)\s*\n```[a-zA-Z0-9]*\n([\s\S]*?)```/m);
  if (m) {
    let content = m[2];
    if (!content.endsWith("\n")) content += "\n";
    return { type: "write", path: m[1], content };
  }
  if (/^\s*CHECK\s*$/m.test(text)) return { type: "check" };
  m = text.match(/^\s*ASK\s+(.+)$/m);
  if (m) return { type: "ask", question: m[1].trim() };
  return { type: "unknown", raw: text.slice(0, 200) };
}
function splitEditMarkers(block) {
  const s = /^\s*<<<<<<< SEARCH\n/.exec(block || "");
  if (!s) return null;
  const rest = block.slice(s[0].length);
  const mid = rest.indexOf("\n=======\n");
  if (mid < 0) return null;
  const tail = rest.slice(mid + "\n=======\n".length);
  const end = tail.indexOf("\n>>>>>>> REPLACE");
  if (end < 0) return null;
  return [rest.slice(0, mid + 1), tail.slice(0, end + 1)];
}
function applyEditPatch(content, oldText, newText) {
  if (content == null) return { ok: false,
    error: "file does not exist yet - create it with WRITE" };
  if (!oldText) return { ok: false,
    error: "the old-text block is empty" };
  const first = content.indexOf(oldText);
  if (first < 0) return { ok: false,
    error: "old text not found in the file - READ it again and " +
      "copy the exact text, including whitespace" };
  if (content.indexOf(oldText, first + 1) >= 0) return { ok: false,
    error: "old text appears more than once - include more " +
      "surrounding lines so it matches exactly one place" };
  return { ok: true, content: content.slice(0, first) + newText +
    content.slice(first + oldText.length) };
}
function normalizeAgentTodos(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const t of list) {
    if (!t || typeof t.text !== "string") continue;
    const text = t.text.trim().slice(0, 200);
    if (text) out.push({ text, done: !!t.done });
  }
  return out.slice(0, 60);
}
function addAgentTodo(todos, text) {
  const list = normalizeAgentTodos(todos);
  const clean = String(text || "").trim().slice(0, 200);
  if (clean && !list.some((t) => t.text === clean))
    list.push({ text: clean, done: false });
  return list;
}
function completeAgentTodo(todos, ref) {
  const list = normalizeAgentTodos(todos);
  const key = String(ref || "").trim();
  let idx = -1;
  if (/^\d+$/.test(key)) idx = parseInt(key, 10) - 1;
  if (idx < 0 || idx >= list.length)
    idx = list.findIndex((t) => !t.done &&
      t.text.toLowerCase().includes(key.toLowerCase()));
  if (idx >= 0 && idx < list.length) list[idx].done = true;
  return list;
}
function makeAgentCheckpoint(n, label, step, staged, deletions, todos) {
  const s = {};
  for (const k of Object.keys(staged || {})) s[k] = staged[k];
  return { n, label: String(label || ""), step,
    staged: s, deletions: (deletions || []).slice(),
    todos: normalizeAgentTodos(todos) };
}
function agentStateSummary(staged, deletions, todos) {
  const files = Object.keys(staged || {});
  const open = normalizeAgentTodos(todos).filter((t) => !t.done)
    .map((t) => t.text);
  return "State so far: " + files.length + " file(s) staged" +
    (files.length ? " (" + files.join(", ") + ")" : "") +
    ((deletions || []).length
      ? "; deletions staged: " + deletions.join(", ") : "") +
    (open.length ? "; open plan items: " + open.join(" | ") : "") + ".";
}
function compactAgentMessages(messages, summary, limit) {
  const cap = limit || 56000;
  let total = 0;
  for (const msg of messages) total += (msg.content || "").length;
  if (total <= cap || messages.length <= 8) return messages;
  const head = messages.slice(0, 1);
  const tail = messages.slice(-6);
  return head.concat([{ role: "user",
    content: "Earlier steps were compacted to save context. " +
      summary + " Continue with exactly one action." }], tail);
}
function buildDiskCheckpoint(task, originals, deletedOriginals) {
  return { kind: "ghostide-checkpoint", version: 1,
    created: new Date().toISOString(),
    task: String(task || "").slice(0, 300),
    files: originals || {}, deleted: deletedOriginals || {} };
}
function checkpointFileName(date) {
  const d = date || new Date();
  const p = (x) => String(x).padStart(2, "0");
  return ".ghostide/checkpoints/ckpt-" + d.getFullYear() +
    p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) +
    p(d.getMinutes()) + p(d.getSeconds()) + ".json";
}
/*@@AGENT2-END@@*/
window.__ghostParseAgent2 = parseAgent2Action;
window.__ghostApplyEdit = applyEditPatch;

function agentTodosLoad() {
  try {
    return normalizeAgentTodos(JSON.parse(
      localStorage.getItem("ghostide-agent2-todos") || "[]"));
  } catch (e) { return []; }
}
function agentTodosSave(todos) {
  try {
    localStorage.setItem("ghostide-agent2-todos",
      JSON.stringify(normalizeAgentTodos(todos)));
  } catch (e) { /* storage full/blocked: todos stay in memory */ }
}
function agentActiveSave(state) {
  try {
    const s = JSON.stringify(state);
    if (s.length <= 1500000)
      localStorage.setItem("ghostide-agent2-active", s);
  } catch (e) { /* as above */ }
}
function agentActiveLoad() {
  try {
    return JSON.parse(
      localStorage.getItem("ghostide-agent2-active") || "null");
  } catch (e) { return null; }
}
function agentActiveClear() {
  try { localStorage.removeItem("ghostide-agent2-active"); }
  catch (e) {}
}
function ckptIndexLoad() {
  try {
    const v = JSON.parse(
      localStorage.getItem("ghostide-agent2-ckpts") || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function ckptIndexSave(list) {
  try {
    localStorage.setItem("ghostide-agent2-ckpts",
      JSON.stringify(list.slice(0, 40)));
  } catch (e) {}
}
function renderAgentTodos(todos, checkpoints) {
  $("todoTitle").textContent = "🤖 Agent plan";
  const box = $("todoResults");
  box.innerHTML = "";
  if (!todos.length && !(checkpoints || []).length) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = "No plan items yet.";
    box.appendChild(el);
  }
  todos.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = (t.done ? "☑ " : "☐ ") + (i + 1) + ". " + t.text;
    box.appendChild(row);
  });
  if ((checkpoints || []).length) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = "⛉ " + checkpoints.length +
      " checkpoint(s) - restore points are in the review panel " +
      "at the end of the task, and under Checkpoints after applying.";
    box.appendChild(el);
  }
  $("todoPanel").classList.remove("hidden");
}
function agentApproveRunUi(command) {
  return new Promise((resolve) => {
    const body = addMsg("SYSTEM",
      "🤖 Agent wants to run:\n" + command +
      "\nApprove this command?");
    const row = document.createElement("div");
    row.className = "optRow";
    const mk = (label, val) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => { row.remove(); resolve(val); };
      row.appendChild(b);
    };
    mk("✓ Run it", "once");
    mk("✓ Run, and auto-approve runs this task", "all");
    mk("✖ Deny", "deny");
    body.appendChild(row);
  });
}
async function agentCheckOne(path, content) {
  try {
    const d = await postJson("/api/check-content",
      { path, content });
    if (d.ok === true) return path + ": OK";
    if (d.ok === false) return path + ": PROBLEM " +
      (d.message || "") + (d.line ? " (line " + d.line + ")" : "");
    return path + ": check skipped (" + (d.note || "n/a") + ")";
  } catch (e) { return path + ": check failed (" + e + ")"; }
}

async function runAgent(task, opts) {
  opts = opts || {};
  if (agentRunning) {
    addMsg("SYSTEM", "An agent task is already running.");
    return;
  }
  if (anyOpenDirty()) {
    addMsg("SYSTEM", "Agent mode works from the saved files - " +
      "save your open edits first.");
    return;
  }
  agentRunning = true;
  agentStop = false;
  const agentT0 = Date.now();
  const staged = new Map(Object.entries(opts.staged || {}));
  const deletions = new Set(opts.deletions || []);
  let todos = normalizeAgentTodos(opts.todos || []);
  let checkpoints = [];
  let runAllowAll = false;
  addMsg("YOU", "🤖 " + task + (opts.plan
    ? "\n(following the approved plan)" : ""));
  const sendBtn = $("chatSend");
  const oldSend = sendBtn.onclick;
  sendBtn.textContent = "■ Stop agent";
  sendBtn.onclick = () => { agentStop = true; };
  const readCache = new Map();
  async function readForAgent(path) {
    if (staged.has(path)) return staged.get(path);
    if (deletions.has(path)) return null;
    if (readCache.has(path)) return readCache.get(path);
    const r = await fetch("/api/file?path=" +
      encodeURIComponent(path));
    const d = await r.json();
    if (d.error) return null;
    readCache.set(path, d.content);
    return d.content;
  }
  function snapshot(label, step) {
    const cp = makeAgentCheckpoint(checkpoints.length + 1, label,
      step, Object.fromEntries(staged), [...deletions], todos);
    checkpoints.push(cp);
    persist();
    return cp;
  }
  function persist() {
    agentTodosSave(todos);
    agentActiveSave({ task, plan: opts.plan || "",
      todos, staged: Object.fromEntries(staged),
      deletions: [...deletions],
      checkpoints: checkpoints.map((c) => ({ n: c.n,
        label: c.label, step: c.step })),
      savedAt: Date.now() });
  }
  let mapText = "";
  try { mapText = await getRepoMap(); } catch (e) { /* optional */ }
  const messages = [
    { role: "system", content: BEHAVIOR.systemPrompt + "\n\n" +
      AGENT_RULES + (mapText ? "\n\n" + mapText : "") +
      (opts.plan ? "\n\nApproved plan:\n" + opts.plan : "") },
    { role: "user", content: "Task: " + task +
      (currentFile ? "\nThe user is currently editing: "
        + currentFile : "") +
      (todos.length ? "\nPlan items: " + todos.map((t, i) =>
        (i + 1) + ". " + t.text).join(" | ") : "") },
  ];
  snapshot("task start", 0);
  let outcome = "cap";
  let summary = "";
  let nudges = 0;
  for (let step = 1; step <= AGENT_MAX_STEPS; step++) {
    if (thermalWatchdog() === "stop") {
      addMsg("SYSTEM", "🌡 Agent stopped: the device " +
        "reached severe heat. (Thermal guard.)");
      agentStop = true;
    }
    if (agentStop) { outcome = "stopped"; break; }
    addMsg("SYSTEM", "🤖 step " + step + "/" + AGENT_MAX_STEPS);
    let reply = "";
    try {
      const compacted = compactAgentMessages(messages,
        agentStateSummary(Object.fromEntries(staged),
          [...deletions], todos));
      reply = await collectChat(compacted, 2048);
    } catch (e) {
      addMsg("SYSTEM", "Agent: model call failed: " + e);
      outcome = "failed";
      break;
    }
    messages.push({ role: "assistant", content: reply });
    const act = parseAgent2Action(reply);
    if (act.type === "read") {
      const content = await readForAgent(act.path);
      addMsg("SYSTEM", "📖 READ " + act.path);
      messages.push({ role: "user", content: content == null
        ? "READ failed: " + act.path + " does not exist yet. " +
          "You may create it with WRITE."
        : "Content of " + act.path + ":\n```\n" +
          content.slice(0, 12000) + "\n```" });
    } else if (act.type === "search") {
      const d = await postJson("/api/search", { query: act.query });
      const ms = (d.matches || []).slice(0, 20);
      addMsg("SYSTEM", "🔎 SEARCH " + act.query + " - " +
        ms.length + " match(es)");
      messages.push({ role: "user", content: "Search results " +
        "for " + act.query + ":\n" + (ms.length
          ? ms.map((x) => x.path + ":" + x.line + " " + x.text)
              .join("\n")
          : "(no matches)") });
    } else if (act.type === "list") {
      const fr = await fetch("/api/files");
      const fd = await fr.json();
      let names = (fd.files || []).filter((x) => x.type === "file")
        .map((x) => x.path);
      if (act.path) names = names.filter((p) =>
        p === act.path || p.startsWith(act.path + "/"));
      addMsg("SYSTEM", "🗂 LIST " + (act.path || "(all)") + " - " +
        names.length + " file(s)");
      messages.push({ role: "user", content: "Files" +
        (act.path ? " under " + act.path : "") + ":\n" +
        names.slice(0, 120).join("\n") });
    } else if (act.type === "write") {
      staged.set(act.path, act.content);
      deletions.delete(act.path);
      const note = await agentCheckOne(act.path, act.content);
      snapshot("WRITE " + act.path, step);
      addMsg("SYSTEM", "✏️ WRITE " + act.path +
        " (staged - not saved)\n" + note);
      messages.push({ role: "user", content: "Staged " +
        act.path + ". " + staged.size + " file(s) staged. " +
        "Automatic check: " + note + " Continue." });
    } else if (act.type === "edit") {
      const base = await readForAgent(act.path);
      const r = applyEditPatch(base, act.oldText, act.newText);
      if (!r.ok) {
        addMsg("SYSTEM", "✏️ EDIT " + act.path + " failed: " +
          r.error);
        messages.push({ role: "user", content: "EDIT failed " +
          "for " + act.path + ": " + r.error });
      } else {
        staged.set(act.path, r.content);
        deletions.delete(act.path);
        const note = await agentCheckOne(act.path, r.content);
        snapshot("EDIT " + act.path, step);
        addMsg("SYSTEM", "✏️ EDIT " + act.path +
          " (staged - not saved)\n" + note);
        messages.push({ role: "user", content: "Edit staged " +
          "for " + act.path + ". Automatic check: " + note +
          " Continue." });
      }
    } else if (act.type === "editbad") {
      messages.push({ role: "user", content: "That EDIT for " +
        act.path + " had no usable patch. Send EDIT with two " +
        "fenced blocks (exact old text, then replacement), or " +
        "one block using <<<<<<< SEARCH / ======= / >>>>>>> " +
        "REPLACE markers." });
    } else if (act.type === "run") {
      let verdict = runAllowAll ? "all"
        : await agentApproveRunUi(act.command);
      if (verdict === "all") runAllowAll = true;
      if (agentStop) { outcome = "stopped"; break; }
      if (verdict === "deny") {
        addMsg("SYSTEM", "⛔ RUN denied by you: " + act.command);
        messages.push({ role: "user", content: "The user " +
          "denied that command. Do not retry it; find another " +
          "way or finish with DONE." });
      } else {
        const d = await postJson("/api/terminal",
          { command: act.command });
        const out = ((d.stdout || "") + (d.stderr || ""))
          .slice(-6000);
        addMsg("SYSTEM", "▶ RUN " + act.command + " - exit " +
          (d.code != null ? d.code : "?") + "\n" +
          out.slice(-1200));
        messages.push({ role: "user", content: "Command ran: " +
          act.command + "\nExit code: " + d.code +
          "\nOutput (tail):\n" + (out || "(no output)") });
      }
    } else if (act.type === "delete") {
      staged.delete(act.path);
      deletions.add(act.path);
      snapshot("DELETE " + act.path, step);
      addMsg("SYSTEM", "🗑 DELETE " + act.path +
        " (staged - not deleted yet)");
      messages.push({ role: "user", content: "Deletion of " +
        act.path + " staged. It happens only if the user " +
        "approves it in review. Continue." });
    } else if (act.type === "todo") {
      todos = addAgentTodo(todos, act.text);
      persist();
      renderAgentTodos(todos, checkpoints);
      messages.push({ role: "user", content: "Plan item added. " +
        "Items now: " + todos.map((t, i) => (i + 1) + ". " +
        t.text).join(" | ") });
    } else if (act.type === "stepdone") {
      todos = completeAgentTodo(todos, act.text);
      persist();
      renderAgentTodos(todos, checkpoints);
      messages.push({ role: "user",
        content: "Plan item marked done. Continue." });
    } else if (act.type === "check") {
      const notes = [];
      for (const [p, c] of staged)
        notes.push(await agentCheckOne(p, c));
      if (!notes.length) notes.push("nothing staged to check");
      addMsg("SYSTEM", "🔍 CHECK\n" + notes.join("\n"));
      messages.push({ role: "user", content: "Check results:\n" +
        notes.join("\n") +
        "\nFix any problems with another WRITE or EDIT, or " +
        "finish with DONE." });
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
        addMsg("SYSTEM", "Agent stopped: two replies in a row " +
          "had no action in them.");
        outcome = "failed";
        break;
      }
      messages.push({ role: "user", content: "That reply had " +
        "no action. Reply with exactly one action: READ, " +
        "SEARCH, LIST, WRITE, EDIT, RUN, DELETE, TODO, " +
        "STEP_DONE, CHECK, DONE, or ASK." });
    }
  }
  sendBtn.textContent = "Send";
  sendBtn.onclick = oldSend;
  agentRunning = false;
  if (outcome === "stopped") {
    addMsg("SYSTEM", "Agent stopped by you. Nothing was " +
      "written - the staged changes stay saved as a resumable " +
      "task (Chat options: Resume agent task).");
    persist();
  } else if (outcome === "cap") {
    addMsg("SYSTEM", "Agent hit the " + AGENT_MAX_STEPS +
      "-step cap.");
  }
  if ((outcome === "done" || outcome === "cap") &&
      (staged.size || deletions.size)) {
    agentActiveClear();
    addMsg("GHOST", "🤖 " + (summary || "Task run complete") +
      " - review the " + staged.size + " file change(s)" +
      (deletions.size ? " and " + deletions.size +
        " deletion(s)" : "") + " below. Nothing is saved " +
      "until you approve.");
    openAgentReview({ staged, deletions, checkpoints, todos,
      task });
  } else if (outcome === "done") {
    agentActiveClear();
    addMsg("GHOST", "🤖 Done: " + summary);
  }
  notifyDone("Agent finished",
    "The agent task ended (" + outcome + ").", agentT0);
}

async function runPlan(task) {
  if (agentRunning) {
    addMsg("SYSTEM", "An agent task is already running.");
    return;
  }
  agentRunning = true;
  agentStop = false;
  const planT0 = Date.now();
  let todos = [];
  addMsg("YOU", "📝 Plan: " + task);
  const sendBtn = $("chatSend");
  const oldSend = sendBtn.onclick;
  sendBtn.textContent = "■ Stop planning";
  sendBtn.onclick = () => { agentStop = true; };
  let mapText = "";
  try { mapText = await getRepoMap(); } catch (e) { /* optional */ }
  const messages = [
    { role: "system", content: BEHAVIOR.systemPrompt + "\n\n" +
      AGENT_PLAN_RULES + (mapText ? "\n\n" + mapText : "") },
    { role: "user", content: "Task: " + task +
      (currentFile ? "\nThe user is currently editing: "
        + currentFile : "") },
  ];
  const readCache = new Map();
  let planText = "";
  let summary = "";
  let outcome = "cap";
  let nudges = 0;
  for (let step = 1; step <= AGENT_PLAN_MAX_STEPS; step++) {
    if (agentStop) { outcome = "stopped"; break; }
    addMsg("SYSTEM", "📝 planning step " + step + "/" +
      AGENT_PLAN_MAX_STEPS);
    let reply = "";
    try {
      reply = await collectChat(messages, 2048);
    } catch (e) {
      addMsg("SYSTEM", "Plan: model call failed: " + e);
      outcome = "failed";
      break;
    }
    messages.push({ role: "assistant", content: reply });
    const act = parseAgent2Action(reply);
    if (act.type === "read") {
      let content = readCache.get(act.path);
      if (content === undefined) {
        const r = await fetch("/api/file?path=" +
          encodeURIComponent(act.path));
        const d = await r.json();
        content = d.error ? null : d.content;
        readCache.set(act.path, content);
      }
      addMsg("SYSTEM", "📖 READ " + act.path);
      messages.push({ role: "user", content: content == null
        ? "READ failed: " + act.path + " does not exist."
        : "Content of " + act.path + ":\n```\n" +
          content.slice(0, 12000) + "\n```" });
    } else if (act.type === "search") {
      const d = await postJson("/api/search", { query: act.query });
      const ms = (d.matches || []).slice(0, 20);
      messages.push({ role: "user", content: "Search results " +
        "for " + act.query + ":\n" + (ms.length
          ? ms.map((x) => x.path + ":" + x.line + " " + x.text)
              .join("\n") : "(no matches)") });
    } else if (act.type === "list") {
      const fr = await fetch("/api/files");
      const fd = await fr.json();
      let names = (fd.files || []).filter((x) => x.type === "file")
        .map((x) => x.path);
      if (act.path) names = names.filter((p) =>
        p === act.path || p.startsWith(act.path + "/"));
      messages.push({ role: "user", content: "Files:\n" +
        names.slice(0, 120).join("\n") });
    } else if (act.type === "todo") {
      todos = addAgentTodo(todos, act.text);
      agentTodosSave(todos);
      renderAgentTodos(todos, []);
      messages.push({ role: "user",
        content: "Plan step recorded. Continue." });
    } else if (act.type === "done") {
      planText = act.plan || act.summary || "";
      summary = act.summary;
      outcome = "done";
      break;
    } else if (act.type === "ask") {
      addMsg("GHOST", "❓ " + act.question);
      outcome = "asked";
      break;
    } else if (["write", "edit", "run", "delete"].includes(act.type)) {
      messages.push({ role: "user", content: "Plan mode is " +
        "read-only: " + act.type.toUpperCase() + " is not " +
        "allowed here. Record it as a TODO step instead, and " +
        "finish with DONE plus the written plan." });
    } else {
      nudges++;
      if (nudges > 1) { outcome = "failed"; break; }
      messages.push({ role: "user", content: "That reply had " +
        "no action. Reply with exactly one action: READ, " +
        "SEARCH, LIST, TODO, DONE, or ASK." });
    }
  }
  sendBtn.textContent = "Send";
  sendBtn.onclick = oldSend;
  agentRunning = false;
  if (outcome === "done") {
    try {
      localStorage.setItem("ghostide-agent2-plan",
        JSON.stringify({ task, plan: planText, todos,
          ts: Date.now() }));
    } catch (e) {}
    const body = addMsg("GHOST", "📝 Plan ready: " +
      (summary || task) + "\n\n" + planText + "\n\nSteps:\n" +
      (todos.length ? todos.map((t, i) => (i + 1) + ". " + t.text)
        .join("\n") : "(no steps recorded)"));
    const row = document.createElement("div");
    row.className = "optRow";
    const actBtn = document.createElement("button");
    actBtn.textContent = "🤖 Act on this plan";
    actBtn.onclick = () => {
      row.remove();
      runAgent(task, { plan: planText, todos });
    };
    const disBtn = document.createElement("button");
    disBtn.textContent = "Discard plan";
    disBtn.onclick = () => {
      row.remove();
      addMsg("SYSTEM", "Plan discarded. Nothing was changed.");
    };
    row.appendChild(actBtn);
    row.appendChild(disBtn);
    body.appendChild(row);
  } else if (outcome === "stopped") {
    addMsg("SYSTEM", "Planning stopped. Nothing was changed.");
  }
  notifyDone("Plan finished",
    "The planning run ended (" + outcome + ").", planT0);
}

async function openAgentReview(review) {
  const staged = review.staged;
  const deletions = review.deletions || new Set();
  const checkpoints = review.checkpoints || [];
  const todos = review.todos || [];
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
  const approvedDel = new Set(deletions);
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "dim";
  head.textContent = "Before anything is applied, the original " +
    "files are saved as a checkpoint you can restore later " +
    "(Chat options: Checkpoints).";
  box.appendChild(head);
  const applyRow = document.createElement("div");
  applyRow.className = "findRow";
  const rejectRow = document.createElement("div");
  rejectRow.className = "findRow";
  rejectRow.textContent = "✖ Reject all - write nothing";
  rejectRow.onclick = () => {
    $("todoPanel").classList.add("hidden");
    addMsg("SYSTEM", "Agent changes rejected - nothing was " +
      "written.");
  };
  function refreshApply() {
    applyRow.textContent = "✓ Apply approved (" +
      approved.size + " of " + staged.size + " file(s)" +
      (deletions.size ? ", " + approvedDel.size + " of " +
        deletions.size + " deletion(s)" : "") + ")";
  }
  applyRow.onclick = async () => {
    $("todoPanel").classList.add("hidden");
    const originals = {};
    const deletedOriginals = {};
    async function originalOf(p) {
      try {
        const r = await fetch("/api/file?path=" +
          encodeURIComponent(p));
        const d = await r.json();
        return d.error ? null : d.content;
      } catch (e) { return null; }
    }
    for (const p of approved) originals[p] = await originalOf(p);
    for (const p of approvedDel)
      deletedOriginals[p] = await originalOf(p);
    let ckptPath = "";
    if (approved.size || approvedDel.size) {
      ckptPath = checkpointFileName(new Date());
      const payload = buildDiskCheckpoint(review.task || "",
        originals, deletedOriginals);
      const cd = await postJson("/api/file",
        { path: ckptPath, content: JSON.stringify(payload) });
      if (!cd.error) {
        const idx = ckptIndexLoad();
        idx.unshift({ path: ckptPath, created: payload.created,
          task: payload.task,
          files: Object.keys(originals)
            .concat(Object.keys(deletedOriginals)) });
        ckptIndexSave(idx);
      } else ckptPath = "";
    }
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
    let nd = 0;
    for (const p of approvedDel) {
      const d = await postJson("/api/file/delete", { path: p });
      if (d && !d.error) nd++;
    }
    loadFiles();
    addMsg("SYSTEM", "Agent changes applied: " + n +
      " file(s) saved" + (nd ? ", " + nd + " deleted" : "") +
      (ckptPath ? ". Undo point saved: " + ckptPath +
        " (Chat options: Checkpoints)." : "."));
  };
  refreshApply();
  box.appendChild(applyRow);
  box.appendChild(rejectRow);
  if (checkpoints.length) {
    const cpHead = document.createElement("div");
    cpHead.className = "dim";
    cpHead.textContent = "⛉ Checkpoints from this task - " +
      "restore rolls the STAGED changes back to that step " +
      "(nothing on disk changes until you apply):";
    box.appendChild(cpHead);
    for (const cp of checkpoints) {
      const row = document.createElement("div");
      row.className = "findRow";
      row.textContent = "⛉ #" + cp.n + " step " + cp.step +
        ": " + cp.label + " - tap to restore staged state";
      row.onclick = () => {
        const restored = makeAgentCheckpoint(cp.n, cp.label,
          cp.step, cp.staged, cp.deletions, cp.todos);
        openAgentReview({
          staged: new Map(Object.entries(restored.staged)),
          deletions: new Set(restored.deletions),
          checkpoints, todos: restored.todos,
          task: review.task });
        addMsg("SYSTEM", "Staged state restored to " +
          "checkpoint #" + cp.n + " (" + cp.label + ").");
      };
      box.appendChild(row);
    }
  }
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
  for (const p of deletions) {
    const row = document.createElement("div");
    row.className = "findRow";
    function dlabel() {
      row.textContent = (approvedDel.has(p) ? "☑ " : "☐ ") +
        "🗑 delete " + p;
    }
    dlabel();
    row.onclick = () => {
      if (approvedDel.has(p)) approvedDel.delete(p);
      else approvedDel.add(p);
      dlabel();
      refreshApply();
    };
    box.appendChild(row);
  }
}

async function restoreDiskCheckpoint(entry) {
  const r = await fetch("/api/file?path=" +
    encodeURIComponent(entry.path));
  const d = await r.json();
  if (d.error || !d.content) {
    addMsg("SYSTEM", "Checkpoint file is missing: " + entry.path);
    return;
  }
  let payload = null;
  try { payload = JSON.parse(d.content); } catch (e) {}
  if (!payload || payload.kind !== "ghostide-checkpoint") {
    addMsg("SYSTEM", "That file is not a GhostIDE checkpoint.");
    return;
  }
  let n = 0;
  for (const [p, content] of Object.entries(payload.files || {})) {
    if (content == null) {
      const dd = await postJson("/api/file/delete", { path: p });
      if (dd && !dd.error) n++;
    } else {
      const wd = await postJson("/api/file", { path: p, content });
      if (!wd.error) n++;
    }
  }
  for (const [p, content] of Object.entries(payload.deleted || {})) {
    if (content != null) {
      const wd = await postJson("/api/file", { path: p, content });
      if (!wd.error) n++;
    }
  }
  loadFiles();
  if (currentFile) await reloadCurrentFromDisk();
  addMsg("SYSTEM", "Checkpoint restored: " + n +
    " file(s) returned to their pre-apply state (" +
    (payload.task || "agent task") + ").");
}

function openCheckpointsPanel() {
  $("todoTitle").textContent = "🗂 Agent checkpoints";
  const box = $("todoResults");
  box.innerHTML = "";
  const idx = ckptIndexLoad();
  if (!idx.length) {
    const el = document.createElement("div");
    el.className = "dim";
    el.textContent = "No checkpoints yet. One is saved " +
      "automatically before each approved agent apply.";
    box.appendChild(el);
  }
  for (const entry of idx) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "⛉ " + (entry.created || "") + " - " +
      (entry.task || "agent task") + " (" +
      (entry.files || []).length + " file(s))";
    box.appendChild(row);
    const rrow = document.createElement("div");
    rrow.className = "findRow";
    rrow.textContent = "   ↩ Restore this checkpoint";
    rrow.onclick = async () => {
      $("todoPanel").classList.add("hidden");
      await restoreDiskCheckpoint(entry);
    };
    box.appendChild(rrow);
    const drow = document.createElement("div");
    drow.className = "findRow";
    drow.textContent = "   ✖ Forget this checkpoint";
    drow.onclick = () => {
      ckptIndexSave(ckptIndexLoad().filter((x) =>
        x.path !== entry.path));
      openCheckpointsPanel();
    };
    box.appendChild(drow);
  }
  $("todoPanel").classList.remove("hidden");
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
  const fixT0 = Date.now();
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
    if (thermalWatchdog() === "stop") {
      note("🌡 Stopped: the device reached severe heat. " +
        "(Thermal guard.)");
      agentStop = true;
    }
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
  notifyDone("Fix-my-tests finished", verdict, fixT0);
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

/* ---------------- Roadmap G32: verify pipeline ---------- */
$("toolVerify").onclick = async () => {
  hideTools();
  $("runPane").classList.remove("hidden");
  $("runTitle").textContent = "Verifying project…";
  $("runOut").textContent =
    "Running syntax checks, tests and the slice report…";
  const d = await postJson("/api/verify/run", {});
  if (d.error) {
    $("runTitle").textContent = "Verify unavailable";
    $("runOut").textContent = d.error;
    return;
  }
  $("runTitle").textContent = "Verify: " + d.evidence.level +
    " · " + d.checks.checked + " checked, " +
    d.checks.problems.length + " problem(s) · tests " +
    d.tests.passed + "/" + d.tests.total + " passed";
  $("runOut").textContent = d.report;
  loadFiles();
};

/* ---------------- Roadmap G33: big-screen mode -------- */
function applyBigScreen(on) {
  document.body.classList.toggle("bigscreen", on);
  try { localStorage.setItem("ghostide-bigscreen",
    on ? "1" : "0"); } catch (e) {}
}
$("toolBigscreen").onclick = () => {
  hideTools();
  applyBigScreen(
    !document.body.classList.contains("bigscreen"));
};
$("toolKeys").onclick = () => {
  hideTools();
  $("keysPanel").classList.remove("hidden");
};
$("keysClose").onclick = () =>
  $("keysPanel").classList.add("hidden");

function paneDrag(handle, target, side) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = target.getBoundingClientRect().width;
    const move = (ev) => {
      let w = side === "left"
        ? startW + (ev.clientX - startX)
        : startW - (ev.clientX - startX);
      w = Math.max(150, Math.min(560, w));
      target.style.width = w + "px";
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("ghostide-panes", JSON.stringify({
          files: $("files").style.width || "",
          chat: $("chat").style.width || "",
        }));
      } catch (err) {}
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
}
paneDrag($("dragFiles"), $("files"), "left");
paneDrag($("dragChat"), $("chat"), "right");
(function restorePanes() {
  try {
    const p = JSON.parse(
      localStorage.getItem("ghostide-panes") || "{}");
    if (p.files) $("files").style.width = p.files;
    if (p.chat) $("chat").style.width = p.chat;
    const bs = localStorage.getItem("ghostide-bigscreen");
    if (bs === "1") document.body.classList.add("bigscreen");
    else if (bs === null && window.innerWidth >= 1280)
      document.body.classList.add("bigscreen");
  } catch (e) {}
})();

/* A hardware keyboard announces itself with modifier-key
   chords a touchscreen never sends; when one pairs, offer
   the shortcut map on screen. */
let kbSeen = false;
document.addEventListener("keydown", (e) => {
  if (kbSeen) return;
  if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
  kbSeen = true;
  try {
    if (window.matchMedia("(pointer: fine)").matches ||
        window.innerWidth >= 900)
      $("kbChip").classList.remove("hidden");
  } catch (err) {}
});
$("kbChip").onclick = () => {
  $("kbChip").classList.add("hidden");
  $("keysPanel").classList.remove("hidden");
};

/* ---------------- Roadmap G34: app-state carry -------- */
/*@@STATE@@*/
/* Everything that is yours in the app lives in localStorage
   under the ghostide- prefix: settings, snippets, bookmarks,
   breakpoints, macros, error memory, API history, pair
   identity, pane layout and the open-tabs session. Chat
   transcripts are not stored anywhere (they end with the
   session) and file-history snapshots live with the project,
   so neither is in the carry file. Enumeration is by prefix,
   so state added later carries automatically. */
function stateCollect(storage) {
  const entries = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith("ghostide-"))
      entries[k] = storage.getItem(k);
  }
  return {
    app: "ghostide", kind: "app-state", version: 1,
    exportedAt: new Date().toISOString(), entries,
  };
}
function stateValidate(obj) {
  if (!obj || typeof obj !== "object")
    return "not a state file (no JSON object)";
  if (obj.app !== "ghostide" || obj.kind !== "app-state")
    return "not a GhostIDE app-state file";
  if (!obj.entries || typeof obj.entries !== "object")
    return "state file has no entries";
  const keys = Object.keys(obj.entries);
  if (!keys.length) return "state file is empty";
  for (const k of keys) {
    if (!k.startsWith("ghostide-"))
      return "entry key outside the app namespace: " + k;
    if (typeof obj.entries[k] !== "string")
      return "entry is not a string: " + k;
  }
  return null;
}
function stateApply(storage, obj) {
  let n = 0;
  for (const k of Object.keys(obj.entries)) {
    storage.setItem(k, obj.entries[k]);
    n++;
  }
  return n;
}
try {
  window.__ghostState = { stateCollect, stateValidate,
    stateApply };
} catch (e) {}
/*@@STATE-END@@*/

$("toolStateExport").onclick = async () => {
  hideTools();
  const data = stateCollect(localStorage);
  const text = JSON.stringify(data, null, 1);
  const r = await postJson("/api/file", {
    path: "ghostide-state.json", content: text });
  $("runPane").classList.remove("hidden");
  if (r.error) {
    $("runTitle").textContent = "Export failed";
    $("runOut").textContent = r.error;
    return;
  }
  const n = Object.keys(data.entries).length;
  $("runTitle").textContent = "App state exported";
  $("runOut").textContent =
    "Wrote ghostide-state.json (" + n + " entries, " +
    text.length + " bytes) to the workspace root.\n" +
    "Carry it to the new device, put it in that workspace, " +
    "then Tools -> Import app state. It restores settings, " +
    "snippets, bookmarks, breakpoints, macros, error " +
    "memory, API history, pairing and layout.";
  loadFiles();
};
$("toolStateImport").onclick = async () => {
  hideTools();
  const d = await getJson("/api/file?path=" +
    encodeURIComponent("ghostide-state.json"));
  $("runPane").classList.remove("hidden");
  if (d.error) {
    $("runTitle").textContent = "No state file found";
    $("runOut").textContent =
      "Put ghostide-state.json in this workspace first " +
      "(export it from the old device). " + d.error;
    return;
  }
  let obj;
  try { obj = JSON.parse(d.content); }
  catch (e) {
    $("runTitle").textContent = "State file unreadable";
    $("runOut").textContent = "ghostide-state.json is not JSON.";
    return;
  }
  const bad = stateValidate(obj);
  if (bad) {
    $("runTitle").textContent = "Import refused";
    $("runOut").textContent = bad;
    return;
  }
  const n = Object.keys(obj.entries).length;
  if (!confirm("Restore " + n + " app-state entries from " +
      (obj.exportedAt || "an unknown date") +
      "? This replaces those settings on this device, " +
      "then the app reloads."))
    return;
  const applied = stateApply(localStorage, obj);
  $("runTitle").textContent = "State restored";
  $("runOut").textContent = applied +
    " entries restored. Reloading…";
  setTimeout(() => location.reload(), 700);
};

/* ---------------- Roadmap G35: companion touches ------ */
/*@@PING@@*/
/* Long AI jobs ping you when they finish instead of ending
   on a dead screen: a native notification on the phone
   (GhostNative bridge), a web Notification on desktop,
   and a title flash when the page is in the background.
   Only jobs that ran at least 20 seconds ping. */
const PING_MIN_MS = 20000;
function pingWorthIt(startedAt, now, enabled) {
  return !!enabled && typeof startedAt === "number" &&
    (now - startedAt) >= PING_MIN_MS;
}
try { window.__ghostPing = { pingWorthIt, PING_MIN_MS }; }
catch (e) {}
/*@@PING-END@@*/

function notifyEnabled() {
  try { return localStorage.getItem("ghostide-notify")
    !== "0"; } catch (e) { return true; }
}
function flashTitle(text) {
  const old = document.title;
  document.title = "✓ " + text;
  const clear = () => {
    document.title = old;
    window.removeEventListener("focus", clear);
    document.removeEventListener("visibilitychange", clear);
  };
  window.addEventListener("focus", clear);
  document.addEventListener("visibilitychange", clear);
}
function notifyDone(title, body, startedAt) {
  if (!pingWorthIt(startedAt, Date.now(), notifyEnabled()))
    return;
  playNotifySound();
  if (document.hidden) flashTitle(title);
  try {
    if (window.GhostNative) {
      window.GhostNative.jobDone(title, body);
      return;
    }
  } catch (e) {}
  try {
    if ("Notification" in window &&
        Notification.permission === "granted")
      new Notification(title, { body });
  } catch (e) {}
}
function refreshNotifyBtn() {
  $("toolNotify").textContent = "Completion ping: " +
    (notifyEnabled() ? "on" : "off");
}
$("toolNotify").onclick = () => {
  const on = !notifyEnabled();
  try { localStorage.setItem("ghostide-notify",
    on ? "1" : "0"); } catch (e) {}
  if (on && "Notification" in window &&
      Notification.permission === "default")
    Notification.requestPermission().catch(() => {});
  refreshNotifyBtn();
};
refreshNotifyBtn();

/* A note shared into the app from another app (Android
   share sheet) lands in captures.md; the native side calls
   this so the file list and any open view refresh. */
window.__ghostCaptured = () => {
  loadFiles();
  $("runPane").classList.remove("hidden");
  $("runTitle").textContent = "Captured to project";
  $("runOut").textContent =
    "A shared note was added to captures.md in this workspace.";
};

/* ---------------- Roadmap G37: registry --------------- */
/*@@ED@@*/
/* Signed packs. The publisher (tools/pack.py on the
   desktop) signs packs with the studio Ed25519 key; the
   IDE verifies with the public key below using a compact
   BigInt Ed25519 verifier, cross-checked against both the
   Python signer and Node's native implementation. A pack
   whose signature fails is refused, full stop. */
const STUDIO_PUBKEY =
  "3100f973903b78380251c359db21ecd9a7543bfe4579a122ad1b0c1b5a2b880e";
const EDQ = (1n << 255n) - 19n;
const EDL = (1n << 252n) +
  27742317777372353535851937790883648493n;
function edMod(a) { const r = a % EDQ; return r >= 0n ? r : r + EDQ; }
function edPow(b, e) {
  let r = 1n, x = edMod(b);
  while (e > 0n) {
    if (e & 1n) r = r * x % EDQ;
    x = x * x % EDQ; e >>= 1n;
  }
  return r;
}
function edInv(x) { return edPow(x, EDQ - 2n); }
const EDD = edMod(-121665n * edInv(121666n));
const EDI = edPow(2n, (EDQ - 1n) / 4n);
function edXrecover(y) {
  const xx = edMod((y * y - 1n) *
    edInv(edMod(EDD * y * y + 1n)));
  let x = edPow(xx, (EDQ + 3n) / 8n);
  if (edMod(x * x - xx) !== 0n) x = edMod(x * EDI);
  if (x % 2n !== 0n) x = EDQ - x;
  return x;
}
const EDB = [edXrecover(edMod(4n * edInv(5n))),
  edMod(4n * edInv(5n))];
function edAdd(P, Q) {
  const t = edMod(EDD * P[0] * Q[0] * P[1] * Q[1]);
  return [
    edMod((P[0] * Q[1] + Q[0] * P[1]) * edInv(edMod(1n + t))),
    edMod((P[1] * Q[1] + P[0] * Q[0]) * edInv(edMod(1n - t)))];
}
function edMul(P, e) {
  let R = [0n, 1n], Q = P;
  while (e > 0n) {
    if (e & 1n) R = edAdd(R, Q);
    Q = edAdd(Q, Q); e >>= 1n;
  }
  return R;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function edDecodeInt(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--)
    n = (n << 8n) | BigInt(bytes[i]);
  return n;
}
function edDecodePoint(bytes) {
  let y = edDecodeInt(bytes);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  let x = edXrecover(y);
  if ((x & 1n) !== sign) x = EDQ - x;
  return [x, y];
}
async function edSha(bytes, alg) {
  const h = await crypto.subtle.digest(alg, bytes);
  return new Uint8Array(h);
}
async function edVerify(pubHex, sigHex, msgBytes) {
  try {
    const pub = hexToBytes(pubHex), sig = hexToBytes(sigHex);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const R = edDecodePoint(sig.slice(0, 32));
    const A = edDecodePoint(pub);
    const S = edDecodeInt(sig.slice(32));
    if (S >= EDL) return false;
    const joined = new Uint8Array(64 + msgBytes.length);
    joined.set(sig.slice(0, 32), 0);
    joined.set(pub, 32);
    joined.set(msgBytes, 64);
    const h = edDecodeInt(await edSha(joined, "SHA-512"));
    const left = edMul(EDB, S);
    const right = edAdd(R, edMul(A, h));
    return left[0] === right[0] && left[1] === right[1];
  } catch (e) { return false; }
}
async function sha256hex(text) {
  const h = await edSha(
    new TextEncoder().encode(text), "SHA-256");
  return [...h].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
/* The canonical string a signature covers. Must match
   tools/pack.py byte for byte. */
async function packCanonical(pack) {
  const lines = ["ghostpack-v1", pack.type, pack.id,
    pack.version];
  const entries = [];
  for (const rel of Object.keys(pack.files || {}).sort())
    entries.push(rel + "\n" +
      (await sha256hex(pack.files[rel])));
  return lines.join("\n") + "\n" + entries.join("\n");
}
function packValidate(pack) {
  if (!pack || typeof pack !== "object")
    return "not a pack (no JSON object)";
  if (pack.app !== "ghostide" || pack.kind !== "ghostpack")
    return "not a GhostIDE pack";
  if (!["plugin", "template"].includes(pack.type))
    return "unknown pack type: " + pack.type;
  if (!pack.id || !/^[a-z0-9][a-z0-9-]*$/.test(pack.id))
    return "pack id is missing or unsafe";
  if (!pack.files || typeof pack.files !== "object" ||
      !Object.keys(pack.files).length)
    return "pack has no files";
  for (const rel of Object.keys(pack.files)) {
    if (rel.startsWith("/") || rel.includes(".."))
      return "unsafe path in pack: " + rel;
    if (typeof pack.files[rel] !== "string")
      return "pack file is not text: " + rel;
  }
  if (!pack.signature ||
      !/^[0-9a-f]{128}$/.test(pack.signature))
    return "pack is unsigned";
  return null;
}
async function packVerify(pack) {
  const bad = packValidate(pack);
  if (bad) return bad;
  const canon = await packCanonical(pack);
  const ok = await edVerify(STUDIO_PUBKEY, pack.signature,
    new TextEncoder().encode(canon));
  return ok ? null : "SIGNATURE INVALID - refused";
}
try {
  window.__ghostEd = { edVerify, packCanonical,
    packValidate, packVerify, STUDIO_PUBKEY };
} catch (e) {}
/*@@ED-END@@*/

function packsInstalled() {
  try {
    return JSON.parse(
      localStorage.getItem("ghostide-packs") || "{}");
  } catch (e) { return {}; }
}
function packsSetInstalled(map) {
  localStorage.setItem("ghostide-packs",
    JSON.stringify(map));
}
function userTemplates() {
  try {
    return JSON.parse(localStorage.getItem(
      "ghostide-user-templates") || "[]");
  } catch (e) { return []; }
}

async function installPack(pack) {
  const bad = await packVerify(pack);
  if (bad) return bad;
  const written = [];
  if (pack.type === "plugin") {
    for (const rel of Object.keys(pack.files).sort()) {
      const path = "plugins/" + pack.id + "/" + rel;
      const r = await postJson("/api/file",
        { path, content: pack.files[rel] });
      if (r.error) return "write failed at " + path +
        ": " + r.error;
      written.push(path);
    }
    await discoverPlugins();
  } else {
    const tpl = pack.template || {};
    const entry = {
      id: pack.id,
      label: tpl.label || pack.name,
      blurb: tpl.blurb || pack.description || "",
      main: tpl.main || "",
      starter: tpl.starter || "",
      files: Object.keys(pack.files).sort()
        .map((rel) => [rel, pack.files[rel]]),
    };
    const list = userTemplates()
      .filter((t) => t.id !== pack.id);
    list.push(entry);
    localStorage.setItem("ghostide-user-templates",
      JSON.stringify(list));
  }
  const map = packsInstalled();
  map[pack.id] = { type: pack.type, version: pack.version,
    name: pack.name, files: written };
  packsSetInstalled(map);
  return null;
}

async function uninstallPack(id) {
  const map = packsInstalled();
  const rec = map[id];
  if (!rec) return "not installed";
  if (rec.type === "plugin") {
    const d = await postJson("/api/file/delete",
      { path: "plugins/" + id });
    if (d.error) return d.error;
    await discoverPlugins();
  } else {
    localStorage.setItem("ghostide-user-templates",
      JSON.stringify(userTemplates()
        .filter((t) => t.id !== id)));
  }
  delete map[id];
  packsSetInstalled(map);
  return null;
}

async function openRegistry() {
  hideTools();
  $("todoTitle").textContent = "📚 Registry - Ghost Developer Studio shelf";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Loading the shelf…</div>';
  $("todoPanel").classList.remove("hidden");
  let reg = null;
  try {
    const own = await getJson("/api/file?path=" +
      encodeURIComponent(".ghostide/registry.json"));
    if (!own.error) reg = JSON.parse(own.content);
  } catch (e) { /* fall through to the bundled shelf */ }
  if (!reg) {
    try {
      const r = await fetch("packs/registry.json");
      reg = await r.json();
    } catch (e) { /* handled below */ }
  }
  if (!reg || !Array.isArray(reg.packs)) {
    box.innerHTML = '<div class="findRow">No registry ' +
      "found. The bundled shelf ships with the app; a " +
      "workspace can override it with " +
      ".ghostide/registry.json.</div>";
    return;
  }
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "dim";
  head.textContent = (reg.shelf || "Registry") + " - " +
    "every pack is signature-checked against the studio " +
    "key before anything is written.";
  box.appendChild(head);
  const installed = packsInstalled();
  for (const entry of reg.packs) {
    const row = document.createElement("div");
    row.className = "findRow";
    const have = installed[entry.id];
    const label = document.createElement("span");
    label.textContent = (entry.type === "plugin"
      ? "🧩 " : "📁 ") + entry.name + " v" + entry.version +
      " - " + entry.description +
      (have ? " (installed)" : "");
    row.appendChild(label);
    const btn = document.createElement("button");
    btn.textContent = have ? "Uninstall" : "Install";
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (have) {
        const err = await uninstallPack(entry.id);
        if (err) { alert(err); return; }
        openRegistry();
        return;
      }
      btn.textContent = "Verifying…";
      let pack;
      try {
        const r = await fetch("packs/" + entry.pack);
        pack = await r.json();
      } catch (e) {
        alert("Could not load " + entry.pack);
        openRegistry();
        return;
      }
      const err = await installPack(pack);
      if (err) { alert("Install refused: " + err); }
      openRegistry();
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
}
$("toolRegistry").onclick = openRegistry;

/* ---------------- Roadmap G38: classroom view --------- */
/*@@CLASS@@*/
/* The host publishes snapshots of its session; viewers on
   the LAN follow read-only and can annotate. The snapshot
   is capped so a huge file or chat cannot flood viewers. */
function buildSnapshot(file, content, historyArr) {
  const who = { user: "YOU", assistant: "GHOST",
    system: "SYSTEM" };
  const chat = (historyArr || []).slice(-12).map((m) => ({
    who: who[m.role] || "GHOST",
    text: String(m.content || "").slice(0, 1500),
  }));
  return {
    file: file || "",
    content: String(content || "").slice(0, 200000),
    chat,
  };
}
try { window.__ghostClass = { buildSnapshot }; } catch (e) {}
/*@@CLASS-END@@*/

let classHost = null, classCode = null;
let classTimer = null, classNoteTimer = null;
let classNotesEl = null;

async function publishClassroom() {
  if (!classHost) return;
  let content = "";
  try { content = view.state.doc.toString(); } catch (e) {}
  const snap = buildSnapshot(currentFile || "", content,
    history);
  postJson("/api/classroom/publish",
    { host: classHost, state: snap });
}

async function refreshClassNotes() {
  const el = classNotesEl;
  if (!el || !classHost) return;
  const d = await getJson("/api/classroom/annotations?host=" +
    encodeURIComponent(classHost));
  if (d.error) return;
  el.textContent = "";
  if (!d.annotations.length) {
    el.textContent = "No annotations yet.";
    return;
  }
  for (const a of d.annotations) {
    const div = document.createElement("div");
    div.className = "findRow";
    div.textContent = "✎ " + a.name +
      (a.line ? " · line " + a.line : "") + ": " + a.text;
    el.appendChild(div);
  }
}

function renderClassPanel(info) {
  const box = $("todoResults");
  box.textContent = "";
  if (!classHost) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "▶ Start sharing this session " +
      "(read-only for viewers)";
    row.onclick = async () => {
      const d = await postJson("/api/classroom/start", {});
      if (d.error) { alert(d.error); return; }
      classHost = d.host;
      classCode = d.code;
      publishClassroom();
      classTimer = setInterval(publishClassroom, 450);
      classNoteTimer = setInterval(refreshClassNotes, 2000);
      renderClassPanel(d.info);
    };
    box.appendChild(row);
    const hint = document.createElement("div");
    hint.className = "dim";
    hint.textContent = "Viewers on the same Wi-Fi open " +
      "the classroom page, type the class code, and follow " +
      "your code and chat live. They cannot edit; they " +
      "can send notes.";
    box.appendChild(hint);
    return;
  }
  const head = document.createElement("div");
  head.className = "findRow";
  const urls = (info && info.urls) || [];
  head.textContent = "● Sharing - class code: " + classCode +
    (urls.length ? " - viewers: " + urls.join(", ")
      : " - viewers on this device: /classroom.html");
  box.appendChild(head);
  if (info && info.bound === "127.0.0.1") {
    const warn = document.createElement("div");
    warn.className = "dim";
    warn.textContent = "This server is bound to this " +
      "device only. Viewers on other devices need the " +
      "desktop hosting in LAN mode (start-lan).";
    box.appendChild(warn);
  }
  const notesTitle = document.createElement("div");
  notesTitle.className = "dim";
  notesTitle.textContent = "Annotations from viewers:";
  box.appendChild(notesTitle);
  const notes = document.createElement("div");
  notes.textContent = "No annotations yet.";
  box.appendChild(notes);
  classNotesEl = notes;
  const clear = document.createElement("div");
  clear.className = "findRow";
  clear.textContent = "🧹 Clear annotations";
  clear.onclick = async () => {
    await postJson("/api/classroom/clear", { host: classHost });
    refreshClassNotes();
  };
  box.appendChild(clear);
  const stop = document.createElement("div");
  stop.className = "findRow";
  stop.textContent = "⏹ Stop sharing";
  stop.onclick = async () => {
    await postJson("/api/classroom/stop", { host: classHost });
    classHost = null;
    classCode = null;
    if (classTimer) clearInterval(classTimer);
    if (classNoteTimer) clearInterval(classNoteTimer);
    renderClassPanel(null);
  };
  box.appendChild(stop);
  refreshClassNotes();
}

function openClassroom() {
  hideTools();
  $("todoTitle").textContent = "🎓 Classroom view";
  $("todoPanel").classList.remove("hidden");
  if (classHost) {
    getJson("/api/classroom/info").then((info) =>
      renderClassPanel(info));
  } else renderClassPanel(null);
}
$("toolClassroom").onclick = openClassroom;

/* ---------------- Roadmap G39: first-run tour --------- */
/*@@TOUR@@*/
/* A 3-minute interactive tour inside a sample project.
   It teaches by doing: run, break, fix with Ghost,
   restore from history. Every step is verified by its
   outcome (a clean run, the error appearing, the fix
   landing, the deleted line coming back), not by the
   user claiming they did it. */
const TOUR_FILE = "tour/hello.py";
const TOUR_ORIGINAL =
  "# GhostIDE tour project. A tiny script we will run,\n" +
  "# break, fix with Ghost, and restore from history.\n" +
  "def add(a, b):\n" +
  "    return a + b\n" +
  "\n" +
  "\n" +
  "def main():\n" +
  "    total = add(2, 3)\n" +
  "    print(\"2 + 3 =\", total)\n" +
  "    print(\"Hello from your first GhostIDE run.\")\n" +
  "\n" +
  "\n" +
  "main()\n";
const TOUR_STEPS = [
  { id: "open", title: "Open the tour file",
    text: "Welcome to GhostIDE. This short tour teaches " +
      "the four moves that matter: run, break, fix with " +
      "Ghost, and restore from history. First, open " +
      "tour/hello.py from the Files list." },
  { id: "run", title: "Move 1: Run",
    text: "Tap ▶ Run at the top. The code runs right " +
      "here, on this device, nothing uploaded. Watch " +
      "the output pane." },
  { id: "break", title: "Move 2: Break it",
    text: "Break it on purpose. In add(), change " +
      "\"return a + b\" to \"return a + c\", then save " +
      "(Ctrl/⌘ S)." },
  { id: "error", title: "See the error",
    text: "Run it again. It should fail with a " +
      "NameError. That output is useful: Ghost remembers " +
      "errors and their fixes (Tools → Error memory)." },
  { id: "fix", title: "Move 3: Fix with Ghost",
    text: "Now fix it with Ghost's help: select the " +
      "broken line and use the inline AI fix, or ask in " +
      "chat: \"fix the NameError in tour/hello.py\". " +
      "Then Run until it passes again." },
  { id: "restore-break", title: "Move 4: Restore (setup)",
    text: "Last move: history. Delete the main() line " +
      "at the very bottom of the file, and save." },
  { id: "restored", title: "Move 4: Restore",
    text: "Open Tools → Local history, choose the " +
      "snapshot from before the deletion, and restore " +
      "it. The main() call should come back." },
  { id: "done", title: "You have the moves",
    text: "That is the whole loop: run it, break it, " +
      "let Ghost help fix it, and rewind with history " +
      "when anything goes wrong. The sample stays in " +
      "tour/ if you want to play more." },
];
function tourStepDone(stepId, ctx) {
  const hasCall = /(^|\n)main\(\)/.test(ctx.content || "");
  switch (stepId) {
    case "open": return ctx.file === TOUR_FILE;
    case "run": return !!ctx.lastRun &&
      ctx.lastRun.file === TOUR_FILE &&
      ctx.lastRun.code === 0;
    case "break": return (ctx.content || "")
      .includes("a + c");
    case "error": return !!ctx.lastRun &&
      ctx.lastRun.file === TOUR_FILE &&
      ctx.lastRun.code !== 0 &&
      /NameError/.test(ctx.lastRun.text || "");
    case "fix": return (ctx.content || "")
        .includes("a + b") &&
      !(ctx.content || "").includes("a + c") &&
      !!ctx.lastRun && ctx.lastRun.file === TOUR_FILE &&
      ctx.lastRun.code === 0;
    case "restore-break": return ctx.file === TOUR_FILE &&
      !hasCall;
    case "restored": return !!ctx.sawDelete && hasCall;
    default: return false;
  }
}
try {
  window.__ghostTour = { TOUR_FILE, TOUR_ORIGINAL,
    TOUR_STEPS, tourStepDone };
} catch (e) {}
/*@@TOUR-END@@*/

const tour = { active: false, idx: 0,
  ctx: { file: "", content: "", lastRun: null,
    sawDelete: false }, timer: null };

function tourObserve(ev) {
  if (ev && ev.type === "run") tour.ctx.lastRun = ev;
}
function tourRender() {
  const step = TOUR_STEPS[tour.idx];
  if (!step) return;
  $("tourTitle").textContent = "🎓 " + step.title;
  $("tourStep").textContent = "Step " +
    (tour.idx + 1) + " of " + TOUR_STEPS.length;
  $("tourBody").textContent = step.text;
  $("tourCard").classList.remove("hidden");
}
function tourTick() {
  if (!tour.active) return;
  tour.ctx.file = currentFile || "";
  try { tour.ctx.content = view.state.doc.toString(); }
  catch (e) { tour.ctx.content = ""; }
  const step = TOUR_STEPS[tour.idx];
  if (!step || step.id === "done") return;
  if (tourStepDone(step.id, tour.ctx)) {
    if (step.id === "restore-break")
      tour.ctx.sawDelete = true;
    tour.idx++;
    if (TOUR_STEPS[tour.idx] &&
        TOUR_STEPS[tour.idx].id === "done") {
      try { localStorage.setItem("ghostide-tour-done",
        "1"); } catch (e) {}
    }
    tourRender();
  }
}
async function startTour() {
  hideTools();
  const existing = await getJson("/api/file?path=" +
    encodeURIComponent(TOUR_FILE));
  if (existing.error) {
    await postJson("/api/file", { path: TOUR_FILE,
      content: TOUR_ORIGINAL });
    await postJson("/api/file", {
      path: "tour/README.md",
      content: "# Tour project\n\nhello.py is the " +
        "first-run tour script. Run the tour again any " +
        "time from Tools → Take the tour.\n" });
    loadFiles();
  }
  tour.active = true;
  tour.idx = 0;
  tour.ctx = { file: currentFile || "", content: "",
    lastRun: null, sawDelete: false };
  tourRender();
  if (tour.timer) clearInterval(tour.timer);
  tour.timer = setInterval(tourTick, 900);
}
function endTour() {
  tour.active = false;
  if (tour.timer) clearInterval(tour.timer);
  $("tourCard").classList.add("hidden");
  try { localStorage.setItem("ghostide-tour-done", "1"); }
  catch (e) {}
}
$("toolTour").onclick = startTour;
$("tourExit").onclick = endTour;
$("tourSkip").onclick = () => {
  if (!tour.active) return;
  const step = TOUR_STEPS[tour.idx];
  if (step && step.id === "restore-break")
    tour.ctx.sawDelete = true;
  tour.idx = Math.min(tour.idx + 1, TOUR_STEPS.length - 1);
  tourRender();
};
$("tourChip").onclick = () => {
  $("tourChip").classList.add("hidden");
  startTour();
};
try {
  if (!localStorage.getItem("ghostide-tour-done") &&
      !localStorage.getItem("ghostide-tour-seen")) {
    localStorage.setItem("ghostide-tour-seen", "1");
    $("tourChip").classList.remove("hidden");
  }
} catch (e) {}

/* ---------------- Roadmap G40: 1.0 hardening ---------- */
/*@@THERMAL@@*/
/* Generation thermal guard. Android reports a thermal
   status (0 none .. 6 shutdown) through the GhostNative
   bridge; at LIGHT (3) Ghost warns once per generation,
   at SEVERE (4) it stops the generation to protect the
   device. No bridge (desktop) means no reading and the
   guard stays off, honestly. */
function thermalAction(status) {
  if (typeof status !== "number" || status < 0) return "ok";
  if (status >= 4) return "stop";
  if (status >= 3) return "warn";
  return "ok";
}
function thermalStatus() {
  try {
    if (window.GhostNative &&
        window.GhostNative.thermalStatus)
      return window.GhostNative.thermalStatus();
  } catch (e) {}
  return -1;
}
try { window.__ghostThermal = { thermalAction }; }
catch (e) {}
/*@@THERMAL-END@@*/

let thermalWarned = false;
function thermalWatchdog() {
  const act = thermalAction(thermalStatus());
  if (act === "warn" && !thermalWarned) {
    thermalWarned = true;
    addMsg("SYSTEM", "🌡 The device is getting warm. " +
      "If it reaches severe heat, Ghost will pause " +
      "generation to protect the battery.");
  }
  return act;
}

$("toolEco").onclick = () => { hideTools(); openEco(); };

/* In-app changelog (generated from BUILD_NOTES by
   tools/gen_changelog.py). */
$("toolChangelog").onclick = async () => {
  hideTools();
  $("todoTitle").textContent = "📋 What's new";
  const box = $("todoResults");
  box.innerHTML = '<div class="dim">Loading…</div>';
  $("todoPanel").classList.remove("hidden");
  try {
    const r = await fetch("changelog.json");
    const d = await r.json();
    box.textContent = "";
    for (const e of d.entries || []) {
      const row = document.createElement("div");
      row.className = "findRow";
      row.textContent = "v" + e.version + " · " + e.date +
        " · " + e.goal + " - " + e.summary;
      box.appendChild(row);
    }
    if (!box.children.length)
      box.textContent = "No changelog entries yet.";
  } catch (e) {
    box.textContent = "Changelog unavailable here.";
  }
};

/* Update check that informs without nagging: at most one
   quiet check a day, a small header pill when a newer
   version exists, dismissible per version, and it never
   downloads or installs anything. */
async function quietUpdateCheck() {
  try {
    const last = Number(localStorage.getItem(
      "ghostide-update-check") || 0);
    if (Date.now() - last < 24 * 3600 * 1000) return;
    localStorage.setItem("ghostide-update-check",
      String(Date.now()));
    const r = await fetch("/api/update/check");
    const d = await r.json();
    if (!d.ok || !d.updateAvailable) return;
    if (localStorage.getItem("ghostide-update-dismissed")
        === d.latest) return;
    const pill = $("updatePill");
    pill.textContent = "⬆ v" + d.latest + " available";
    pill.classList.remove("hidden");
    pill.onclick = () => {
      // v2.36: same scheme gate as the Settings
      // update link - remote feed data never
      // becomes a javascript: navigation.
      if (d.url && /^https?:\/\//i.test(d.url))
        window.open(d.url, "_blank", "noopener");
      localStorage.setItem("ghostide-update-dismissed",
        d.latest);
      pill.classList.add("hidden");
    };
  } catch (e) { /* offline or unsupported: stay silent */ }
}
setTimeout(quietUpdateCheck, 5000);

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
    const codeRow = document.createElement("div");
    codeRow.className = "dim";
    box.appendChild(codeRow);
    fetch("/api/pair/code")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        codeRow.textContent = d && d.code
          ? "Pairing code for this host: " + d.code
            + " - a new device enters it once to pair. "
            + "It resets when the server restarts."
          : "This device is a guest here; the pairing "
            + "code is shown on the host.";
      })
      .catch(() => { codeRow.textContent = ""; });
    const pairStateRow = document.createElement("div");
    box.appendChild(pairStateRow);
    if (storedPairToken()) {
      pairStateRow.className = "findRow";
      pairStateRow.textContent = "This device is paired "
        + "with this host"
        + (storedPairRole() === "viewer"
          ? " as a VIEW-ONLY guest (can look, not change)"
          : "")
        + ". Tap to unpair: the stored token is "
        + "forgotten on this device.";
      pairStateRow.onclick = () => {
        try {
          localStorage.removeItem(PAIR_TOKEN_KEY);
          localStorage.removeItem(
            "ghostide-pair-role:" + location.host);
        } catch (e) { /* storage off */ }
        pairStateRow.className = "dim";
        pairStateRow.textContent = "Unpaired. Reload "
          + "and enter the code again to re-pair.";
      };
    } else {
      pairStateRow.className = "dim";
      pairStateRow.textContent = "This device holds no "
        + "pair token for this host. The host's own "
        + "screen never needs one.";
    }
    const pairInfoRow = document.createElement("div");
    pairInfoRow.className = "dim";
    box.appendChild(pairInfoRow);
    fetch("/api/health")
      .then(r => r.ok ? r.json() : null)
      .then(h => {
        if (!h) return;
        pairInfoRow.textContent = "Host build "
          + (h.version || "?") + " - pairing required "
          + "for other devices: "
          + (h.pairRequired ? "yes" : "no")
          + " - backups: format v"
          + ((h.backupFormats || [1]).join(" + v"));
      })
      .catch(() => { pairInfoRow.textContent = ""; });
    const pairPolicyRow = document.createElement("div");
    box.appendChild(pairPolicyRow);
    const renderPolicy = (vo) => {
      pairPolicyRow.className = "findRow";
      pairPolicyRow.textContent = "New guests join as: "
        + (vo ? "VIEW-ONLY" : "editors")
        + " - tap to switch (host only)";
      pairPolicyRow.onclick = async () => {
        const d = await postJson("/api/pair/policy",
          { viewOnly: !vo });
        if (d && !d.error) renderPolicy(!!d.viewOnly);
      };
    };
    fetch("/api/pair/policy")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) renderPolicy(!!d.viewOnly); })
      .catch(() => {});
    const pairRevokeRow = document.createElement("div");
    pairRevokeRow.className = "findRow";
    pairRevokeRow.textContent = "Revoke all guests: "
      + "every paired device must enter the code "
      + "again (host only; tokens also expire on "
      + "their own after 12 hours)";
    pairRevokeRow.onclick = async () => {
      const d = await postJson("/api/pair/revoke", {});
      pairRevokeRow.textContent = (d && d.ok)
        ? "All guests revoked. They will be asked "
          + "for the code on their next request."
        : "Revoke failed: only the host can do this.";
    };
    box.appendChild(pairRevokeRow);
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
      const pw = prompt("Passphrase for this backup:");
      if (!pw) return;
      // R7: preview first - decrypts and validates
      // without touching a file.
      const ins = await postJson("/api/backup/inspect",
        { path: p, passphrase: pw });
      if (ins.error) { alert(ins.error); return; }
      const kb = Math.max(1, Math.round(ins.bytes / 1024));
      if (!confirm("Restore " + p + "?\nBackup from "
          + (ins.created || "unknown date")
          + (ins.appVersion
            ? " - made by GhostIDE " + ins.appVersion : "")
          + " - "
          + ins.files + " files, " + kb + " KB, format v"
          + ins.version + ". Files with the same names "
          + "are overwritten.")) return;
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
  for (const t of userTemplates()) {
    const row = document.createElement("div");
    row.className = "findRow";
    row.textContent = "📚 " + t.label + " - " + t.blurb +
      " (from the registry)";
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
