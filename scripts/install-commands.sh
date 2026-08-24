#!/bin/bash
# Install memory-bank prompts to user scope ($CODEX_HOME/prompts)
# Runs on SessionStart - idempotent (skips if already installed)

PLUGIN_ROOT="${MEMORY_BANK_PLUGIN_ROOT:-$(dirname "$(dirname "$0")")}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
USER_PROMPTS="$CODEX_HOME_DIR/prompts"

mkdir -p "$USER_PROMPTS"
for cmd in "$PLUGIN_ROOT/commands/"*.md; do
  [ -f "$cmd" ] || continue
  basename="$(basename "$cmd")"
  target="$USER_PROMPTS/memory-bank-$basename"
  if [ ! -f "$target" ] || ! diff -q "$cmd" "$target" >/dev/null 2>&1; then
    cp "$cmd" "$target"
  fi
done
