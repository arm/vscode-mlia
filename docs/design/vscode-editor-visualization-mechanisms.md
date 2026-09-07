<!---
SPDX-FileCopyrightText: Copyright 2026 Arm Limited and/or its affiliates <open-source-office@arm.com>
SPDX-License-Identifier: Apache-2.0
--->

# VS Code editor visualisation mechanisms

## Status

Accepted.

## Problem

MLIA needs to present profiling values and source mappings beside ordinary source code. A measurement may map to one line, several non-contiguous lines, or lines in different files.

The presentation should:

- show relative cost without obscuring source code;
- expose exact values and explanations on demand;
- support navigation between source code and Model Explorer;
- represent non-contiguous mappings without implying false per-line precision;
- remain usable with large analyses and different VS Code themes.

## VS Code constraints

VS Code extensions cannot place an arbitrary HTML, SVG, or canvas layer over the standard editor. Extensions provide data to editor-owned features such as decorations, CodeLens, hovers, diagnostics, and inlay hints. Rich custom interfaces must use a Webview or another view.

This means:

- decorations can style independent source ranges, including non-contiguous ranges;
- CodeLens provides one source anchor per lens;
- folding ranges are contiguous;
- selections are real editing selections and should not represent passive analysis state;
- decorations do not support CSS animation or connector lines between ranges.

## Decision

Combine editor features rather than forcing one feature to present everything.

### Persistent heatmap

Use whole-line text decorations with semi-transparent backgrounds to show relative metric values.

- Numeric metrics use a bounded green-to-red scale.
- Partial or unavailable values must not be distinguished by hue alone. Use opacity, borders, glyphs, or explanatory text as appropriate.
- Colors must remain legible in light, dark, and high-contrast themes.
- Users can disable the heatmap with `vscode-mlia.showHeatmap`.

Decorations should be batched by style and visible editor. Decoration types should be reused and disposed when no longer needed. A bounded set of heat buckets may replace exact colors if real analyses create excessive decoration types.

### Exact values and actions

Use CodeLens for metric summaries and navigation actions.

CodeLens is appropriate for:

- source-line or group totals;
- percentages where they can be calculated safely;
- navigation to Model Explorer;
- caller and called-source navigation;
- explanations of partial or unavailable data.

CodeLens should not be placed so densely that it dominates the source layout. Users can disable it with `vscode-mlia.showCodeLens`.

Use hovers for detailed values, qualifiers, completeness information, contributors, and mapping explanations. Consider inlay hints or decoration after-text only as optional compact presentations.

### Non-contiguous mappings

Represent each logical measurement with an ID and a set of source members. Do not reduce it prematurely to independent source-line totals.

A source member should identify its file and range and may contain an independently known contribution. If only a shared group total is known:

- do not repeat it as though it were an independent value on every line;
- label it explicitly as a group total;
- place its CodeLens at one deterministic anchor;
- explain the shared mapping in the hover;
- retain every member for navigation and highlighting.

When a group is activated, reveal the requested member or anchor and apply one strong temporary decoration to all visible members. Clear it after approximately 1.5 seconds. Batch ranges per editor, cancel superseded timers, and avoid frame-by-frame animation.

Cross-file groups cannot be connected visually in one editor. Highlight members in all matching visible editors and use Model Explorer or a tree view to enumerate the complete group.

### Rich exploration

Keep Model Explorer as the detailed surface for graphs, hierarchy, attributes, and large metric collections. Editor annotations should provide context and navigation, not reproduce the full analysis interface.

## Features not used for the base presentation

- **Diagnostics:** reserve for actionable findings with clear severity, not ordinary measurements.
- **Selections and document highlights:** avoid because they imply editing or language-symbol semantics.
- **Folding and document symbols:** do not use for profiling groups because they describe contiguous source structure.
- **Semantic tokens and color providers:** do not repurpose language and color-literal features for analysis data.
- **Testing coverage:** its data model and UI describe test coverage, not performance metrics.
- **Comments:** too heavyweight for transient analysis results; they may support a future review workflow.

## Current implementation

Relevant implementation files:

- `src/sourceDecorations.ts` batches heatmap decorations across visible editors;
- `src/sourceCodeLens.ts` presents overlay values and relationship actions;
- `src/sourceAnnotations.ts` indexes mapped source records;
- `src/sourceNavigation.ts` provides transient source-line emphasis;
- `src/sourceOverlayActions.ts` coordinates source and Model Explorer navigation.

## Follow-up work

1. Preserve one-to-many source mappings so non-contiguous groups remain available after aggregation.
2. Distinguish shared group totals from independently known line contributions.
3. Generalise transient single-line emphasis to range sets spanning visible editors.
4. Add profiling hovers with exact values, completeness, and group membership.
5. Validate colors and status cues in light, dark, and high-contrast themes.
6. Benchmark large files and analyses; introduce heat buckets or CodeLens density controls if needed.

## References

- [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api)
- [Programmatic language features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
- [Theme color reference](https://code.visualstudio.com/api/references/theme-color)
- [Webview guide](https://code.visualstudio.com/api/extension-guides/webview)
- [Tree view guide](https://code.visualstudio.com/api/extension-guides/tree-view)
