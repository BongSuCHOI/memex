#!/usr/bin/env node
// Backward-compatible executable name. SessionEnd is now a bounded final
// capture fence; the legacy stabilize -> extract -> consolidate -> export
// foreground chain is intentionally unreachable.
import "./continuity-hook.js";
