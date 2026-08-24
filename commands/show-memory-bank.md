---
name: show-memory-bank
description: Launch Memory Bank web dashboard to visualize conversations, facts, and search history
---

# Show Memory Bank Dashboard

Launch the Memory Bank 3D Knowledge Graph with live data.

## Instructions

**Always restart the server** to ensure latest code is served. Translation runs through the local codex CLI (no API key needed):

```bash
kill $(lsof -ti:3847) 2>/dev/null
sleep 1
export MEMORY_BANK_PLUGIN_ROOT="$PWD"   # run inside the memory-bank checkout
node "$MEMORY_BANK_PLUGIN_ROOT/ui/server.cjs" &
sleep 1
open "http://localhost:3847"
```


Report to the user that the dashboard is open at http://localhost:3847.
