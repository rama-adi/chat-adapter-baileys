# Formatting and media

This guide covers how text formatting and media work when sending and receiving messages through the WhatsApp adapter.

Related docs:

- [Quickstart](./quickstart.md) — basic setup and sending messages
- [Extensions](./extensions.md) — WhatsApp-specific methods like location and polls
- [Error handling](./error-handling.md) — validation errors and troubleshooting

---

## Text formatting

WhatsApp uses its own lightweight markup syntax. The adapter's `BaileysFormatConverter` handles conversion in both directions:

- **Inbound** (WhatsApp → Chat SDK): raw WhatsApp-formatted text is parsed into a Chat SDK AST (`message.formatted`)
- **Outbound** (Chat SDK → WhatsApp): Chat SDK content is rendered into WhatsApp-compatible markup before sending

### Format mapping

| Chat SDK / Markdown | WhatsApp syntax | Example |
|---------------------|-----------------|---------|
| `**bold**` (strong) | `*bold*` | `*Hello*` |
| `_italic_` (emphasis) | `_italic_` | `_note:_` |
| `~~strikethrough~~` (delete) | `~strikethrough~` | `~removed~` |
| `` `code` `` (inline code) | `` `code` `` | `` `null` `` |
| Code block | Code block | Multi-line with triple backticks |
| `[text](url)` link | Plain text | Links degrade gracefully |

### Sending formatted text

When you pass a string to `thread.post()`, the Chat SDK treats it as plain text. To send formatted content, use markdown syntax:

```ts
// Plain text — no formatting
await thread.post("Hello world");

// Markdown string — converted to WhatsApp format automatically
await thread.post("*Bold* and _italic_ and ~strikethrough~");
// Sent to WhatsApp as: *Bold* and _italic_ and ~strikethrough~

// Inline code
await thread.post("Use the `start` command to begin.");

// Code block
await thread.post("```\nconst x = 1;\nconsole.log(x);\n```");
```

### Reading formatted content

Every incoming `message` object has both:

- `message.text` — plain string
- `message.formatted` — parsed AST

Use `message.text` for simple string matching and `message.formatted` for semantic access to the structure:

```ts
bot.onSubscribedMessage(async (thread, message) => {
  // Simple plain-text check
  if (message.text.toLowerCase().includes("help")) {
    await thread.post("Here's what I can do: ...");
    return;
  }

  // Access the parsed AST for richer inspection
  console.log(JSON.stringify(message.formatted, null, 2));
});
```

---

## Cards

The Chat SDK has a `Card` abstraction for structured messages with titles, fields, buttons, and images (like Slack attachments or Teams adaptive cards). WhatsApp's unofficial API does not support this format.

When you send a card, the adapter converts it to a human-readable plain-text fallback:

```ts
import { Card } from "chat";

const card = new Card({
  title: "Order #1234",
  fields: [
    { label: "Status", value: "Shipped" },
    { label: "ETA", value: "Tomorrow" },
  ],
});

// The adapter renders this as:
// Order #1234
// Status: Shipped
// ETA: Tomorrow
await thread.post(card);
```

If you need rich formatting on WhatsApp, compose the message as a formatted string instead of a card.

---

## Incoming media

When someone sends an image, video, audio message, or file to your bot, the adapter populates `message.attachments` with metadata and a lazy download function.

### Attachment fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"image"` \| `"video"` \| `"audio"` \| `"file"` | Media category |
| `mimeType` | `string` | MIME type (e.g. `"image/jpeg"`, `"video/mp4"`) |
| `name` | `string` | File name (documents use the original filename; others use the type name) |
| `fetchData()` | `() => Promise<Buffer>` | Downloads the binary content on demand |

### Checking for attachments

```ts
bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;

  if (message.attachments.length === 0) {
    // Text-only message
    await thread.post(`You said: ${message.text}`);
    return;
  }

  // Describe each attachment without downloading
  const lines = message.attachments.map(
    (a) => `• ${a.type} — ${a.mimeType} (${a.name})`
  );
  await thread.post(`Received ${message.attachments.length} file(s):\n${lines.join("\n")}`);
});
```

### Downloading attachments

`fetchData()` downloads the binary content from WhatsApp's media servers. Downloads happen lazily — nothing is fetched until you call it. The result is a `Buffer`.

```ts
import fs from "fs/promises";
import path from "path";

bot.onSubscribedMessage(async (thread, message) => {
  for (const attachment of message.attachments) {
    if (!attachment.fetchData) continue;

    // Download the file
    const buffer = await attachment.fetchData();

    // Save it to disk
    const ext = attachment.mimeType?.split("/")[1] ?? "bin";
    const filename = `${attachment.name ?? attachment.type}.${ext}`;
    await fs.writeFile(path.join("./downloads", filename), buffer);

    await thread.post(`Saved ${filename} (${buffer.byteLength} bytes)`);
  }
});
```

### Handling specific media types

```ts
bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;

  for (const attachment of message.attachments) {
    switch (attachment.type) {
      case "image": {
        const buffer = await attachment.fetchData?.();
        if (buffer) {
          // e.g. pass to an image recognition API
          await thread.post(`Got an image (${buffer.byteLength} bytes)`);
        }
        break;
      }
      case "audio": {
        // e.g. pass to a speech-to-text service
        await thread.post("Got a voice message — transcription coming...");
        break;
      }
      case "file": {
        await thread.post(`Got a file: ${attachment.name}`);
        break;
      }
    }
  }
});
```

> **Note:** Media URLs on WhatsApp expire. Download attachment data promptly if you need it — don't store the `fetchData` reference and call it later after a long delay.

---

## Using BaileysFormatConverter directly

The adapter uses `BaileysFormatConverter` internally to convert between WhatsApp markup and Chat SDK's AST format. You can access this converter through the adapter if you need custom formatting logic.

### When to use it directly

Most users won't need this — `thread.post()` handles formatting automatically. But you might want direct access for:

- **Testing:** Verify how your markdown renders to WhatsApp format
- **Preprocessing:** Convert WhatsApp-formatted strings from external sources
- **Custom rendering:** Build formatted strings programmatically

### Converting WhatsApp to AST

Import `BaileysFormatConverter` directly and use `toAst()` to parse WhatsApp-formatted text into a Chat SDK AST:

```ts
import { BaileysFormatConverter } from "chat-adapter-baileys";

const converter = new BaileysFormatConverter();

// Parse WhatsApp text to AST
const ast = converter.toAst("*Bold* and _italic_");
// Returns Chat SDK AST structure

// Render AST back to WhatsApp format
const whatsappOutput = converter.fromAst(ast);
// Returns: "*Bold* and _italic_"
```

### Converting custom content

The converter extends `BaseFormatConverter` from the Chat SDK, so it can handle any Chat SDK AST structure:

```ts
import { BaileysFormatConverter } from "chat-adapter-baileys";
import type { Root } from "chat";

const converter = new BaileysFormatConverter();

// Build an AST programmatically
const customAst: Root = {
  type: "root",
  children: [
    {
      type: "paragraph",
      children: [
        { type: "text", value: "Check out this " },
        { type: "strong", children: [{ type: "text", value: "bold" }] },
        { type: "text", value: " link:" },
      ],
    },
    {
      type: "paragraph",
      children: [
        {
          type: "link",
          url: "https://example.com",
          children: [{ type: "text", value: "Click here" }],
        },
      ],
    },
  ],
};

// Convert to WhatsApp format
const whatsappText = converter.fromAst(customAst);
// Returns:
// "Check out this *bold* link:\nClick here (https://example.com)"
```

### Format conversion reference

The converter handles these mappings:

| WhatsApp input | AST node type | Back to WhatsApp |
|----------------|---------------|------------------|
| `*text*` | `strong` | `*text*` |
| `_text_` | `emphasis` | `_text_` |
| `~text~` | `delete` | `~text~` |
| `` `code` `` | `inlineCode` | `` `code` `` |
| ```` ```code``` ```` | `code` | Triple backticks |
| `[text](url)` | `link` | `text (url)` |
| `> quote` | `blockquote` | `> quote` |
| `- item` | `list` (unordered) | `- item` |
| `1. item` | `list` (ordered) | `1. item` |

**Note on links:** WhatsApp doesn't support hyperlinks, so the converter renders them as `text (url)` — the URL is preserved but shown in parentheses.

### Testing your formatting

Here's a quick way to test how your markdown will render:

```ts
import { BaileysFormatConverter } from "chat-adapter-baileys";
import { parseMarkdown } from "chat";

const converter = new BaileysFormatConverter();

function previewWhatsAppFormat(markdown: string): string {
  const ast = parseMarkdown(markdown);
  return converter.fromAst(ast);
}

// Test it
console.log(previewWhatsAppFormat("**Bold** and [link](https://example.com)"));
// Output: "*Bold* and link (https://example.com)"
```

This is useful for debugging formatting issues or previewing messages before sending them.
