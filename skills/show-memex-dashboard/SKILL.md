---
name: show-memex-dashboard
description: Launch or reuse the loopback Memex dashboard when the user asks to browse conversations, manage facts, inspect pipeline health, or explore the 3D knowledge graph.
---

# Show Memex Dashboard

Resolve `PLUGIN_ROOT` as two directories above this skill directory. The default
URL is `http://127.0.0.1:3847`.

Before starting a process, inspect the port owner. Reuse it only when it is the
Memex server for this installed root. If another process owns the port, report
the conflict without terminating it.

Start a new server only when needed:

```bash
node "$PLUGIN_ROOT/cli/runtime-exec.js" memex-ui
```

Keep the process observable for clean shutdown. Open only the route relevant to
the request: `/`, `/facts`, `/pipeline`, or `/graph?scope=global`. For a project
graph, use `/graph?scope=project&project=<encoded-canonical-absolute-cwd>`.

Report the URL and exact process started or reused. Do not install dependencies,
register hooks/plugins, change facts, or expose the server beyond loopback merely
to show the dashboard.
