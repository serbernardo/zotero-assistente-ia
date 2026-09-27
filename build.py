#!/usr/bin/env python3
"""Empacota o addon em dist/assistente-ia-<versão>.xpi (Windows, macOS e Linux)."""
import hashlib
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
ADDON = os.path.join(ROOT, "addon")
DIST = os.path.join(ROOT, "dist")
INCLUDE = ["manifest.json", "bootstrap.js", "prefs.js", "content", "locale"]


def main():
    with open(os.path.join(ADDON, "manifest.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, f"assistente-ia-{version}.xpi")
    if os.path.exists(out):
        os.remove(out)
    files = []
    for entry in INCLUDE:
        path = os.path.join(ADDON, entry)
        if os.path.isfile(path):
            files.append(entry)
            continue
        for dirpath, _, names in os.walk(path):
            for name in sorted(names):
                full = os.path.join(dirpath, name)
                files.append(os.path.relpath(full, ADDON).replace(os.sep, "/"))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in sorted(files):
            z.write(os.path.join(ADDON, rel), rel)
    with open(out, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    print(out)
    print(f"{len(files)} ficheiros, sha256: {sha}")


if __name__ == "__main__":
    main()
