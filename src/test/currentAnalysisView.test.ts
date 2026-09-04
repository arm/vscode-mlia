import * as assert from "assert";
import { describe, it } from "node:test";
import * as path from "path";

import { Analysis } from "../analysisStore";
import { CurrentAnalysisViewProvider, renderCurrentAnalysis } from "../currentAnalysisView";
import { buildOverlayCatalog, OverlayKey, overlayKeyId } from "../overlayCatalog";
import { SourceAnnotationIndex } from "../sourceAnnotations";
import { sourceCodeLensDescriptors } from "../sourceCodeLens";

function analysis(status: Analysis["status"] = "complete", id = "analysis-123"): Analysis {
  const entityId = `code_stack/${id}`;
  const lineEntityId = `code_line/${id}`;
  return {
    id,
    modelPath: `C:/models/${id}.vgf`,
    profilingDataPaths: [],
    targetProfile: "profile-a",
    analysisMode: "estimation",
    analysisOptions: { performance: true, compatibility: true },
    status,
    startedAt: new Date("2026-07-21T10:00:00Z"),
    ...(status === "complete"
      ? {
          finishedAt: new Date("2026-07-21T10:01:05Z"),
          artifacts: {
            htmlPath: `C:/analysis-runs/${id}/index.html`,
            standardizedOutputPath: `C:/analysis-runs/${id}/output.json`,
            entityNodeMappingsPath: `C:/analysis-runs/${id}/mappings.json`,
          },
          standardizedOutput: {
            results: [{
              kind: "performance",
              entities: [
                {
                  id: lineEntityId,
                  kind: "code_line",
                  parent_ids: [],
                  child_ids: [entityId],
                  attributes: { file: `/build/${id}.cc`, line: 7 },
                },
                {
                  id: entityId,
                  kind: "code_stack",
                  parent_ids: [lineEntityId],
                  child_ids: [`op/${id}`],
                  attributes: { file: `/build/${id}.cc`, line: 7 },
                },
                {
                  id: `op/${id}`,
                  kind: "source_operator",
                  parent_ids: [entityId],
                  child_ids: [],
                  placement: "NPU",
                  status: "estimated",
                },
              ],
              breakdowns: [{
                entity_id: lineEntityId,
                qualifiers: {},
                metrics: [
                  { name: "total_cycles", unit: "cycles", value: 10, qualifiers: {} },
                  { name: "dram_read_bytes", unit: "bytes", value: 100, qualifiers: {} },
                  {
                    name: "unavailable_only",
                    unit: "items",
                    availability: "unavailable",
                    reason: "not reported",
                    qualifiers: {},
                  },
                ],
              }],
              metrics: [
                { name: "inference_time", unit: "ms", value: 0.123123123, qualifiers: {} },
                { name: "tiny_value", unit: "s", value: 0.000023122, qualifiers: {} },
                { name: "compiled_size", unit: "bytes", value: 12234.1234, qualifiers: {} },
                {
                  name: "cpu_utilization",
                  unit: "%",
                  availability: "unavailable",
                  reason: "not reported",
                  qualifiers: { scope: "model" },
                },
              ],
              checks: [{
                id: "check-1",
                entity_id: `op/${id}`,
                status: "warning",
                details: { reasons: [{ description: "Review quantization" }] },
              }],
              advice: [{
                id: "advice-1",
                severity: "info",
                message: "Tune this",
                affected_entity_ids: [`op/${id}`],
              }],
            }],
          },
          entityNodeMappings: {
            results: [{
              resultIndex: 0,
              mappings: [{ entityId: lineEntityId }, { entityId }],
            }],
          },
        }
      : {}),
    analysisDir: `C:/analysis-runs/${id}`,
  };
}

function overlay(
  category: OverlayKey["category"],
  name: string,
  unit = "",
  resultIndex = 0,
  resultKind = "performance",
): OverlayKey {
  return {
    resultIndex,
    resultKind,
    category,
    name,
    unit,
    breakdownQualifiers: {},
    metricQualifiers: {},
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function viewHarness(provider: CurrentAnalysisViewProvider) {
  let receiveMessage: ((message: unknown) => void) | undefined;
  let disposeView: (() => void) | undefined;
  let messageDisposed = false;
  const webview = {
    options: {} as { enableScripts?: boolean },
    html: "",
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      receiveMessage = listener;
      return { dispose: () => { messageDisposed = true; } };
    },
  };
  const view = {
    webview,
    onDidDispose: (listener: () => void) => {
      disposeView = listener;
      return { dispose: () => undefined };
    },
  };
  provider.resolveWebviewView(view as never);
  return {
    webview,
    receive: (message: unknown) => receiveMessage?.(message),
    disposeView: () => disposeView?.(),
    messageDisposed: () => messageDisposed,
  };
}

describe("renderCurrentAnalysis", () => {
  it("describes the absence of the repository's current analysis", () => {
    const html = renderCurrentAnalysis({ kind: "empty" }, "fixed-nonce");

    assert.match(html, /No current analysis run/);
    assert.match(html, /Open a completed analysis run below/);
    assert.match(html, /run a new analysis/);
    assert.doesNotMatch(html, /Open Model Explorer/);
  });

  it("renders a compact overlay control, current-analysis summary, and indented model statistics", () => {
    const totalCycles = overlay("metric", "total_cycles", "cycles");
    const placement = overlay("placement", "placement");

    const html = renderCurrentAnalysis({
      kind: "current",
      analysis: analysis(),
      overlays: [totalCycles, placement],
      selectedOverlayId: overlayKeyId(placement),
    }, "fixed-nonce");

    assert.match(html, /<dt>Source model<\/dt><dd>C:\/models\/analysis-123\.vgf<\/dd>/);
    assert.match(html, /<dt>Mode<\/dt><dd>Estimation<\/dd>/);
    assert.match(html, /<dt>Checks<\/dt><dd>Performance \+ Compatibility<\/dd>/);
    assert.match(html, /<dt>Target profile<\/dt><dd>profile-a<\/dd>/);
    assert.match(html, /<dt>Status<\/dt><dd>Complete · [^<]+<\/dd>/);
    assert.doesNotMatch(html, /<dt>Model<\/dt>|<dt>Completed<\/dt>/);
    assert.match(html, /<div class="overlay-control"><label for="overlay">Overlay:<\/label>/);
    assert.ok(html.indexOf("overlay-control") < html.indexOf("<dt>Source model</dt>"));
    assert.match(html, /<section class="analysis-results" aria-label="Analysis results">/);
    assert.match(
      html,
      /<details class="analysis-result" open><summary>Result 1 · performance<\/summary>/,
    );
    assert.match(
      html,
      /<details class="result-subsection model-metrics" open><summary>Model metrics<\/summary>/,
    );
    assert.match(html, /<dt>inference_time<\/dt><dd title="0\.123123123 ms">0\.12 ms<\/dd>/);
    assert.match(html, /<dt>tiny_value<\/dt><dd title="0\.000023122 s">0\.000023 s<\/dd>/);
    assert.match(html, /<dt>compiled_size<\/dt><dd title="12234\.1234 bytes">12,234 bytes<\/dd>/);
    assert.match(
      html,
      /<dt>cpu_utilization · \{&quot;scope&quot;:&quot;model&quot;\}<\/dt><dd class="unavailable">Unavailable — not reported<\/dd>/,
    );
    assert.match(html, /Result 1 · performance · metric: total_cycles \(cycles\)/);
    assert.match(html, /Result 1 · performance · placement: placement/);
    assert.doesNotMatch(html, /Only result-0 overlays can drive source presentation/);
    assert.doesNotMatch(html, /Open MLIA settings/);
    assert.doesNotMatch(html, /Open Model Explorer|open-model-explorer/);
  });

  it("renders mapped code-stack counts without a result-scoped filtering action", () => {
    const html = renderCurrentAnalysis({
      kind: "current",
      analysis: analysis(),
      overlays: [],
      sourceMappings: [{
        resultIndex: 0,
        resultKind: "performance",
        reportedCodeStacks: 1,
        mappedCodeStacks: 1,
        sourceLocatedCodeStacks: 1,
        distinctSourceLocations: 1,
        accessibleSourceLocations: 1,
        accessibilityPending: false,
        sourceFiles: ["/build/analysis-123.cc"],
        locations: [],
      }],
    }, "fixed-nonce");

    assert.match(html, /1 reported · 1 mapped<\/dd>/);
    assert.doesNotMatch(html, /openEntityFiltering|Configure entity filtering/);
  });

  it("renders an explicit unselected overlay when no known cycle default is available", () => {
    const html = renderCurrentAnalysis({
      kind: "current",
      analysis: analysis(),
      overlays: [overlay("metric", "dram_read_bytes", "bytes")],
    }, "fixed-nonce");

    assert.match(html, /<option value="" selected>None<\/option>/);
    assert.doesNotMatch(html, /No source overlay is selected/);
    assert.match(html, /Result 1 · performance · metric: dram_read_bytes \(bytes\)/);
  });

  it("does not invent overlays or unsupported actions for a non-complete state", () => {
    const running = analysis("running");
    const html = renderCurrentAnalysis({
      kind: "current",
      analysis: running,
      overlays: [],
    }, "fixed-nonce");

    assert.match(html, /<dt>Status<\/dt><dd>Running<\/dd>/);
    assert.doesNotMatch(html, /Completed|Started|Duration|In progress/);
    assert.match(html, /Overlays are unavailable while this analysis run is running/);
    assert.match(html, /<select id="overlay" aria-label="Overlay" disabled>/);
    assert.doesNotMatch(html, /Open Model Explorer|open-model-explorer/);
  });

  it("keeps colliding breakdown and metric qualifier keys visibly distinct", () => {
    const qualified: OverlayKey = {
      ...overlay("metric", "work", "items"),
      breakdownQualifiers: { phase: "breakdown" },
      metricQualifiers: { phase: "metric" },
    };

    const html = renderCurrentAnalysis({
      kind: "current",
      analysis: analysis(),
      overlays: [qualified],
      selectedOverlayId: overlayKeyId(qualified),
    }, "fixed-nonce");

    assert.match(
      html,
      /work \(items\) · breakdown: \{&quot;phase&quot;:&quot;breakdown&quot;\} · metric: \{&quot;phase&quot;:&quot;metric&quot;\}/,
    );
  });

  it("explains disabled source presentation settings below the overlay dropdown", () => {
    const totalCycles = overlay("metric", "total_cycles", "cycles");
    const cases = [
      {
        codeLensEnabled: false,
        heatmapEnabled: true,
        message: "CodeLens is disabled, so overlay values will not appear above source lines.",
      },
      {
        codeLensEnabled: true,
        heatmapEnabled: false,
        message: "Source highlighting is disabled, so overlay colors will not appear in source editors.",
      },
      {
        codeLensEnabled: false,
        heatmapEnabled: false,
        message: "Source highlighting and CodeLens are disabled, so overlay changes will not appear in source editors.",
      },
    ];

    for (const sourcePresentation of cases) {
      const html = renderCurrentAnalysis({
        kind: "current",
        analysis: analysis(),
        overlays: [totalCycles],
        selectedOverlayId: overlayKeyId(totalCycles),
        ...sourcePresentation,
      }, "fixed-nonce");

      assert.ok(html.indexOf(sourcePresentation.message) > html.indexOf("<select id=\"overlay\""));
      assert.match(html, /<button id="open-settings" class="link-button" type="button">Open MLIA settings<\/button>/);
    }
  });

  it("uses a restrictive nonce-based content security policy", () => {
    const html = renderCurrentAnalysis({ kind: "empty" }, "fixed-nonce");

    assert.match(html, /default-src 'none'/);
    assert.match(html, /base-uri 'none'/);
    assert.match(html, /style-src 'nonce-fixed-nonce'/);
    assert.match(html, /script-src 'nonce-fixed-nonce'/);
    assert.match(html, /<style nonce="fixed-nonce">/);
    assert.match(html, /<script nonce="fixed-nonce">/);
    assert.doesNotMatch(html, /unsafe-inline/);
  });
});

describe("CurrentAnalysisViewProvider", () => {
  it("follows only AnalysisStore.currentAnalysis and remembers each analysis overlay choice", () => {
    let current: Analysis | undefined;
    const annotations = new SourceAnnotationIndex({ uriForFile: (file) => file });
    const provider = new CurrentAnalysisViewProvider({
      currentAnalysis: () => current,
      annotations,
      setOverlaySelection: (value, selection) => {
        value.overlaySelection = selection;
      },
    });
    const view = viewHarness(provider);
    const first = analysis("complete", "first");
    const second = analysis("complete", "second");

    assert.match(view.webview.html, /No current analysis run/);

    current = first;
    provider.refresh();
    assert.match(view.webview.html, /<dt>Source model<\/dt><dd>C:\/models\/first\.vgf<\/dd>/);
    assert.strictEqual(annotations.selectedOverlayKey?.name, "total_cycles");

    const catalog = buildOverlayCatalog(first.standardizedOutput);
    const dram = catalog.find(({ name }) => name === "dram_read_bytes");
    assert.ok(dram);
    view.receive({ command: "selectOverlay", overlayId: overlayKeyId(dram) });
    assert.strictEqual(annotations.selectedOverlayKey?.name, "dram_read_bytes");
    assert.strictEqual(
      annotations.sourceLineRecordsForUri(path.normalize("/build/first.cc"))[0]?.selectedMetric.name,
      "dram_read_bytes",
    );

    current = { ...first, finishedAt: new Date("2026-07-21T10:02:00Z") };
    provider.refresh();
    assert.strictEqual(annotations.selectedOverlayKey?.name, "dram_read_bytes");

    current = second;
    provider.refresh();
    assert.match(view.webview.html, /<dt>Source model<\/dt><dd>C:\/models\/second\.vgf<\/dd>/);
    assert.strictEqual(annotations.selectedOverlayKey?.name, "total_cycles");

    current = first;
    provider.refresh();
    assert.strictEqual(annotations.selectedOverlayKey?.name, "dram_read_bytes");

    current = undefined;
    provider.refresh();
    assert.match(view.webview.html, /No current analysis run/);
    assert.strictEqual(annotations.selectedOverlayKey, undefined);

    provider.dispose();
  });

  it("preserves an unavailable-only selected metric in source records and CodeLens", () => {
    const current = analysis();
    const annotations = new SourceAnnotationIndex({ uriForFile: (file) => file });
    const provider = new CurrentAnalysisViewProvider({
      currentAnalysis: () => current,
      annotations,
      setOverlaySelection: (value, selection) => {
        value.overlaySelection = selection;
      },
    });
    const view = viewHarness(provider);
    const selected = buildOverlayCatalog(current.standardizedOutput)
      .find(({ name }) => name === "unavailable_only");
    assert.ok(selected);

    view.receive({ command: "selectOverlay", overlayId: overlayKeyId(selected) });

    const record = annotations.sourceLineRecordsForUri(path.normalize("/build/analysis-123.cc"))[0];
    assert.ok(record);
    assert.strictEqual(overlayKeyId(annotations.selectedOverlayKey as OverlayKey), overlayKeyId(selected));
    assert.strictEqual(overlayKeyId(record.selectedOverlay as OverlayKey), overlayKeyId(selected));
    assert.deepStrictEqual({
      name: record.selectedMetric.name,
      unit: record.selectedMetric.unit,
      status: record.selectedMetric.status,
      value: record.selectedMetric.value,
      basis: record.color.basis,
    }, {
      name: "unavailable_only",
      unit: "items",
      status: "unavailable",
      value: undefined,
      basis: "unavailable",
    });
    assert.strictEqual(
      sourceCodeLensDescriptors([record], current.id)[0]?.title,
      "MLIA: unavailable only unavailable",
    );

    provider.dispose();
  });

  it("treats None as an explicit selection and clears source overlay presentation", () => {
    const current = analysis();
    const annotations = new SourceAnnotationIndex({ uriForFile: (file) => file });
    const provider = new CurrentAnalysisViewProvider({
      currentAnalysis: () => current,
      annotations,
      setOverlaySelection: (value, selection) => {
        value.overlaySelection = selection;
      },
    });
    const view = viewHarness(provider);

    view.receive({ command: "selectOverlay", overlayId: "" });

    assert.deepStrictEqual(current.overlaySelection, { kind: "none" });
    assert.strictEqual(annotations.selectedOverlayKey, undefined);
    const record = annotations.sourceLineRecordsForUri(path.normalize("/build/analysis-123.cc"))[0];
    assert.ok(record);
    assert.strictEqual(record.selectedOverlay, undefined);
    assert.strictEqual(record.color.basis, "unavailable");
    assert.deepStrictEqual(sourceCodeLensDescriptors([record], current.id), []);
    assert.match(view.webview.html, /<option value="" selected>None<\/option>/);

    provider.dispose();
  });

  it("uses the standardized-output catalog across categories and result indexes", () => {
    const base = analysis();
    const output = base.standardizedOutput as { results: unknown[] };
    const current: Analysis = {
      ...base,
      standardizedOutput: {
        results: [
          ...output.results,
          {
            kind: "compatibility",
            entities: [{ id: "op/one", kind: "source_operator", placement: "CPU" }],
            breakdowns: [{
              entity_id: "op/one",
              qualifiers: {},
              metrics: [{
                name: "result_one_only",
                unit: "items",
                availability: "unavailable",
                qualifiers: {},
              }],
            }],
            advice: [{ id: "global", message: "Global advice" }],
          },
        ],
      },
    };
    const annotations = new SourceAnnotationIndex({ uriForFile: (file) => file });
    const provider = new CurrentAnalysisViewProvider({
      currentAnalysis: () => current,
      annotations,
      setOverlaySelection: (value, selection) => {
        value.overlaySelection = selection;
      },
    });
    const view = viewHarness(provider);

    assert.match(view.webview.html, /Result 1 · performance · placement: placement/);
    assert.match(view.webview.html, /Result 1 · performance · checks: checks/);
    assert.match(view.webview.html, /Result 2 · compatibility · metric: result_one_only \(items\)/);
    assert.match(view.webview.html, /Result 2 · compatibility · advice: advice/);

    const catalog = buildOverlayCatalog(current.standardizedOutput);
    const sourceUri = path.normalize("/build/analysis-123.cc");
    for (const category of ["placement", "status", "checks", "advice"] as const) {
      const selected = catalog.find((overlayKey) =>
        overlayKey.resultIndex === 0 && overlayKey.category === category
      );
      assert.ok(selected);
      view.receive({ command: "selectOverlay", overlayId: overlayKeyId(selected) });
      const record = annotations.sourceLineRecordsForUri(sourceUri)[0];
      assert.ok(record);
      assert.strictEqual(overlayKeyId(record.selectedOverlay as OverlayKey), overlayKeyId(selected));
      const expectedPresentation = {
        placement: { basis: "placement", hex: "#2e7d32", codeLens: "MLIA: Placement — NPU" },
        status: { basis: "status", hex: "#757575", codeLens: "MLIA: Status — estimated" },
        checks: { basis: "checks", hex: "#f9a825", codeLens: "MLIA: Checks — Review quantization" },
        advice: { basis: "advice", hex: "#1565c0", codeLens: "MLIA: Advice — Tune this" },
      }[category];
      assert.deepStrictEqual({
        name: record.selectedMetric.name,
        status: record.selectedMetric.status,
        value: record.selectedMetric.value,
        basis: record.color.basis,
        hex: record.color.hex,
        codeLens: sourceCodeLensDescriptors([record], current.id)[0]?.title,
      }, {
        name: category,
        status: "unavailable",
        value: undefined,
        ...expectedPresentation,
      });
    }

    const laterMetric = catalog.find(({ resultIndex, name }) =>
      resultIndex === 1 && name === "result_one_only"
    );
    assert.ok(laterMetric);
    view.receive({ command: "selectOverlay", overlayId: overlayKeyId(laterMetric) });
    assert.doesNotMatch(view.webview.html, /Only result-0 overlays can drive source presentation/);
    assert.strictEqual(annotations.selectedOverlayKey?.resultIndex, 1);
    const record = annotations.sourceLineRecordsForUri(sourceUri)[0];
    assert.ok(record);
    assert.strictEqual(overlayKeyId(record.selectedOverlay as OverlayKey), overlayKeyId(laterMetric));
    assert.deepStrictEqual({
      name: record.selectedMetric.name,
      status: record.selectedMetric.status,
      value: record.selectedMetric.value,
      basis: record.color.basis,
      codeLens: sourceCodeLensDescriptors([record], current.id)[0]?.title,
    }, {
      name: "result_one_only",
      status: "unavailable",
      value: undefined,
      basis: "unavailable",
      codeLens: undefined,
    });

    provider.dispose();
  });

  it("ignores non-current analysis overlay changes while projecting current-analysis changes", () => {
    const first = analysis("complete", "first");
    const second = analysis("complete", "second");
    let current: Analysis = first;
    const annotations = new SourceAnnotationIndex({ uriForFile: (file) => file });
    const provider = new CurrentAnalysisViewProvider({
      currentAnalysis: () => current,
      annotations,
      setOverlaySelection: (value, selection) => {
        value.overlaySelection = selection;
      },
    });

    second.overlaySelection = { kind: "none" };
    provider.refresh();
    assert.strictEqual(annotations.selectedOverlayKey?.name, "total_cycles");

    current = { ...first, overlaySelection: { kind: "none" } };
    provider.refresh();
    assert.strictEqual(annotations.selectedOverlayKey, undefined);
    assert.strictEqual(
      annotations.sourceLineRecordsForUri(path.normalize("/build/first.cc"))[0]?.selectedOverlay,
      undefined,
    );

    provider.dispose();
  });

  it("renders source mappings without model metrics and handles settings and indexed navigation actions", async () => {
    const base = analysis();
    const current: Analysis = {
      ...base,
      standardizedOutput: {
        results: [{
          kind: "performance",
          entities: [
            {
              id: "code_stack/accessible",
              kind: "code_stack",
              parent_ids: [],
              child_ids: [],
              attributes: { file: "/build/accessible.cc", line: 7 },
            },
            {
              id: "code_stack/accessible-duplicate",
              kind: "code_stack",
              parent_ids: [],
              child_ids: [],
              attributes: { file: "/build/accessible.cc", line: 7 },
            },
            {
              id: "code_stack/missing",
              kind: "code_stack",
              parent_ids: [],
              child_ids: [],
              attributes: { file: "/build/missing.cc", line: 11 },
            },
            {
              id: "code_stack/missing-duplicate",
              kind: "code_stack",
              parent_ids: [],
              child_ids: [],
              attributes: { file: "/build/missing.cc", line: 11 },
            },
            {
              id: "code_stack/unmapped",
              kind: "code_stack",
              parent_ids: [],
              child_ids: [],
              attributes: { file: "/build/filtered.cc", line: 13 },
            },
          ],
          breakdowns: [],
        }],
      },
      entityNodeMappings: {
        results: [{
          resultIndex: 0,
          mappings: [
            { entityId: "code_stack/accessible" },
            { entityId: "code_stack/accessible-duplicate" },
            { entityId: "code_stack/missing" },
            { entityId: "code_stack/missing-duplicate" },
          ],
        }],
      },
    };
    const annotations = new SourceAnnotationIndex({
      uriForFile: (file) => file,
      isFileAccessible: async (file) => !file.endsWith("missing.cc"),
    });
    annotations.updateSourceFileMap({ "/build": "C:/src" });
    let sourceMapOpened = 0;
    const navigated: Array<{ localFile: string; line: number }> = [];
    const provider = new CurrentAnalysisViewProvider({
      currentAnalysis: () => current,
      annotations,
      setOverlaySelection: () => undefined,
      openSourceFileMap: () => { sourceMapOpened += 1; },
      openSourceLocation: ({ localFile, line }) => { navigated.push({ localFile, line }); },
    });
    const view = viewHarness(provider);

    await flushAsync();

    assert.match(
      view.webview.html,
      /<details class="analysis-result" open><summary>Result 1 · performance<\/summary>/,
    );
    assert.match(
      view.webview.html,
      /<details class="result-subsection source-mappings" open>\s*<summary>Source mappings<\/summary>/,
    );
    assert.doesNotMatch(view.webview.html, /<summary>Model metrics<\/summary>/);
    assert.match(
      view.webview.html,
      /Code stacks<\/dt><dd title="5 code stacks were reported; 4 are mapped to Model Explorer; 4 mapped code stacks have valid file and line source attributes\.\">5 reported · 4 mapped<\/dd>/,
    );
    assert.doesNotMatch(view.webview.html, /Code stacks with source attributes<\/dt>/);
    assert.match(
      view.webview.html,
      /<details class="source-locations distinct-source-locations">\s*<summary>Distinct source locations: 2<\/summary>\s*<ul class="source-location-groups source-file-groups"><li title="\/build\/accessible\.cc">\/build\/accessible\.cc<\/li><li title="\/build\/missing\.cc">\/build\/missing\.cc<\/li><\/ul>\s*<\/details>/,
    );
    assert.match(
      view.webview.html,
      /<details class="source-locations accessible-source-locations">\s*<summary>Accessible locally: 1 <span class="inline-setting-link">\[<button[^>]+data-command="openSourceFileMap">Configure source file mapping<\/button>\]<\/span><\/summary>\s*<ul class="source-location-groups"><li><span title="C:[\\/]src[\\/]accessible\.cc">C:[\\/]src[\\/]accessible\.cc<\/span><span class="source-location-lines"><button[^>]+>7<\/button><\/span><\/li><\/ul>\s*<\/details>/,
    );
    assert.doesNotMatch(view.webview.html, /not included in source overlays|could not be found locally|Accessible source locations/);

    view.receive({ command: "openSourceFileMap" });
    const location = annotations.sourceMappingDiagnostics[0].locations[0];
    view.receive({
      command: "openSourceLocation",
      locationId: location.id,
      localFile: "C:/untrusted.cc",
      line: 999,
    });
    view.receive({ command: "openSourceLocation", locationId: "unknown" });

    assert.strictEqual(sourceMapOpened, 1);
    assert.deepStrictEqual(navigated, [{ localFile: location.localFile, line: 7 }]);

    provider.dispose();
  });

  it("opens extension settings from the source presentation warning", () => {
    const current = analysis();
    const annotations = new SourceAnnotationIndex({ uriForFile: (file) => file });
    let settingsOpened = 0;
    const provider = new CurrentAnalysisViewProvider({
      currentAnalysis: () => current,
      annotations,
      setOverlaySelection: () => undefined,
      isCodeLensEnabled: () => false,
      isHeatmapEnabled: () => true,
      openSettings: () => { settingsOpened += 1; },
    });
    const view = viewHarness(provider);

    assert.match(view.webview.html, /CodeLens is disabled/);
    view.receive({ command: "openSettings" });
    assert.strictEqual(settingsOpened, 1);

    provider.dispose();
  });

  it("rejects invalid messages and stops rendering after its webview is disposed", () => {
    let current: Analysis | undefined = analysis();
    const annotations = new SourceAnnotationIndex({ uriForFile: (file) => file });
    const provider = new CurrentAnalysisViewProvider({
      currentAnalysis: () => current,
      annotations,
      setOverlaySelection: (value, selection) => {
        value.overlaySelection = selection;
      },
    });
    const view = viewHarness(provider);

    view.receive({ command: "selectOverlay", overlayId: "unknown" });
    assert.strictEqual(annotations.selectedOverlayKey?.name, "total_cycles");

    const htmlBeforeDisposal = view.webview.html;
    view.disposeView();
    current = undefined;
    provider.refresh();
    assert.strictEqual(view.webview.html, htmlBeforeDisposal);
    assert.strictEqual(view.messageDisposed(), true);
    assert.strictEqual(view.webview.options.enableScripts, true);
    provider.dispose();
    assert.strictEqual(annotations.selectedOverlayKey, undefined);
  });
});
