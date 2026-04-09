# chat-adapter-baileys Documentation

Complete guide for building WhatsApp bots with the Chat SDK.

## Getting Started

New to the adapter? Start here:

1. **[Quickstart](./quickstart.md)** — Install, configure, and run your first WhatsApp bot in 10 minutes
2. **[Concepts](./concepts.md)** — Understand how Chat SDK concepts map to WhatsApp
3. **[Runnable Example](./example.ts)** — Full working code with common patterns

## Core Topics

### Connection and Lifecycle

- **[Events and Lifecycle](./events-and-lifecycle.md)** — Connection flow, auth (QR and pairing code), reconnection behavior, and message flow

### Thread Management

- **[Thread IDs and Multi-Account](./thread-ids-and-multi-account.md)** — Understanding thread IDs, running multiple WhatsApp accounts, and proactive DM opening

### Messages and Media

- **[Formatting and Media](./formatting-and-media.md)** — Text formatting, cards, downloading media attachments, and the BaileysFormatConverter
- **[Extensions](./extensions.md)** — WhatsApp-specific methods: quoted replies, read receipts, location pins, polls, and group participants

### Error Handling

- **[Error Handling](./error-handling.md)** — Common validation errors, how to handle them, and best practices for production bots

## Migration

- **[Migrating from v1 to v2](../migration/v1-to-v2.md)** — Breaking changes and step-by-step upgrade guide

---

## Quick Reference

**Package exports:**

```typescript
import {
  createBaileysAdapter,   // Factory function
  BaileysAdapter,         // Class (for type annotations)
  BaileysFormatConverter, // Text format converter
  isBaileysAdapter,       // Type guard
  requireBaileysAdapter,  // Type assertion
} from "chat-adapter-baileys";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
```

**QR code authentication (most common):**

```typescript
const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "my-bot",
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});

const bot = new Chat({
  userName: "my-bot",
  adapters: { whatsapp },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.post("Hello!");
  await thread.subscribe();
});

await bot.initialize();
await whatsapp.connect();
```

**Pairing code authentication (alternative):**

```typescript
const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "my-bot",
  phoneNumber: "12345678901",  // E.164 format, no "+"
  onPairingCode: (code) => {
    console.log("Enter this code in WhatsApp → Linked Devices:", code);
  },
});
```

**Accessing WhatsApp-specific methods:**

```typescript
import { requireBaileysAdapter } from "chat-adapter-baileys";

bot.onSubscribedMessage(async (thread, message) => {
  const wa = requireBaileysAdapter(thread);
  await wa.reply(message, "Got it!");
  await wa.markRead(thread.threadId, [message.id]);
});
```

---

## Need Help?

- Check the **[Error Handling](./error-handling.md)** guide for common issues
- Review the **[Runnable Example](./example.ts)** for complete working code
- See **[Concepts](./concepts.md)** for architectural understanding

## Package Info

- **npm:** `chat-adapter-baileys`
- **Repository:** Part of the Chat SDK ecosystem
- **Baileys version:** `7.0.0-rc.9`
