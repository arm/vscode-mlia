export class HtmlMarkup {
  public constructor(public readonly value: string) {}

  public toString(): string {
    return this.value;
  }
}

export type HtmlChild = HtmlMarkup | string | number | false | null | undefined | HtmlChild[];

export function createElement(
  tag: string | ((properties: Record<string, unknown>) => HtmlMarkup),
  properties: Record<string, unknown> | null,
  ...children: HtmlChild[]
): HtmlMarkup {
  const props = properties ?? {};
  if (typeof tag === "function") {
    return tag({ ...props, children });
  }

  const attributes = Object.entries(props)
    .filter(([name, value]) => name !== "children" && value !== false && value !== undefined && value !== null)
    .map(([name, value]) => {
      const attribute = name === "className" ? "class" : name;
      return value === true ? attribute : `${attribute}="${escapeHtml(String(value))}"`;
    })
    .join(" ");
  const opening = attributes ? `<${tag} ${attributes}>` : `<${tag}>`;
  if (voidElements.has(tag)) {
    return new HtmlMarkup(opening);
  }
  return new HtmlMarkup(`${opening}${children.map(renderChild).join("")}</${tag}>`);
}

function renderChild(child: HtmlChild): string {
  if (child instanceof HtmlMarkup) {
    return child.value;
  }
  if (Array.isArray(child)) {
    return child.map(renderChild).join("");
  }
  if (child === false || child === null || child === undefined) {
    return "";
  }
  return escapeHtml(String(child));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

const voidElements = new Set(["input", "br", "hr", "img", "meta", "link"]);
