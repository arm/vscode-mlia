<!---
SPDX-FileCopyrightText: Copyright 2026 Arm Limited and/or its affiliates <open-source-office@arm.com>
SPDX-License-Identifier: Apache-2.0
--->

# Running analyses

MLIA for VS Code supports estimation and profiling workflows. The selected mode and target profile determine which checks you can run.

## Analysis modes

| Mode | Required input | Optional input | Typical use |
| --- | --- | --- | --- |
| **Estimation** | One source model | None | Estimate compatibility or performance before collecting runtime profiling data. |
| **Profiling** | One or more [profiling-data paths](profiling-data.md) | Source model | Analyse measured profiling data, optionally associating it with the original model. |

## Estimation

Use **Estimation** to evaluate a source model for a target profile.

1. Select or enter the **Source model** path.
2. Select a target profile.
3. Enable one or more supported checks.
4. Select **Run Analysis**.

![Configure an estimation analysis](../images/analysis-estimation.png)

The source model is required in estimation mode.

## Profiling

Use **Profiling** after collecting [profiling data](profiling-data.md) from your target.

1. Add one or more profiling-data paths.
2. Reorder or remove profiling-data entries when necessary.
3. Optionally select the source model.
4. Select a target profile.
5. Enable one or more supported checks.
6. Select **Run Analysis**.

![Configure a profiling analysis](../images/analysis-profiling.png)

At least one profiling-data path is required. Multiple paths are passed to MLIA in their displayed order.

Depending on the profiling format, a source model can add context to MLIA and Model Explorer.

## Target profiles

Target profiles describe the inference target and configuration against which MLIA evaluates the input.

The target profiles shown in New Analysis depend on the selected analysis mode.

![Select a target profile](../images/target-profile-dropdown.png)

The most recently selected profile is remembered for subsequent analyses. Changing the configured profile does not affect saved runs.

If no profiles are shown:

1. Refresh the MLIA environment.
2. Check the MLIA output log for errors.
3. See [Troubleshooting](troubleshooting.md).

## Checks

The extension exposes two MLIA check categories:

- **Performance** evaluates performance-related metrics and recommendations for the selected profile.
- **Compatibility** checks whether the input is supported by the selected profile.

A check is disabled when it is not supported for the selected mode and profile. At least one supported check must be enabled before an analysis can start.

## What happens when an analysis starts

The extension runs MLIA in its managed environment and creates a dedicated output directory for the run. It requests:

- MLIA standardized output.
- A Model Explorer bundle.
- Mappings that connect MLIA results to Model Explorer nodes.
- Debug output for diagnostics.

Each new run becomes the **Current Analysis Run** immediately. You can select another run while it executes; finishing the background run does not change your selection or reveal its tab.

A progress notification identifies the run by its input file, checks, and target profile. It remains active until the run finishes and offers **Cancel**. That button cancels the notification's run, even if you have selected another analysis. The progress bar is indeterminate because MLIA does not report a completion percentage.

Each run records its input paths, mode, selected checks, target profile, status, output, and selected overlay. Completed and failed runs are persisted across VS Code sessions.

## Managing runs

The **Analysis Runs** view lists saved runs with their current status.

![Review saved analysis runs and their actions](../images/analysis-runs.png)

Available actions include:

- Select any run, including running, failed, cancelled, or interrupted runs, to make it current and open its tab.
- Cancel a running analysis started by the current extension session, using its row's stop icon or **Cancel Analysis** in **Current Analysis Run**. The **Cancel Analysis** command also cancels the current run.
- Open a run's output folder.
- Delete a finished run.
- Open the root analysis-runs folder.
- Clear all saved runs.

Deleting a run also removes its stored output directory.

## Noninteractive execution

The extension runs analyses with `--noninteractive` and gives all background runtime commands closed stdin. Commands cannot wait for terminal input.

### GCPE licence acceptance

Before an estimation run using `neural-technology`, `NX-peak-12SC-8NX-600MHz`, or `NX-sustained-12SC-8NX-350MHz`, the extension checks whether you have accepted the GCPE EULA for the cached `mlia-neural-technology` package version. Accepted versions start without a Python licence query. Otherwise, the extension reads the licence from the managed environment and opens a **MLIA licence agreement** tab with **Accept and Run** and **Cancel** buttons. Closing the tab also cancels the request. No analysis is started until you accept.

Acceptance is saved in the user-level [Accepted EULAs setting](configuration.md#accepted-eulas), keyed by agreement ID and providing package version. A new package version requires acceptance again, even if its terms are unchanged. Editing licence text without changing the package version does not trigger a new prompt; delete the acceptance entry when testing such changes. If the text cannot be read or acceptance cannot be saved, the analysis does not start and an error is shown.

Package versions are collected during **Refresh MLIA Environment** and reused across restarts. Refresh after changing packages outside the extension. Missing or inconsistent version metadata requires a refresh before a mapped EULA can be accepted.

Once accepted, the extension adds `--i-agree-to-the-contained-eula` to the run. Profiling and unmapped target-profile/mode combinations receive no automatic acceptance flag; MLIA reports an error if they require an outstanding EULA. Advanced arguments remain unchanged, including explicit user-supplied acceptance flags.

## Advanced arguments

The [`vscode-mlia.extraCommandLineArgs`](configuration.md#extra-command-line-args) setting appends arguments unchanged to the generated `mlia check` command. Use this only when an option is not represented in the extension interface.

Extra arguments can override or conflict with extension-managed arguments. Review the [MLIA CLI Guide](https://github.com/arm/mlia/blob/main/docs/source/cli.md#backend-specific-options) and inspect the MLIA output log when using this setting.

Next: [explore completed runs, Model Explorer, and overlays](results.md).
