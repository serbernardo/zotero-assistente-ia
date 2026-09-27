#!/bin/sh
# Empacota o plugin em dist/assistente-ia-<versão>.xpi (usa o build.py, que funciona em qualquer sistema)
set -e
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then python3 build.py; else python build.py; fi
