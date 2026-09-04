import { SourceAnnotationIndex } from "./sourceAnnotations";
import { sourceRecordMatchesOverlay } from "./sourceLines";

export interface DecorationEditor {
  uri: string;
  lineCount: number;
}

export interface SourceDecorationHost<Editor, Decoration> {
  editorUri: (editor: Editor) => string;
  editorLineCount: (editor: Editor) => number;
  createDecoration: (rgba: string) => Decoration;
  setDecoratedLines: (editor: Editor, decoration: Decoration, zeroBasedLines: number[]) => void;
  disposeDecoration: (decoration: Decoration) => void;
}

export class SourceDecorationManager<Editor, Decoration> {
  private visibleEditors: Editor[] = [];
  private readonly decorationsByColor = new Map<string, Decoration>();
  private readonly annotationSubscription: { dispose: () => void };
  private enabled = true;

  public constructor(
    private readonly host: SourceDecorationHost<Editor, Decoration>,
    private readonly annotations: SourceAnnotationIndex,
  ) {
    this.annotationSubscription = annotations.subscribe(() => this.applyToVisibleEditors());
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    if (enabled) {
      this.applyToVisibleEditors();
      return;
    }
    this.clearVisibleEditorsAndDisposeDecorations();
  }

  public updateVisibleEditors(editors: readonly Editor[]): void {
    const nextEditors = new Set(editors);
    for (const editor of this.visibleEditors) {
      if (!nextEditors.has(editor)) {
        this.clearEditor(editor);
      }
    }
    this.visibleEditors = [...editors];
    this.applyToVisibleEditors();
  }

  public dispose(): void {
    this.annotationSubscription.dispose();
    this.clearVisibleEditorsAndDisposeDecorations();
    this.visibleEditors = [];
  }

  private applyToVisibleEditors(): void {
    if (!this.enabled) {
      return;
    }

    const linesByEditor = new Map<Editor, Map<string, number[]>>();
    const visibleColors = new Set<string>();
    for (const editor of this.visibleEditors) {
      const lineCount = this.host.editorLineCount(editor);
      const linesByColor = new Map<string, number[]>();
      for (const record of this.annotations.sourceLineRecordsForUri(this.host.editorUri(editor))) {
        const line = record.line - 1;
        if (
          record.selectedOverlay === undefined ||
          !sourceRecordMatchesOverlay(record, record.selectedOverlay) ||
          line < 0 ||
          line >= lineCount
        ) {
          continue;
        }
        const lines = linesByColor.get(record.color.rgba) ?? [];
        if (!lines.includes(line)) {
          lines.push(line);
        }
        linesByColor.set(record.color.rgba, lines);
        visibleColors.add(record.color.rgba);
      }
      linesByEditor.set(editor, linesByColor);
    }

    for (const editor of this.visibleEditors) {
      this.clearEditor(editor);
    }
    for (const [color, decoration] of [...this.decorationsByColor]) {
      if (!visibleColors.has(color)) {
        this.host.disposeDecoration(decoration);
        this.decorationsByColor.delete(color);
      }
    }
    for (const color of visibleColors) {
      if (!this.decorationsByColor.has(color)) {
        this.decorationsByColor.set(color, this.host.createDecoration(color));
      }
    }
    for (const [editor, linesByColor] of linesByEditor) {
      for (const [color, lines] of linesByColor) {
        const decoration = this.decorationsByColor.get(color) as Decoration;
        this.host.setDecoratedLines(editor, decoration, lines.sort((left, right) => left - right));
      }
    }
  }

  private clearVisibleEditorsAndDisposeDecorations(): void {
    for (const editor of this.visibleEditors) {
      this.clearEditor(editor);
    }
    for (const decoration of this.decorationsByColor.values()) {
      this.host.disposeDecoration(decoration);
    }
    this.decorationsByColor.clear();
  }

  private clearEditor(editor: Editor): void {
    for (const decoration of this.decorationsByColor.values()) {
      this.host.setDecoratedLines(editor, decoration, []);
    }
  }
}
