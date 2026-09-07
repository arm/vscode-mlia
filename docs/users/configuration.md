<!---
SPDX-FileCopyrightText: Copyright 2026 Arm Limited and/or its affiliates <open-source-office@arm.com>
SPDX-License-Identifier: Apache-2.0
--->

# Configuration

Open **Settings** and search for `MLIA`, or select **Open MLIA Settings** from the New Analysis title bar.

Unless stated otherwise, changes apply to the current VS Code window or workspace.

## General behaviour

<a id="auto-open-model-explorer"></a>
### `vscode-mlia.autoOpenModelExplorer`

Default: `true`

Automatically opens Model Explorer while an analysis runs and when it completes. When disabled, completed analyses are still saved and made current.

<a id="sync-model-explorer-selection-to-code"></a>
### `vscode-mlia.syncModelExplorerSelectionToCode`

Default: `true`

Opens the corresponding source location when a selected Model Explorer node has an unambiguous mapped source file and line.

## Source presentation

<a id="show-code-lens"></a>
### `vscode-mlia.showCodeLens`

Default: `true`

Shows MLIA overlay values and source-navigation actions as CodeLens entries.

<a id="show-heatmap"></a>
### `vscode-mlia.showHeatmap`

Default: `true`

Shows overlay colours on mapped lines in visible source editors.

## Analysis defaults

<a id="target-profile"></a>
### `vscode-mlia.targetProfile`

Default: empty

Stores the target profile used for new analyses. Select the profile from New Analysis after refreshing the environment. Existing and running analyses are unaffected by changes.

## Advanced MLIA configuration

<a id="extra-command-line-args"></a>
### `vscode-mlia.extraCommandLineArgs`

Default: `[]`

Appends arguments unchanged to MLIA analyses started by the extension.

Example:

```json
{
  "vscode-mlia.extraCommandLineArgs": [
    "--some-advanced-option",
    "value"
  ]
}
```

Use this only for MLIA options that the extension does not expose. Conflicting arguments can make a run fail or behave unexpectedly.

<a id="config-file-contents"></a>
### `vscode-mlia.configFileContents`

Contains the complete MLIA TOML configuration applied to analyses started by the extension. Changes affect new analyses only.

The extension writes this value to the managed runtime as `mlia-config.toml` before starting an analysis. The default configuration collapses selected framework code stacks:

```toml
[[filtering.collapse]]
kind = "code_stack"
attribute = "file"
globs = [
    "**/site-packages/torch/**",
    "**/site-packages/executorch/**",
]
```

See the [MLIA configuration documentation](https://github.com/Arm/mlia#configuration) for supported settings.

## Source-file mapping

<a id="source-file-map"></a>
### `vscode-mlia.sourceFileMap`

Default: `{}`

Maps source-path prefixes from embedded debug information to paths on the local machine.

Example:

```json
{
  "vscode-mlia.sourceFileMap": {
    "/build/workspace/project": "C:/src/project",
    "src/model": "C:/src/project/model"
  }
}
```

See [Source-file mapping](source-file-mapping.md) for matching rules and examples.

## Settings scope

MLIA settings can be configured in User or Workspace settings.

Keep machine-specific source-file mappings in User settings. Use Workspace settings when everyone on the project has the same checkout layout.

Next: [configure source-file mapping](source-file-mapping.md).
