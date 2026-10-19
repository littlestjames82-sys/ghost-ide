# GhostIDE Plugins

A plugin is a folder in your workspace:

```
plugins/<plugin-id>/
  plugin.json   the manifest
  plugin.js     the code
```

GhostIDE scans that folder when it starts and whenever you
open Tools → Plugins → Manage plugins… Actions from enabled
plugins appear in the Tools panel and the command palette.
Remove deletes the folder for good; Disable keeps the
folder but parks the plugin.

## Manifest

```json
{
  "id": "word-count-pro",
  "name": "Word Count Pro",
  "version": "1.0.0",
  "description": "What it does, in one line.",
  "actions": [
    { "id": "count", "title": "Word count (pro)" }
  ]
}
```

## The ghost API

`plugin.js` runs in a sandboxed iframe (its own origin, no
access to the IDE page) and talks to GhostIDE only through
this API. Everything returns a promise.

```js
ghost.onAction("count", async function () { ... });

ghost.files.list()               // -> [paths]
ghost.files.read(path)           // -> content
ghost.files.write(path, text)    // saves (Local History too)
ghost.editor.current()           // -> { path, content }
ghost.editor.selection()         // -> selected text
ghost.editor.insert(text)        // replace selection / insert
ghost.editor.open(path)
ghost.ask("prompt")              // one-shot local-model reply
ghost.ui.show()                  // show your plugin panel
ghost.ui.hide()
ghost.ui.notify("message")       // posts to the chat log
```

The panel is your own iframe document: build any HTML in
`document.body` and call `ghost.ui.show()` to display it.

Rules of the road:

- File writes stay inside the workspace (the server
  enforces it) and writing the open file requires it to be
  saved first.
- Keep the literal text of a closing `script` tag out of
  `plugin.js`; it would end the sandbox document early.
- The sandbox isolates a plugin from the IDE page and
  confines it to this API. It is not a network sandbox, so
  only install plugins you trust, like any other code you
  run.

## Samples

`plugin-samples/` in this repo holds Word Count Pro and
JSON Toolbox. In the app, Tools → Plugins → Manage
plugins… → "Install the sample plugins" copies them into
your workspace, ready to run and ready to copy as a
starting point for your own.
