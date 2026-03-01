import {
  BaseFormatConverter,
  parseMarkdown,
  type AdapterPostableMessage,
  type Root,
} from "chat";

/**
 * Format converter for WhatsApp (Baileys).
 *
 * WhatsApp uses its own lightweight markup:
 * - `*bold*`         → strong
 * - `_italic_`       → emphasis
 * - `~strikethrough~`→ delete
 * - `` `code` ``     → inlineCode
 * - ```` ```block``` ````  → code block
 *
 * Standard Markdown links are not supported by WhatsApp — links become
 * `text (url)` in the platform output.
 */
export class BaileysFormatConverter extends BaseFormatConverter {
  /**
   * Convert WhatsApp-formatted text to mdast AST.
   * Pre-processes WhatsApp-specific syntax to standard Markdown before parsing.
   */
  toAst(platformText: string): Root {
    const markdown = platformText
      // WhatsApp *bold* → Markdown **bold**
      // Match single asterisks not already doubled
      .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, "**$1**")
      // WhatsApp ~strikethrough~ → Markdown ~~strikethrough~~
      .replace(/(?<!~)~([^~\n]+?)~(?!~)/g, "~~$1~~");
    return parseMarkdown(markdown);
  }

  /**
   * Convert mdast AST to WhatsApp text format.
   */
  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) =>
      this.convertNode(node as AnyNode)
    );
  }

  private convertNode(node: AnyNode): string {
    switch (node.type) {
      case "text":
        return node.value ?? "";

      case "strong":
        return `*${this.convertChildren(node.children ?? [])}*`;

      case "emphasis":
        return `_${this.convertChildren(node.children ?? [])}_`;

      case "delete":
        return `~${this.convertChildren(node.children ?? [])}~`;

      case "inlineCode":
        return `\`${node.value}\``;

      case "code":
        return `\`\`\`\n${node.value}\n\`\`\``;

      case "link": {
        const linkText = this.convertChildren(node.children ?? []);
        return node.url ? `${linkText} (${node.url})` : linkText;
      }

      case "paragraph":
        return this.convertChildren(node.children ?? []);

      case "blockquote":
        return (node.children ?? [])
          .map((child: AnyNode) => {
            const text = this.convertNode(child);
            return text
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n");
          })
          .join("\n");

      case "list":
        return (node.children ?? [])
          .map((item: AnyNode, index: number) =>
            node.ordered
              ? `${index + 1}. ${this.convertChildren(item.children ?? [])}`
              : `- ${this.convertChildren(item.children ?? [])}`
          )
          .join("\n");

      case "listItem":
        return this.convertChildren(node.children ?? []);

      case "break":
        return "\n";

      default:
        return (node as { value?: string }).value ?? "";
    }
  }

  private convertChildren(children: AnyNode[]): string {
    return (children ?? []).map((child) => this.convertNode(child)).join("");
  }
}

// Minimal local type to avoid deep mdast imports
type AnyNode = {
  type: string;
  value?: string;
  url?: string;
  ordered?: boolean;
  children?: AnyNode[];
};
