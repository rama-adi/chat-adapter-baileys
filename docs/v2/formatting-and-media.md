# Formatting and Media

This guide covers how text formatting and media work when sending and receiving messages through the WhatsApp adapter.

Related docs:

- [Quickstart](./quickstart.md) — basic setup and sending messages
- [Concepts](./concepts.md) — how Chat SDK concepts map to WhatsApp
- [Events and Lifecycle](./events-and-lifecycle.md) — connection flow and message handling
- [Extensions](./extensions.md) — WhatsApp-specific methods like location and polls
- [Thread IDs and Multi-Account](./thread-ids-and-multi-account.md) — working with multiple accounts
- [Error Handling](./error-handling.md) — validation errors and troubleshooting
- [Migrating from v1 to v2](../migration/v1-to-v2.md) — upgrade guide

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
| `fetchData()` | `(() => Promise<Buffer>) \| undefined` | Downloads the binary content on demand. `undefined` if the socket is disconnected. |

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

## Sending attachments

`thread.post()` (and the `reply()` extension) accept the standard Chat SDK media fields — `attachments` or `files` — on **any** postable shape: `raw`, `markdown`, `ast`, or `card`. The adapter maps each item to the right Baileys media payload (`image`, `video`, `audio`, or `document`) and derives the caption from whichever text shape you used, so `**Bold**` in `markdown` still renders as WhatsApp's `*Bold*` when attached as a caption.

| Postable shape | `attachments?` | `files?` | Caption source |
|---|---|---|---|
| `{ raw: "..." }` | ✓ | ✓ | `raw` passed through |
| `{ markdown: "..." }` | ✓ | ✓ | rendered to WhatsApp formatting |
| `{ ast: Root }` | ✓ | ✓ | rendered from the AST |
| `{ card: ..., files?: ... }` | — | ✓ | card's plain-text fallback |

### How text + media combine

When the message has both text and at least one non-audio attachment:

- The text is attached as a **caption** on the first image/video/document.
- Any remaining attachments are sent as follow-up messages without captions.

When every attachment is audio (WhatsApp audio doesn't support captions):

- The text is sent first as a standalone message.
- Each audio attachment follows as its own message.

The returned `RawMessage` is always the **first** message sent, so code that relies on the return value (e.g. `const sent = await thread.post(...); sent.id`) keeps working.

### Sending with `files` (FileUpload)

`files` is the simplest way to attach binary content you already have in memory. The adapter picks the Baileys media type from the `mimeType`:

| `mimeType` prefix | Baileys type |
|---|---|
| `image/*` | `image` |
| `video/*` | `video` |
| `audio/*` | `audio` |
| anything else (or missing) | `document` (with `fileName`) |

```ts
import fs from "fs/promises";

bot.onSubscribedMessage(async (thread, message) => {
  if (message.text !== "/photo") return;

  const data = await fs.readFile("./assets/banner.png");

  await thread.post({
    raw: "Here's the banner:",
    files: [
      { data, filename: "banner.png", mimeType: "image/png" },
    ],
  });
});
```

Send a PDF as a document:

```ts
await thread.post({
  raw: "Latest report attached",
  files: [
    { data: pdfBuffer, filename: "report.pdf", mimeType: "application/pdf" },
  ],
});
```

Attach to a markdown message — the caption is rendered to WhatsApp formatting before sending:

```ts
await thread.post({
  markdown: "**Heads up:** please review the attached draft.",
  files: [
    { data: pdfBuffer, filename: "draft.pdf", mimeType: "application/pdf" },
  ],
});
// Caption on WhatsApp reads: *Heads up:* please review the attached draft.
```

Cards also accept `files`. The card's plain-text fallback becomes the caption:

```ts
import { Card } from "chat";

await thread.post({
  card: new Card({ title: "Order #1234", fields: [{ label: "Status", value: "Shipped" }] }),
  files: [{ data: labelPdf, filename: "label.pdf", mimeType: "application/pdf" }],
});
```

### Sending with `attachments` (Attachment)

`attachments` uses the same shape the adapter populates for **incoming** messages, so you can forward a received attachment straight back out:

```ts
bot.onSubscribedMessage(async (thread, message) => {
  for (const inbound of message.attachments) {
    // Re-send the received media into the same thread.
    // `fetchData` is called internally to download the bytes.
    await thread.post({
      raw: `Echo: ${inbound.name ?? inbound.type}`,
      attachments: [inbound],
    });
  }
});
```

`Attachment` supports three data sources, tried in order:

1. `data` — a `Buffer` or `Blob` already in memory
2. `fetchData()` — a lazy download function (used for inbound attachments)
3. `url` — a remote URL; Baileys downloads it server-side via `{ image: { url } }`

```ts
// Send by URL
await thread.post({
  raw: "From the CDN:",
  attachments: [
    {
      type: "image",
      mimeType: "image/jpeg",
      name: "hero",
      url: "https://example.com/hero.jpg",
    },
  ],
});
```

If an attachment has none of `data`, `fetchData`, or `url`, a `ValidationError` is thrown.

### Combining multiple attachments

Multiple attachments become multiple `sendMessage` calls, in the order you provide them:

```ts
await thread.post({
  raw: "Two files:",
  files: [
    { data: imgBuffer, filename: "chart.png", mimeType: "image/png" },
    { data: pdfBuffer, filename: "notes.pdf", mimeType: "application/pdf" },
  ],
});
// 1st send: image with caption "Two files:"
// 2nd send: document "notes.pdf" (no caption)
```

### Quoted replies with attachments

The `reply()` extension accepts the same postable shapes, so you can send a quoted reply that also carries an attachment. Only the first outgoing message carries the quote reference — matching WhatsApp's native behaviour when sending multiple items back-to-back.

```ts
import { requireBaileysAdapter } from "chat-adapter-baileys";

bot.onSubscribedMessage(async (thread, message) => {
  if (message.text !== "/screenshot") return;

  const wa = requireBaileysAdapter(thread);
  const shot = await takeScreenshot();

  await wa.reply(message, {
    raw: "Here's what I saw:",
    files: [{ data: shot, filename: "shot.png", mimeType: "image/png" }],
  });
});
```

See [`reply()`](./extensions.md#replymessage-content--quoted-reply) in the extensions doc for the full signature.

### Limitations

- **`editMessage` is text-only.** WhatsApp can edit a caption in place, but the adapter currently updates only the message text. Editing attachment data isn't supported.
- **Audio can't carry a caption.** When text is combined with audio-only attachments, the text is sent as a separate preceding message.
- **URL sources require a publicly reachable URL.** Baileys downloads the URL server-side before sending; local-only URLs won't work.

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
