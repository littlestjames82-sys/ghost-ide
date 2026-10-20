#!/usr/bin/env python3
"""Generate web/changelog.json from the Android
BUILD_NOTES.md version sections (Roadmap G40: the in-app
changelog). Newest first. Each entry keeps the version,
date, roadmap tag, and the first summary line of its
section. Run after appending a BUILD_NOTES section."""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES = os.path.join(ROOT, "..", "ghostide-apk-build",
                     "BUILD_NOTES.md")
OUT = os.path.join(ROOT, "web", "changelog.json")

HEADER = re.compile(
    r"^## v(\d+\.\d+\.\d+) \(versionCode \d+\) - "
    r"([A-Z][a-z]{2} \d+, \d{4}) - (.+?)\s*$",
    re.M)


def main():
    with open(NOTES, encoding="utf-8") as f:
        text = f.read()
    matches = list(HEADER.finditer(text))
    entries = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() \
            if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        summary = ""
        for line in body.splitlines():
            line = line.strip().lstrip("- ").strip()
            if line:
                summary = line
                break
        entries.append({
            "version": m.group(1),
            "date": m.group(2),
            "goal": m.group(3),
            "summary": summary[:220],
        })
    entries.reverse()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"app": "ghostide", "kind": "changelog",
                   "entries": entries}, f, indent=1)
    print("wrote", OUT, "with", len(entries), "entries;",
          "newest:", entries[0]["version"]
          if entries else "none")


if __name__ == "__main__":
    main()
