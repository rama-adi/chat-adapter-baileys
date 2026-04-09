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

- **[Migrating from v1 to v2](./migration/v1-to-v2.md)** — Breaking changes and step-by-step upgrade guide

---

## Quick Reference

**Common imports:**

```typescript
import { createBaileysAdapter } from "chat-adapter-baileys";
import { Chat } from "chat";
import { useMultiFileAuthState } from "baileys";
```

**Basic bot structure:**

```typescript
const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
const whatsapp = createBaileysAdapter({ auth: { state, saveCreds } });
const bot = new Chat({ adapters: { whatsapp } });

bot.onNewMention(async (thread, message) => {
  await thread.post("Hello!");
  await thread.subscribe();
});

await bot.initialize();
await whatsapp.connect();
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
