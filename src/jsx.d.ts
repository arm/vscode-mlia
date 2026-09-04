declare namespace JSX {
  type Element = import("./webviewHtml").HtmlMarkup;

  interface IntrinsicElements {
    [elementName: string]: Record<string, unknown>;
  }
}
