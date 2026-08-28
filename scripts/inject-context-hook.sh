#!/usr/bin/env bash
# UserPromptSubmit hook: forward context injection to the existing injector.
# Stdin (hook JSON incl. prompt) is passed through untouched; only PLUGIN_ROOT
# resolution is added so the injector finds repo-relative assets.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MEMEX_PLUGIN_ROOT="$ROOT"
exec node "$ROOT/scripts/inject-context.js"
