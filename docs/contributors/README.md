<!---
SPDX-FileCopyrightText: Copyright 2026 Arm Limited and/or its affiliates <open-source-office@arm.com>
SPDX-License-Identifier: Apache-2.0
--->

# Contributor documentation

## Requirements

- Node.js matching `^20.19.0 || ^22.13.0 || >=24` (required by ESLint).
- Visual Studio Code 1.100 or newer.

## Development workflow

1. Install dependencies with `npm install`.
2. Type-check and check dependency imports with `npm run lint`.
3. Build the bundled extension entry point with `npm run bundle`.
4. Run the test suite with `npm test`.
5. Open the repository in VS Code and press `F5` to bundle and launch an Extension Development Host.

## Build outputs

The project has separate outputs for testing and distribution:

- `npm run compile` uses TypeScript to emit modules and tests into `out/`. The test suite runs these files directly.
- `npm run bundle` checks dependency imports, then uses esbuild to combine the extension and its runtime dependencies into `dist/extension.js`.
- `npm run package:extension` runs the bundle step and creates the distributable VSIX.

The packaged extension uses `dist/extension.js` as its entry point. Source files, test output, source maps, and `node_modules` are excluded from the VSIX. Dependencies are still installed normally in `node_modules` for local development; bundling only changes the release artifact.

The `F5` launch configuration runs the bundle task before opening the Extension Development Host.

## Dependency imports

`npm run lint:dependencies` uses ESLint and `eslint-plugin-import-x` to check
imports against `package.json`. Runtime value imports must be declared in
`dependencies`; an installed transitive package is not a substitute for a
direct declaration. Tests, build scripts and the lint configuration may use
`devDependencies`. Node built-ins and the VS Code host module are allowed, and
erased type-only imports may use development dependencies.

The check also runs through `npm run lint` and before bundling, so normal local
packaging, F5 builds and CI reject undeclared or development-only runtime
imports. It checks project source, not third-party libraries' internals or
arbitrary computed runtime imports. The regression suite exercises the real
rules and verifies that the actual bundle command fails when a runtime package
is moved to `devDependencies`, then succeeds when its declaration is restored.

## Managed uv bootstrap

`src/uvBootstrap.ts` pins the uv version and each supported platform's PyPI
wheel URL and SHA-256. The bootstrap downloads directly from
`files.pythonhosted.org`, verifies the pinned hash, and uses `yauzl` to extract
only `uv-VERSION.data/scripts/uv` (or `uv.exe`). It does not install the wheel
as a Python package or require Python, pip, or a system archive tool.

When updating uv, obtain the wheel filenames, URLs and SHA-256 hashes from
`https://pypi.org/pypi/uv/VERSION/json`. Update all platform pins together and
check the wheel layout. The aarch64 Linux wheel is shared by glibc and musl;
the x86-64 Linux wheels are separate. Installation metadata records the wheel
filename and hash, so changed pins trigger a fresh installation.

The default tests use small ZIP fixtures and exercise the real extractor.
Opt into live download, verification, extraction, execution, reuse and forced
reinstallation with `MLIA_TEST_UV_BOOTSTRAP=1 npm test` (PowerShell:
`$env:MLIA_TEST_UV_BOOTSTRAP = '1'; npm test`). Run this on Windows and Linux;
on Linux it also launches the musl wheel's static binary.

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
