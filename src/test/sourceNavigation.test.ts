import * as assert from "assert";
import * as path from "path";
import { describe, it } from "node:test";

import {
  codeStackLocations,
  mapSourcePath,
  resolveCodeStackLocation,
  sourceRevealPlan,
  sourceViewColumn,
  TransientSourceLineBorder,
} from "../sourceNavigation";

function entity(
  id: string,
  kind: string,
  options: {
    parentIds?: string[];
    childIds?: string[];
    file?: string;
    line?: number;
  } = {},
): Record<string, unknown> {
  return {
    id,
    kind,
    parent_ids: options.parentIds ?? [],
    child_ids: options.childIds ?? [],
    ...(options.file === undefined
      ? {}
      : { attributes: { file: options.file, line: options.line } }),
  };
}

function context(
  selected: Record<string, unknown>,
  entities: unknown[],
  mappedCodeStackIds?: ReadonlySet<string>,
) {
  return { entity: selected, resultEntities: entities, mappedCodeStackIds };
}

function unresolvedReason(contexts: ReturnType<typeof context>[]): string {
  let reason: string | undefined;
  assert.strictEqual(
    resolveCodeStackLocation(contexts, (failure) => { reason = failure.reason; }),
    undefined,
  );
  assert.ok(reason);
  return reason;
}

describe("resolveCodeStackLocation", () => {
  it("reports selections without mapped entities or valid source attributes", () => {
    assert.strictEqual(
      unresolvedReason([]),
      "the selected Model Explorer node has no mapped MLIA entities",
    );
    const stack = entity("code_stack/no-source", "code_stack");
    assert.strictEqual(
      unresolvedReason([context(stack, [stack])]),
      "code stack code_stack/no-source has no valid source file and positive line number",
    );
  });

  it("returns a directly selected code-stack location", () => {
    const stack = entity("code_stack/direct", "code_stack", { file: "/build/model.py", line: 27 });
    assert.deepStrictEqual(resolveCodeStackLocation([context(stack, [stack])]), {
      file: "/build/model.py",
      line: 27,
    });
  });

  it("resolves a selected source operator to its nearest code-stack parent", () => {
    const root = entity("code_stack/root", "code_stack", {
      childIds: ["code_stack/leaf"],
      file: "/build/model.py",
      line: 10,
    });
    const leaf = entity("code_stack/leaf", "code_stack", {
      parentIds: [root.id as string],
      childIds: ["source_operator/op"],
      file: "/build/model.py",
      line: 20,
    });
    const op = entity("source_operator/op", "source_operator", { parentIds: [leaf.id as string] });

    assert.deepStrictEqual(resolveCodeStackLocation([context(op, [root, leaf, op])]), {
      file: "/build/model.py",
      line: 20,
    });
  });

  it("skips unmapped code-stack parents and resolves to the nearest mapped ancestor", () => {
    const root = entity("code_stack/root", "code_stack", {
      childIds: ["code_stack/unmapped"],
      file: "/build/model.py",
      line: 10,
    });
    const unmapped = entity("code_stack/unmapped", "code_stack", {
      parentIds: [root.id as string],
      childIds: ["source_operator/op"],
      file: "/build/internal.py",
      line: 20,
    });
    const op = entity("source_operator/op", "source_operator", { parentIds: [unmapped.id as string] });

    assert.deepStrictEqual(
      resolveCodeStackLocation([context(op, [root, unmapped, op], new Set([root.id as string]))]),
      { file: "/build/model.py", line: 10 },
    );
  });

  it("reports when every code-stack ancestor is unmapped", () => {
    const unmapped = entity("code_stack/unmapped", "code_stack", {
      childIds: ["source_operator/op"],
      file: "/build/internal.py",
      line: 20,
    });
    const op = entity("source_operator/op", "source_operator", { parentIds: [unmapped.id as string] });

    assert.strictEqual(
      unresolvedReason([context(op, [unmapped, op], new Set())]),
      "source operator source_operator/op has no mapped code-stack ancestor",
    );
    assert.strictEqual(
      unresolvedReason([context(unmapped, [unmapped], new Set())]),
      "code stack code_stack/unmapped is not present in the Model Explorer entity mappings",
    );
  });

  it("recursively resolves a segment containing one source operator", () => {
    const stack = entity("code_stack/leaf", "code_stack", {
      childIds: ["source_operator/op"],
      file: "/build/model.py",
      line: 30,
    });
    const op = entity("source_operator/op", "source_operator", { parentIds: [stack.id as string] });
    const chain = entity("chain/0", "chain", { childIds: [op.id as string] });
    const segment = entity("segment/0", "segment", { childIds: [chain.id as string] });

    assert.deepStrictEqual(resolveCodeStackLocation([context(segment, [segment, chain, op, stack])]), {
      file: "/build/model.py",
      line: 30,
    });
  });

  it("finds the closest common code-stack ancestor for multiple source operators", () => {
    const root = entity("code_stack/root", "code_stack", {
      childIds: ["code_stack/helper"],
      file: "/build/model.py",
      line: 5,
    });
    const helper = entity("code_stack/helper", "code_stack", {
      parentIds: [root.id as string],
      childIds: ["code_stack/call-a", "code_stack/call-b"],
      file: "/build/model.py",
      line: 15,
    });
    const callA = entity("code_stack/call-a", "code_stack", {
      parentIds: [helper.id as string],
      childIds: ["source_operator/a"],
      file: "/build/model.py",
      line: 21,
    });
    const callB = entity("code_stack/call-b", "code_stack", {
      parentIds: [helper.id as string],
      childIds: ["source_operator/b"],
      file: "/build/model.py",
      line: 22,
    });
    const opA = entity("source_operator/a", "source_operator", { parentIds: [callA.id as string] });
    const opB = entity("source_operator/b", "source_operator", { parentIds: [callB.id as string] });
    const segment = entity("segment/0", "segment", { childIds: [opA.id as string, opB.id as string] });
    const entities = [segment, opA, opB, callA, callB, helper, root];

    assert.deepStrictEqual(
      resolveCodeStackLocation([
        context(segment, entities, new Set([helper.id as string, root.id as string])),
      ]),
      {
        file: "/build/model.py",
        line: 15,
      },
    );
  });

  it("walks through non-code-stack parents to find code-stack ancestry", () => {
    const stack = entity("code_stack/root", "code_stack", {
      childIds: ["nn_module/module"],
      file: "/build/model.py",
      line: 9,
    });
    const module = entity("nn_module/module", "nn_module", {
      parentIds: [stack.id as string],
      childIds: ["source_operator/op"],
    });
    const op = entity("source_operator/op", "source_operator", { parentIds: [module.id as string] });

    assert.deepStrictEqual(resolveCodeStackLocation([context(op, [op, module, stack])]), {
      file: "/build/model.py",
      line: 9,
    });
  });

  it("handles cycles while resolving descendants and ancestors", () => {
    const stack = entity("code_stack/root", "code_stack", {
      parentIds: ["code_stack/root"],
      childIds: ["source_operator/op"],
      file: "/build/model.py",
      line: 8,
    });
    const op = entity("source_operator/op", "source_operator", { parentIds: [stack.id as string] });
    const segment = entity("segment/0", "segment", {
      childIds: ["segment/0", op.id as string],
    });

    assert.deepStrictEqual(resolveCodeStackLocation([context(segment, [segment, op, stack])]), {
      file: "/build/model.py",
      line: 8,
    });
  });

  it("reports when an entity has no source-operator descendants", () => {
    const segment = entity("segment/0", "segment");
    assert.strictEqual(
      unresolvedReason([context(segment, [segment])]),
      "entity segment/0 has no source-operator descendants",
    );
  });

  it("does nothing when any source operator lacks code-stack ancestry", () => {
    const stack = entity("code_stack/root", "code_stack", {
      childIds: ["source_operator/a"],
      file: "/build/model.py",
      line: 8,
    });
    const opA = entity("source_operator/a", "source_operator", { parentIds: [stack.id as string] });
    const opB = entity("source_operator/b", "source_operator");
    const segment = entity("segment/0", "segment", { childIds: [opA.id as string, opB.id as string] });

    assert.strictEqual(
      unresolvedReason([context(segment, [segment, opA, opB, stack])]),
      "source operator source_operator/b has no mapped code-stack ancestor",
    );
  });

  it("does nothing when source operators have no common code-stack ancestor", () => {
    const stackA = entity("code_stack/a", "code_stack", {
      childIds: ["source_operator/a"],
      file: "/build/a.py",
      line: 1,
    });
    const stackB = entity("code_stack/b", "code_stack", {
      childIds: ["source_operator/b"],
      file: "/build/b.py",
      line: 2,
    });
    const opA = entity("source_operator/a", "source_operator", { parentIds: [stackA.id as string] });
    const opB = entity("source_operator/b", "source_operator", { parentIds: [stackB.id as string] });
    const segment = entity("segment/0", "segment", { childIds: [opA.id as string, opB.id as string] });

    assert.strictEqual(
      unresolvedReason([context(segment, [segment, opA, opB, stackA, stackB])]),
      "source operators source_operator/a, source_operator/b do not share a mapped code-stack ancestor",
    );
  });

  it("does nothing for an ambiguous equally-close common ancestor", () => {
    const stackA = entity("code_stack/a", "code_stack", { file: "/build/a.py", line: 1 });
    const stackB = entity("code_stack/b", "code_stack", { file: "/build/b.py", line: 2 });
    const op = entity("source_operator/op", "source_operator", {
      parentIds: [stackA.id as string, stackB.id as string],
    });

    assert.strictEqual(
      unresolvedReason([context(op, [op, stackA, stackB])]),
      "entity source_operator/op has multiple equally close mapped code-stack ancestors: code_stack/a, code_stack/b",
    );
  });

  it("requires mappings from multiple results to resolve to the same location", () => {
    const stackA = entity("code_stack/a", "code_stack", { file: "/build/model.py", line: 4 });
    const stackB = entity("code_stack/b", "code_stack", { file: "/build/model.py", line: 5 });

    assert.strictEqual(
      unresolvedReason([context(stackA, [stackA]), context(stackB, [stackB])]),
      "the mapped entities resolve to different source locations: /build/model.py:4, /build/model.py:5",
    );
  });
});

describe("codeStackLocations", () => {
  it("returns valid code-stack file and line attributes only", () => {
    assert.deepStrictEqual(
      codeStackLocations([
        entity("source_operator/op", "source_operator", { file: "ignored.py", line: 1 }),
        entity("code_stack/good", "code_stack", { file: "/build/model.py", line: 27 }),
        entity("code_stack/bad", "code_stack", { file: "/build/bad.py", line: 0 }),
      ]),
      [{ file: "/build/model.py", line: 27 }],
    );
  });
});

describe("mapSourcePath", () => {
  it("uses the longest matching source prefix", () => {
    assert.strictEqual(
      mapSourcePath("/root/build/model/layers/conv.py", {
        "/root/build": "C:/source",
        "/root/build/model": "D:/model",
      }),
      path.normalize("D:/model/layers/conv.py"),
    );
  });

  it("maps relative source prefixes", () => {
    assert.strictEqual(
      mapSourcePath("src/model/layers/conv.py", {
        "src/model": "C:/checkout",
      }),
      path.normalize("C:/checkout/layers/conv.py"),
    );
  });

  it("keeps an unmapped path", () => {
    assert.strictEqual(mapSourcePath("C:/source/model.py", {}), path.normalize("C:/source/model.py"));
  });
});

describe("sourceRevealPlan", () => {
  it("preserves Model Explorer focus and selects all text on the source line", () => {
    assert.deepStrictEqual(sourceRevealPlan(3, 11, 24), {
      showOptions: {
        viewColumn: 3,
        preview: true,
        preserveFocus: true,
      },
      selection: {
        line: 11,
        startCharacter: 0,
        endCharacter: 24,
      },
    });
  });

  it("represents an empty source line as an empty whole-line selection", () => {
    assert.deepStrictEqual(sourceRevealPlan(1, 4, 0).selection, {
      line: 4,
      startCharacter: 0,
      endCharacter: 0,
    });
  });
});

describe("TransientSourceLineBorder", () => {
  interface TestTimer {
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }

  function state() {
    const applications: Array<{ editor: string; ranges: readonly string[] }> = [];
    const timers: TestTimer[] = [];
    let disposed = 0;
    const border = new TransientSourceLineBorder<string, string, TestTimer>(
      {
        setBorder: (editor, ranges) => applications.push({ editor, ranges: [...ranges] }),
        schedule: (callback, delayMs) => {
          const timer = { callback, delayMs, cancelled: false };
          timers.push(timer);
          return timer;
        },
        cancel: (timer) => {
          timer.cancelled = true;
        },
        disposeBorder: () => {
          disposed += 1;
        },
      },
      1_500,
    );
    return { border, applications, timers, disposed: () => disposed };
  }

  it("shows the border immediately and removes it after the timeout", () => {
    const test = state();
    test.border.show("editor-a", "line-7");

    assert.deepStrictEqual(test.applications, [
      { editor: "editor-a", ranges: ["line-7"] },
    ]);
    assert.strictEqual(test.timers[0].delayMs, 1_500);

    test.timers[0].callback();
    assert.deepStrictEqual(test.applications[1], { editor: "editor-a", ranges: [] });
  });

  it("moves a repeated border safely and clears it on disposal", () => {
    const test = state();
    test.border.show("editor-a", "line-1");
    test.border.show("editor-b", "line-2");

    assert.strictEqual(test.timers[0].cancelled, true);
    assert.deepStrictEqual(test.applications, [
      { editor: "editor-a", ranges: ["line-1"] },
      { editor: "editor-a", ranges: [] },
      { editor: "editor-b", ranges: ["line-2"] },
    ]);

    test.timers[0].callback();
    assert.strictEqual(test.applications.length, 3);

    test.border.dispose();
    assert.strictEqual(test.timers[1].cancelled, true);
    assert.deepStrictEqual(test.applications[3], { editor: "editor-b", ranges: [] });
    assert.strictEqual(test.disposed(), 1);

    test.border.show("editor-c", "line-3");
    assert.strictEqual(test.applications.length, 4);
  });
});

describe("sourceViewColumn", () => {
  it("reuses the group containing an existing hidden or visible tab", () => {
    assert.strictEqual(
      sourceViewColumn(
        "file:///C:/source/model.py",
        [{ uri: "file:///C:/source/model.py", viewColumn: 3 }],
        [1, 2, 3],
        2,
      ),
      3,
    );
  });

  it("uses the first non-Model-Explorer group when the file is not open", () => {
    assert.strictEqual(sourceViewColumn("file:///C:/source/model.py", [], [1, 2, 3], 2), 1);
  });

  it("requests a new beside group when Model Explorer is the only group", () => {
    assert.strictEqual(sourceViewColumn("file:///C:/source/model.py", [], [2], 2), undefined);
  });
});
