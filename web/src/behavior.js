/* GhostIDE shared behavior pack (Phase 3.2).
 *
 * ONE source for the behavior both apps ship: the phone app bundles
 * this exact frontend, and the desktop server serves it, so prompts
 * and defaults cannot drift between devices. The native side mirrors
 * the two things it owns: IdeServer.CUT_MARKERS (ChatML + FIM stop
 * markers) and Models.java (sizes/hashes). See BEHAVIOR.md.
 */
export const BEHAVIOR = {
  systemPrompt:
    "You are the coding assistant inside GhostIDE, an offline " +
    "editor. Answer concisely and prefer working code.",
  chat: { maxTokens: 1024 },
  infill: { prefixChars: 3000, suffixChars: 1500, maxLines: 3 },
  context: { fileChars: 6000, sliceBudget: 6000 },
};
