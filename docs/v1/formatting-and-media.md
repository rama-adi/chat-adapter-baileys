# Formatting And Media

---

## Text formatting

WhatsApp uses its own lightweight markup syntax that differs from standard Markdown. The adapter's `BaileysFormatConverter` handles conversion in both directions:

- **Inbound** (WhatsApp → Chat SDK): raw WhatsApp-formatted text is parsed into a Chat SDK AST (`message.formatted`).
- **Outbound** (Chat SDK → WhatsApp): when you call `thread.post(...)`, the Chat SDK content is rendered into WhatsApp-compatible markup before sending.

### Format mapping

| Chat SDK / Markdown | WhatsApp syntax | Example |
|---|---|---|
| `**bold**` (strong) | `*bold*` | `*Hello*` |
| `_italic_` (emphasis) | `_italic_` | `_note:_` |
| `~~strikethrough~~` (delete) | `~strikethrough~` | `~removed~` |
| `` `code` `` (inline code) | `` `code` `` | `` `null` `` |
| ` ``` ` code block | ` ``` ` code block | multi-line |
| `[text](url)` link | `text (url)` plain text | links degrade gracefully |

### Sending formatted text

When you pass a string to `thread.post()`, the Chat SDK treats it as plain text. To send formatted content, use the Chat SDK's rich-text helpers or markdown string:

```ts
// Plain text — no formatting
await thread.post("Hello world");

// Markdown string — the adapter converts it to WhatsApp format before sending
await thread.post("*Bold* and _italic_ and ~strikethrough~");
// Sent to WhatsApp as: *Bold* and _italic_ and ~strikethrough~

// Inline code
await thread.post("Use the `start` command to begin.");

// Code block
await thread.post("```\nconst x = 1;\nconsole.log(x);\n```");
```

### Reading formatted content from incoming messages

Every incoming `message` object has both `message.text` (plain string) and `message.formatted` (parsed AST). Use `message.text` for simple string matching and `message.formatted` for semantic access to the structure:

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

## Cards (not natively supported)

The Chat SDK has a `Card` abstraction for structured messages with titles, fields, buttons, and images (like Slack attachments or Teams adaptive cards). WhatsApp's unofficial API does not support this format.

When you send a card, the adapter automatically converts it to a human-readable plain-text fallback:

```ts
import { Card } from "chat";

const card = new Card({
  title: "Order #1234",
  fields: [
    { label: "Status", value: "Shipped" },
    { label: "ETA", value: "Tomorrow" },
  ],
});

// The adapter renders this as something like:
// Order #1234
// Status: Shipped
// ETA: Tomorrow
await thread.post(card);
```

If you need rich formatting on WhatsApp, compose the message as a formatted string instead of a card.

---

## Incoming media attachments

When someone sends an image, video, audio message, or file to a group or DM that your bot is in, the adapter populates `message.attachments` with metadata and a lazy download function.

### Attachment fields

| Field | Type | Description |
|---|---|---|
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

### Downloading attachment data

`fetchData()` downloads the binary content from WhatsApp's media servers. Downloads happen lazily — nothing is fetched until you call `fetchData()`. The result is a `Buffer`.

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
