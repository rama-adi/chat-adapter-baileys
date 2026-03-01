import { describe, expect, it } from "vitest";
import type { Paragraph, Root, Text } from "mdast";
import { BaileysFormatConverter } from "./format-converter.js";

const converter = new BaileysFormatConverter();

// ---------------------------------------------------------------------------
// toAst — WhatsApp markup → mdast
// ---------------------------------------------------------------------------

describe("BaileysFormatConverter.toAst", () => {
  it("converts WhatsApp bold (*text*) to a strong node", () => {
    const ast = converter.toAst("*hello*");
    const para = ast.children[0] as Paragraph;
    expect(para.type).toBe("paragraph");
    expect(para.children[0].type).toBe("strong");
  });

  it("converts WhatsApp italic (_text_) to an emphasis node", () => {
    const ast = converter.toAst("_hello_");
    const para = ast.children[0] as Paragraph;
    expect(para.children[0].type).toBe("emphasis");
  });

  it("converts WhatsApp strikethrough (~text~) to a delete node", () => {
    const ast = converter.toAst("~hello~");
    const para = ast.children[0] as Paragraph;
    expect(para.children[0].type).toBe("delete");
  });

  it("keeps standard inline code (`text`) unchanged as inlineCode", () => {
    const ast = converter.toAst("`code`");
    const para = ast.children[0] as Paragraph;
    expect(para.children[0].type).toBe("inlineCode");
  });

  it("does not double-convert already-Markdown bold (**text**)", () => {
    // Double asterisks are not touched by the pre-processor — they remain as strong
    const ast = converter.toAst("**bold**");
    const para = ast.children[0] as Paragraph;
    expect(para.children[0].type).toBe("strong");
  });

  it("parses plain text as a text node", () => {
    const ast = converter.toAst("plain text");
    const para = ast.children[0] as Paragraph;
    const textNode = para.children[0] as Text;
    expect(textNode.type).toBe("text");
    expect(textNode.value).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// fromAst — mdast → WhatsApp markup
// ---------------------------------------------------------------------------

describe("BaileysFormatConverter.fromAst", () => {
  it("renders a strong node as WhatsApp bold (*text*)", () => {
    const result = converter.fromAst(converter.toAst("*hello*"));
    expect(result).toContain("*hello*");
  });

  it("renders an emphasis node as WhatsApp italic (_text_)", () => {
    const result = converter.fromAst(converter.toAst("_hello_"));
    expect(result).toContain("_hello_");
  });

  it("renders a delete node as WhatsApp strikethrough (~text~)", () => {
    const result = converter.fromAst(converter.toAst("~hello~"));
    expect(result).toContain("~hello~");
  });

  it("renders an inlineCode node as backtick code", () => {
    const result = converter.fromAst(converter.toAst("`code`"));
    expect(result).toContain("`code`");
  });

  it("renders a link as text (url) since WA does not support MD links", () => {
    const result = converter.fromAst(converter.toAst("[Click](https://example.com)"));
    expect(result).toContain("Click");
    expect(result).toContain("https://example.com");
  });

  it("renders an unordered list with dashes", () => {
    const result = converter.fromAst(converter.toAst("- item one\n- item two"));
    expect(result).toContain("- item one");
    expect(result).toContain("- item two");
  });

  it("renders an ordered list with numbers", () => {
    const result = converter.fromAst(converter.toAst("1. first\n2. second"));
    expect(result).toContain("1. first");
    expect(result).toContain("2. second");
  });

  it("renders a code block with triple backticks", () => {
    const result = converter.fromAst(converter.toAst("```\nconsole.log(1)\n```"));
    expect(result).toContain("```");
    expect(result).toContain("console.log(1)");
  });

  it("renders blockquotes line-by-line with > prefixes", () => {
    const result = converter.fromAst(converter.toAst("> first line\n> second line"));
    expect(result).toContain("> first line");
    expect(result).toContain("> second line");
  });

  it("renders links with empty url as plain link text", () => {
    const ast: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "",
              children: [{ type: "text", value: "Label" }],
            },
          ],
        },
      ],
    };
    expect(converter.fromAst(ast)).toContain("Label");
    expect(converter.fromAst(ast)).not.toContain("()");
  });

  it("falls back to node.value for unknown node types", () => {
    const ast = {
      type: "root",
      children: [{ type: "mystery", value: "x" }],
    } as unknown as Root;
    expect(converter.fromAst(ast)).toBe("x");
  });

  it("renders mdast break nodes as newlines", () => {
    const ast = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a" },
            { type: "break" },
            { type: "text", value: "b" },
          ],
        },
      ],
    } as unknown as Root;
    expect(converter.fromAst(ast)).toContain("a\nb");
  });

  it("renders listItem nodes by converting their children", () => {
    const ast = {
      type: "root",
      children: [{ type: "listItem", children: [{ type: "text", value: "solo-item" }] }],
    } as unknown as Root;
    expect(converter.fromAst(ast)).toContain("solo-item");
  });

  it("roundtrips plain text unchanged", () => {
    const text = "hello world";
    expect(converter.fromAst(converter.toAst(text)).trim()).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// renderPostable — AdapterPostableMessage → WhatsApp string
// ---------------------------------------------------------------------------

describe("BaileysFormatConverter.renderPostable", () => {
  it("renders a plain string as-is", () => {
    const result = converter.renderPostable("plain message");
    expect(result.trim()).toBe("plain message");
  });

  it("renders { markdown } with WhatsApp bold format", () => {
    // **bold** (standard MD) should become *bold* (WhatsApp)
    const result = converter.renderPostable({ markdown: "**bold**" });
    expect(result).toContain("*bold*");
    // Must not double-wrap as **bold**
    expect(result).not.toMatch(/\*\*bold\*\*/);
  });

  it("renders { markdown } with WhatsApp italic format", () => {
    const result = converter.renderPostable({ markdown: "_italic_" });
    expect(result).toContain("_italic_");
  });
});
