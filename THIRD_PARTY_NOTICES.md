# Third-party notices

Memex bundles no third-party source or asset files in this repository.

The local Web UI (`ui/`) ships only first-party code: no third-party JavaScript
libraries, no bundled fonts, and no CDN or remote asset loads. Its rendering
uses the browser's native WebGL/Canvas APIs. `ui/LICENSE` covers that
directory.

Runtime npm dependencies declared in `package.json` are installed by the
package manager and keep their own upstream license notices inside
`node_modules/`; they are not vendored into this repository.

Project attribution and upstream lineage are documented in
[docs/LINEAGE.md](docs/LINEAGE.md).
