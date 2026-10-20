# Known issues and honest limits

GhostIDE is a small, local, single-user tool. These are the limits
we know about, stated plainly - most are trade-offs, not surprises.

## Startup crash budget (Roadmap G40, audited at v1.48.0)
- Budget: zero known startup crashers. Status: met.
  The two historical startup killers (a const used in
  its temporal dead zone during editor construction,
  v1.5.0/v1.6.0, and the missing WebView dialog bridge)
  are fixed, and every build now passes an execution
  gate that runs the real bundle in a DOM stub and
  requires it to get past editor construction before
  the APK ships. An in-page error banner also surfaces
  any boot failure instead of a silent dead screen.
- Cold start: the bundle parses and reaches editor
  construction in about 0.42 s in the harness, and the
  desktop server answers health in about 0.19 s. The
  remaining on-device WebView cost is the phone's own.

## Model strength
- The phone models (1.5B / 3B) are small. They write good small
  functions and decent autocomplete; multi-step reasoning is where
  they run out of road. The desktop 7B is the reference experience.
- Answers can be wrong with confidence. There is no cloud model
  checking the work. Run panel + your eyes are the safety net.

## Editor
- No split view yet (tabs, yes). A single-view refactor is the
  blocker, tracked in PLAN.md Phase 2.5.
- Very large files (200 KB+) can make the WebView editor sluggish,
  especially on the phone. Work file-by-file for big artifacts.
- Format on save needs black/ruff/prettier installed on the desktop;
  without one, the IDE says so instead of pretending.

## Context
- Project slices come from GhostSlice estimates (calibrated, not an
  exact tokenizer count). The meter is honest about being an
  estimate; the ctx hard stop uses the same number.
- Slices cover text files up to 512 KB each; binaries and dotfiles
  are skipped.

## Sync and LAN
- LAN sync is whole-workspace overwrite by filename - no merge, no
  conflict detection. Pull/push deliberately, not casually.
- LAN mode has NO authentication. Anyone on the same network who
  can reach the port can read/write the workspace while it runs.
  Trusted networks only; it is off by default.

## Phone build
- arm64-v8a only. Older 32-bit phones cannot load the engine.
- The 3B model wants a phone with ~6 GB RAM or more; on smaller
  phones it may load slowly or be killed by the OS under pressure.
- Android may throttle long generations when the phone gets hot;
  that is the OS protecting the hardware, not a crash.
