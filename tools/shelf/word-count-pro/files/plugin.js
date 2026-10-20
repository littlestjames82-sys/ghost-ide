// Word Count Pro - a GhostIDE sample plugin.
// Counts the current selection, or the whole open file,
// and shows a small report in the plugin panel.
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

ghost.onAction("count", async function () {
  var sel = await ghost.editor.selection();
  var cur = await ghost.editor.current();
  if (!cur) {
    await ghost.ui.notify("Open a file first.");
    return;
  }
  var usingSel = !!(sel && sel.trim());
  var text = usingSel ? sel : cur.content;
  var label = (usingSel ? "selection in " : "") + cur.path;
  var words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
  var freq = {};
  words.forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });
  var top = Object.keys(freq)
    .sort(function (a, b) { return freq[b] - freq[a]; })
    .slice(0, 5);
  var lines = text ? text.split("\n").length : 0;
  var minutes = Math.max(1, Math.round(words.length / 200));
  var topRows = top.map(function (w) {
    return "<tr><td>" + esc(w) + "</td><td>" + freq[w]
      + "</td></tr>";
  }).join("");
  document.body.innerHTML =
    "<h3>Word Count Pro</h3>"
    + "<p class='dim'>" + esc(label) + "</p>"
    + "<table>"
    + "<tr><td>Words</td><td><b>" + words.length
    + "</b></td></tr>"
    + "<tr><td>Characters</td><td><b>" + text.length
    + "</b></td></tr>"
    + "<tr><td>Lines</td><td><b>" + lines + "</b></td></tr>"
    + "<tr><td>Reading time</td><td><b>~" + minutes
    + " min</b></td></tr>"
    + "</table>"
    + "<h4>Top words</h4><table>" + topRows + "</table>";
  await ghost.ui.show();
});
