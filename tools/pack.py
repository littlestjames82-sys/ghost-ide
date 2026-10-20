#!/usr/bin/env python3
"""GhostIDE registry pack publisher (Roadmap G37).

Builds signed .ghostpack.json files from pack sources in
tools/shelf/<id>/ (a pack.json describing the pack plus a
files/ folder with its contents) and writes them, plus the
shelf index, into web/packs/.

The signing key lives in tools/studio-key.json (mode 600,
NEVER committed). The matching public key is embedded in
the IDE frontend (STUDIO_PUBKEY) and printed by keygen.

Usage:
  pack.py keygen          create the studio key if missing
  pack.py build           build every pack in tools/shelf/
  pack.py verify <pack>   check a built pack's signature

Canonical string (must match the frontend byte for byte):
  ghostpack-v1\n<type>\n<id>\n<version>\n
  then per file, sorted by path: <relpath>\n<sha256 hex>
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ed25519

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(ROOT, "tools", "studio-key.json")
SHELF_SRC = os.path.join(ROOT, "tools", "shelf")
PACKS_OUT = os.path.join(ROOT, "web", "packs")


def canonical(pack):
    lines = ["ghostpack-v1", pack["type"], pack["id"],
             pack["version"]]
    entries = []
    for rel in sorted(pack["files"].keys()):
        digest = hashlib.sha256(
            pack["files"][rel].encode("utf-8")).hexdigest()
        entries.append(rel + "\n" + digest)
    return "\n".join(lines) + "\n" + "\n".join(entries)


def load_key():
    with open(KEY_PATH) as f:
        return json.load(f)


def keygen():
    if os.path.exists(KEY_PATH):
        k = load_key()
        print("key exists; public:", k["public"])
        return
    seed = os.urandom(32)
    pub = ed25519.publickey(seed)
    with open(KEY_PATH, "w") as f:
        json.dump({"secret": seed.hex(), "public": pub.hex()}, f)
    os.chmod(KEY_PATH, 0o600)
    print("studio key created")
    print("public:", pub.hex())


def build():
    key = load_key()
    seed = bytes.fromhex(key["secret"])
    pub = bytes.fromhex(key["public"])
    os.makedirs(PACKS_OUT, exist_ok=True)
    index = []
    for pid in sorted(os.listdir(SHELF_SRC)):
        src = os.path.join(SHELF_SRC, pid)
        meta_path = os.path.join(src, "pack.json")
        if not os.path.isdir(src) or not os.path.exists(meta_path):
            continue
        with open(meta_path) as f:
            meta = json.load(f)
        files = {}
        fdir = os.path.join(src, "files")
        for dirpath, _dirs, names in os.walk(fdir):
            for name in names:
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, fdir)
                with open(full, encoding="utf-8") as f:
                    files[rel] = f.read()
        pack = {
            "app": "ghostide", "kind": "ghostpack",
            "type": meta["type"], "id": meta["id"],
            "name": meta["name"], "version": meta["version"],
            "description": meta.get("description", ""),
            "author": meta.get("author",
                               "Ghost Developer Studio"),
            "files": files,
        }
        if "template" in meta:
            pack["template"] = meta["template"]
        sig = ed25519.sign(canonical(pack).encode("utf-8"),
                           seed, pub)
        pack["signature"] = sig.hex()
        out = os.path.join(PACKS_OUT, pid + ".ghostpack.json")
        with open(out, "w") as f:
            json.dump(pack, f, indent=1)
        index.append({
            "pack": pid + ".ghostpack.json",
            "type": pack["type"], "id": pack["id"],
            "name": pack["name"], "version": pack["version"],
            "description": pack["description"],
        })
        print("built", out)
    registry = {
        "app": "ghostide", "kind": "registry",
        "shelf": "Ghost Developer Studio",
        "packs": index,
    }
    reg_path = os.path.join(PACKS_OUT, "registry.json")
    with open(reg_path, "w") as f:
        json.dump(registry, f, indent=1)
    print("wrote", reg_path, "with", len(index), "packs")


def verify(path):
    key = load_key()
    pub = bytes.fromhex(key["public"])
    with open(path) as f:
        pack = json.load(f)
    ok = ed25519.verify(bytes.fromhex(pack["signature"]),
                        canonical(pack).encode("utf-8"), pub)
    print(path, "signature", "VALID" if ok else "INVALID")
    return 0 if ok else 1


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "keygen":
        keygen()
    elif cmd == "build":
        build()
    elif cmd == "verify" and len(sys.argv) > 2:
        sys.exit(verify(sys.argv[2]))
    else:
        print(__doc__)
        sys.exit(2)
