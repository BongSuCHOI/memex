# Third-party notices

The only third-party source vendored in this repository is inside the committed
MCP server bundle `dist/mcp-server.js`, which `npm run bundle` produces with
esbuild. That file inlines the following packages from `package.json`'s
dependency tree:

- `@modelcontextprotocol/sdk` — MIT
- `ajv` — MIT
- `ajv-formats` — MIT
- `fast-deep-equal` — MIT
- `fast-uri` — BSD-3-Clause
- `json-schema-traverse` — MIT
- `marked` — MIT
- `zod` — MIT
- `zod-to-json-schema` — ISC

The local Web UI (`ui/`) ships only first-party code: no third-party JavaScript
libraries, no bundled fonts, and no CDN or remote asset loads. Its rendering
uses the browser's native WebGL/Canvas APIs. `ui/LICENSE` covers that
directory.

The remaining runtime npm dependencies declared in `package.json` — including
the native modules deliberately kept external to the bundle — are installed by
the package manager and keep their own upstream license notices inside
`node_modules/`; they are not vendored into this repository.

Project attribution and upstream lineage are documented in
[docs/LINEAGE.md](docs/LINEAGE.md).
