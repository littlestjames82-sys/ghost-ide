// JSON Toolbox - a GhostIDE sample plugin.
// Format, minify and validate the current selection,
// or the whole open file.
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

async function target() {
  var sel = await ghost.editor.selection();
  var cur = await ghost.editor.current();
  if (!cur) {
    await ghost.ui.notify("Open a JSON file first.");
    return null;
  }
  var usingSel = !!(sel && sel.trim());
  return {
    cur: cur,
    usingSel: usingSel,
    text: usingSel ? sel : cur.content,
  };
}

async function apply(t, newText) {
  if (t.usingSel) {
    await ghost.editor.insert(newText);
  } else {
    await ghost.files.write(t.cur.path, newText);
  }
}

ghost.onAction("format", async function () {
  var t = await target();
  if (!t) return;
  try {
    var v = JSON.parse(t.text);
    await apply(t, JSON.stringify(v, null, 2));
    await ghost.ui.notify("JSON formatted.");
  } catch (e) {
    await ghost.ui.notify("Invalid JSON: " + e.message);
  }
});

ghost.onAction("minify", async function () {
  var t = await target();
  if (!t) return;
  try {
    var v = JSON.parse(t.text);
    await apply(t, JSON.stringify(v));
    await ghost.ui.notify("JSON minified.");
  } catch (e) {
    await ghost.ui.notify("Invalid JSON: " + e.message);
  }
});

ghost.onAction("validate", async function () {
  var t = await target();
  if (!t) return;
  try {
    JSON.parse(t.text);
    document.body.innerHTML =
      "<h3>JSON Toolbox</h3><p>Valid JSON ✓</p>"
      + "<p class='dim'>" + esc(t.cur.path) + "</p>";
  } catch (e) {
    document.body.innerHTML =
      "<h3>JSON Toolbox</h3><p>Invalid JSON:</p>"
      + "<pre>" + esc(e.message) + "</pre>"
      + "<p class='dim'>" + esc(t.cur.path) + "</p>";
  }
  await ghost.ui.show();
});
