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

## Design documentation

Put technical decisions and investigations in the [design notes](../design/README.md).
