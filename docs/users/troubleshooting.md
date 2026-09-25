<!---
SPDX-FileCopyrightText: Copyright 2026 Arm Limited and/or its affiliates <open-source-office@arm.com>
SPDX-License-Identifier: Apache-2.0
--->

# Troubleshooting

Start by opening the MLIA output log. Use **Show Log** from an environment or Model Explorer error, or open the **Output** panel and select the MLIA channel.

The log records managed-environment commands, analysis commands, MLIA output, generated file locations, and synchronization diagnostics.

## The managed `uv` download fails

The extension downloads a pinned `uv` wheel from PyPI's file host and extracts its native executable into VS Code global storage. No system installation of uv, Python, pip, or an archive-extraction command is required for this step.

If the download or checksum verification fails:

1. Confirm that `files.pythonhosted.org` is reachable from your network.
2. Check proxy, certificate, firewall, and endpoint-security policies.
3. Ensure the VS Code global-storage location is writable and has sufficient free space.
4. Select **Refresh MLIA Environment** from the New Analysis title bar again.
5. Use **MLIA: Force Refresh MLIA Environment** to redownload `uv` and recreate the Python environment.

The extension refuses to extract the wheel if its SHA-256 does not match the platform-specific hash pinned in the extension.

## Environment refresh fails

An environment refresh prepares the managed MLIA runtime and loads the options used by New Analysis.

Check the log for the failing stage and command. Common causes include:

- Unavailable package indexes or network access.
- Proxy, certificate, or authentication configuration.
- Unsupported platform wheels.
- Insufficient disk space or filesystem permissions.
- Invalid development-only runtime overrides.

Retry with **MLIA: Force Refresh MLIA Environment** to delete and recreate the managed environment and reinstall packages.

## No target profiles are shown

The extension could not load any target profiles for the selected analysis mode.

- Refresh the environment.
- Try the other analysis mode.
- Review the MLIA output log for errors.
- Select **Show MLIA Information** from the New Analysis title bar to inspect the managed runtime information.

## Run Analysis is disabled

Confirm that:

- The environment refresh completed successfully.
- The required estimation model or profiling-data path is present.
- A target profile is selected.
- At least one supported check is enabled.
- The selected profile supports the current estimation or profiling mode.

Checks that are not supported for the selected mode and profile remain disabled.

## An analysis fails

Select the failed run to see its error summary, then inspect the MLIA output log for full command output.

Also check that:

- Input paths exist and are readable.
- The selected target profile supports the input format.
- Advanced command-line arguments are valid.
- The MLIA TOML is valid.
- There is enough disk space for the generated output.

Use the folder action on the run's row to open its output folder when partial output was produced.

## Model Explorer does not open

- Confirm that [`vscode-mlia.autoOpenModelExplorer`](configuration.md#auto-open-model-explorer) is enabled, or reopen the saved run from **Analysis Runs**.
- Make sure the run completed and generated a Model Explorer bundle.
- Inspect the panel error and MLIA log if the generated HTML, standardized output, or mapping data cannot be loaded.
- Reopen the saved run from Analysis Runs.

## Source files do not open

Expand **Source mappings** in Current Analysis Run.

- If no source locations are reported, the MLIA result may not contain usable code-stack source attributes.
- If locations are reported but not accessible, configure [`vscode-mlia.sourceFileMap`](configuration.md#source-file-map). See [Source-file mapping](source-file-mapping.md).
- Confirm that embedded line numbers are valid and within the local file.
- A Model Explorer node mapped to multiple different locations cannot be opened unambiguously.

## Source presentation is missing

If expected heatmaps or CodeLens entries are absent:

1. Expand **Source mappings** in Current Analysis Run.
2. Compare **Distinct source locations** with **Accessible locally**.
3. Configure [source-file mapping](source-file-mapping.md) when the embedded paths do not match those on your machine.
4. Open a source file listed as accessible in **Source mappings**.
5. Select an overlay rather than **None** in Current Analysis Run or Model Explorer.
6. Enable [`vscode-mlia.showHeatmap`](configuration.md#show-heatmap) and [`vscode-mlia.showCodeLens`](configuration.md#show-code-lens).
7. Confirm that VS Code's general `editor.codeLens` setting is enabled. This setting controls all CodeLens contributions, including MLIA's.
8. Confirm that the selected overlay contains a value for the source line.
9. Check that the completed run is still the current analysis.
10. Check the MLIA output log for mapping or synchronization diagnostics.

Some results do not contain source information or overlay values.

## Reset saved analyses

Use the Analysis Runs title-bar action **Clear All Analysis Runs** to remove saved runs and their output directories.

For targeted cleanup, use the delete action on an individual run's row. Running analyses must finish or be cancelled before deletion.

Return to the [user guide](README.md) for the full workflow.
