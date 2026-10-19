# GhostIDE behavior pack (Phase 3.2)

One source of truth for how GhostIDE's AI behaves, shared by the
desktop IDE and the phone app so the two cannot drift apart.

## The pack

`web/src/behavior.js` - shipped inside the single frontend bundle
both apps run:

- **System prompt** for chat (concise, code-first).
- **Chat**: max tokens per reply (1024).
- **Infill**: prefix/suffix window (3000/1500 chars), max suggestion
  lines (3).
- **Context**: current-file cap (6000 chars), GhostSlice slice
  budget (6000 tokens of the desktop model's 8192 ctx).

User-tunable knobs (temperature, autocomplete on/off, suggestion
length, format-on-save) live in the IDE Settings panel and are NOT
part of the pack - they are preferences, not behavior.

## Mirrored natively (phone)

Two things the Android side owns and must keep in step by hand:

- `IdeServer.CUT_MARKERS` - the ChatML + FIM stop markers the
  on-device engine streams against (`<|im_end|>`, `<|fim_middle|>`,
  ...). These come from the model family's tokenizer conventions,
  not from preference.
- `Models.java` - the model matrix (files, sizes, SHA-256 gates).

## Desktop model

The desktop server proxies to llama.cpp with the same ChatML/FIM
conventions; the system prompt above is what the frontend sends, so
both devices instruct their models identically.
