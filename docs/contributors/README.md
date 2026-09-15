<!---
SPDX-FileCopyrightText: Copyright 2026 Arm Limited and/or its affiliates <open-source-office@arm.com>
SPDX-License-Identifier: Apache-2.0
--->

# Contributor documentation

## Requirements

- Node.js 20 or newer.
- Visual Studio Code 1.100 or newer.

## Development workflow

1. Install dependencies with `npm install`.
2. Type-check and compile the test build with `npm run compile`.
3. Build the bundled extension entry point with `npm run bundle`.
4. Run the test suite with `npm test`.
5. Open the repository in VS Code and press `F5` to bundle and launch an Extension Development Host.

## Build outputs

The project has separate outputs for testing and distribution:

- `npm run compile` uses TypeScript to emit modules and tests into `out/`. The test suite runs these files directly.
- `npm run bundle` uses esbuild to combine the extension and its runtime dependencies into `dist/extension.js`.
- `npm run package:extension` runs the bundle step and creates the distributable VSIX.

The packaged extension uses `dist/extension.js` as its entry point. Source files, test output, source maps, and `node_modules` are excluded from the VSIX. Dependencies are still installed normally in `node_modules` for local development; bundling only changes the release artifact.

The `F5` launch configuration runs the bundle task before opening the Extension Development Host.

## Private VSIX releases

The same extension supports public and private distributions. For a private
release, populate `resources/python-runtime/wheelhouse/` with the selected
private package wheels before running `npm run package:extension`. Omit this
folder for the normal remote-index distribution. Wheels are ignored by Git but
included in the VSIX; do not add the wheelhouse to `.vscodeignore`.

On environment refresh, the extension detects this directory and adds it as the
first uv flat index in the generated managed-runtime `pyproject.toml`. Under
uv's default `first-index` policy, a package present in the wheelhouse must
resolve from that wheelhouse. Packages absent from it resolve through the normal
remote indexes, including PyPI. Subsequent uv commands use the same generated
configuration. Refresh fingerprints the generated project and wheel contents,
discarding the generated lockfile when those inputs change so a previously
locked remote package cannot override a newly bundled one. Unchanged releases
retain their lockfile. Changed inputs also reinstall an existing environment to
pick up rebuilt wheels, and only a fully verified refresh records the inputs as
successfully installed.

Supply a mutually compatible package set, including private transitive
dependencies and wheels for the supported Python version and host platform.
Public dependencies, uv and Python may still be downloaded. Do not distribute
credentials, editable source paths, `pyproject.dev.toml`, or compatibility
shims. Use a clean packaging staging directory when local development overrides
are present. An incompatible bundled package should fail resolution, not fall
back silently to a public package of the same name.

The real-uv integration test is opt-in. Supply an existing uv executable and a
Python 3.12 interpreter; it builds tiny fixture wheels and serves a local HTTP
index to test public/private switching, release updates, and conflict handling:

```sh
MLIA_TEST_UV=/path/to/uv MLIA_TEST_PYTHON=/path/to/python3.12 npm test
```

## Design documentation

Put technical decisions and investigations in the [design notes](../design/README.md).
