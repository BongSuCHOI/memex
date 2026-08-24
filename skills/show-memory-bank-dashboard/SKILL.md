---
name: show-memory-bank-dashboard
description: Launch the local Memory Bank dashboard when the user asks to browse or visualize indexed Codex conversations and facts.
---

# Show Memory Bank Dashboard

Resolve `PLUGIN_ROOT` as the plugin root two directories above this skill
directory. The dashboard listens on `127.0.0.1:3847` and reads the normal
Memory Bank data root unless the user supplies an override.

Before starting it, inspect the listener on port 3847. If this Memory Bank
dashboard is already serving, reuse it. If another process owns the port, report
the conflict without terminating that process.

Otherwise start:

```bash
MEMORY_BANK_PLUGIN_ROOT="$PLUGIN_ROOT" node "$PLUGIN_ROOT/ui/server.cjs"
```

Keep the process observable so it can be stopped cleanly. Open
`http://127.0.0.1:3847` only when the user asked to launch or view the
dashboard. Report the URL and the exact process started.
