# Third-party notices

Moments itself is MIT licensed (see `LICENSE`). It bundles or depends on the following
third-party work. Only the licences below cover that work; the MIT licence of this
repository covers this repository's own code.

## openfig-core

- Package: `openfig-core` (npm), pinned by `package-lock.json`
- Use: reads the Kiwi container of `.fig` / `.jam` / `.deck` files for the Figma importer
  (`lib/fig-import.js`). It is a runtime dependency and is installed with the bundle.
- Licence: MIT
- Upstream: https://github.com/didoo/openfig-core

No Figma application code, Figma assets, fonts or artwork are redistributed here. A user
imports their own file; the plugin only parses it locally.

## DeepSeek Harness

The plugin is designed for DeepSeek Harness and runs inside it. Harness is a separate
project with its own licence; nothing from it is vendored in this repository.
