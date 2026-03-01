# WhatsApp (Baileys) Quickstart

This guide walks you through setting up a Chat SDK bot on WhatsApp using `chat-adapter-baileys`. By the end you will have a bot that can receive and reply to WhatsApp messages.

Related docs:

- [Concepts Mapping](./concepts.md)
- [Events And Lifecycle](./events-and-lifecycle.md)
- [Thread IDs And Multi-Account](./thread-ids-and-multi-account.md)
- [Formatting And Media](./formatting-and-media.md)
- [Runnable Example](./example.ts)

---

## 1. Install

```bash
pnpm add chat-adapter-baileys baileys chat
```

You also need a state backend so the Chat SDK can track which threads your bot has subscribed to. The simplest option for development is the in-memory state package:

```bash
pnpm add @chat-adapter/state-memory
```

Optional — install `qrcode` if you want to render the login QR code right in your terminal:

```bash
pnpm add qrcode
```

---

## 2. Prepare auth state

Before connecting to WhatsApp, you need an auth state. This holds your session credentials (keys, registration info, etc.) so Baileys can authenticate your number.

For local development, `useMultiFileAuthState` is the simplest option. It reads and writes credentials to a folder on disk:

```ts
import { useMultiFileAuthState } from "baileys";

const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
```

- `state` — current credentials object; passed into the adapter.
- `saveCreds` — a callback Baileys calls whenever credentials change. The adapter wires this up for you automatically.
- `"./auth_info"` — the folder where credentials are stored. Created automatically if it doesn't exist.

> **Production note:** `useMultiFileAuthState` stores credentials as plain JSON files. For production, replace it with a database-backed store (e.g. Redis or Postgres) that implements the same interface.

---

## 3. Create the adapter

The adapter is the bridge between Baileys and the Chat SDK. You create it with `createBaileysAdapter()` and pass in your auth state plus any connection options.

### Option A — QR code flow (most common)

When no existing session is found, Baileys generates a QR code that you scan with WhatsApp on your phone (Linked Devices). Provide an `onQR` callback to render it:

```ts
import { createBaileysAdapter } from "chat-adapter-baileys";

const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "my-bot",
  onQR: async (qr) => {
    // Print QR to terminal using the optional `qrcode` package
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});
```

Once you scan the QR, the session is saved to `./auth_info`. On the next startup the credentials are reloaded automatically and no QR scan is needed.

### Option B — Pairing code flow

If you prefer not to scan a QR, you can link via a 8-digit pairing code instead. Provide your phone number (E.164 without the leading `+`) and an `onPairingCode` callback:

```ts
const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  phoneNumber: "12345678901", // e.g. US number: country code 1 + 10 digits
  onPairingCode: (code) => {
    // Show this code to the user; they enter it in WhatsApp → Linked Devices
    console.log("Enter this code in WhatsApp Linked Devices:", code);
  },
});
```

The pairing code is requested once per socket start-up. After the first successful link, credentials are cached and you won't need the code again.

---

## 4. Create a Chat instance and register handlers

The `Chat` class from the `chat` package coordinates all your adapters. You pass the adapter in through the `adapters` map and give it a unique key (here `"whatsapp"`):

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";

const bot = new Chat({
  userName: "my-bot",
  adapters: { whatsapp },       // key can be anything — used internally
  state: createMemoryState(),   // tracks subscriptions, dedup, etc.
});
```

**Register handlers before calling `adapter.connect()`** — if you connect first, messages that arrive during handler registration may be missed.

### Respond when someone mentions the bot in a group

`onNewMention` fires when someone @-mentions the bot in a group thread that the bot hasn't subscribed to yet:

```ts
bot.onNewMention(async (thread, message) => {
  await thread.post(`Hi ${message.author.userName}, I'm here! Send !help for commands.`);
  // Subscribe so future messages in this thread also trigger onSubscribedMessage
  await thread.subscribe();
});
```

### Respond to follow-up messages in subscribed threads

After `thread.subscribe()`, all future messages in that thread are routed to `onSubscribedMessage`:

```ts
bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return; // ignore your own messages

  if (message.text === "!ping") {
    await thread.post("pong");
  }
});
```

### Respond to direct messages

`onNewMessage` with a pattern fires on any message that matches. Filter for DMs with `thread.isDM`:

```ts
bot.onNewMessage(/.+/, async (thread, message) => {
  if (!thread.isDM) return;             // only handle DMs here
  if (message.author.isMe) return;

  await thread.post(`You said: ${message.text}`);
});
```

---

## 5. Connect

Once handlers are registered, call `connect()` to open the WhatsApp WebSocket:

```ts
await whatsapp.connect();
console.log("Bot is running. Scan the QR code if prompted.");
```

The adapter handles automatic reconnection if the connection drops unexpectedly. It does **not** reconnect if you explicitly call `whatsapp.disconnect()` or if the account is logged out from the WhatsApp app.

---

## Full minimal example

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";

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
  await thread.post(`Hello ${message.author.userName}!`);
  await thread.subscribe();
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await thread.post(`Echo: ${message.text}`);
});

await whatsapp.connect();
```

See [example.ts](./example.ts) for a fuller example with commands, media handling, and reactions.

---

## Multi-account in one Chat instance

You can run multiple WhatsApp accounts in a single `Chat` instance. Each account needs its own adapter instance with:

- a **unique `adapterName`** — used to namespace thread IDs so they don't collide across accounts
- a **separate auth state** — each account authenticates independently

```ts
const { state: stateA, saveCreds: saveCredsA } = await useMultiFileAuthState("./auth_main");
const { state: stateB, saveCreds: saveCredsB } = await useMultiFileAuthState("./auth_sales");

const waMain = createBaileysAdapter({
  adapterName: "baileys-main",   // must be unique; no ":" allowed
  auth: { state: stateA, saveCreds: saveCredsA },
});

const waSales = createBaileysAdapter({
  adapterName: "baileys-sales",
  auth: { state: stateB, saveCreds: saveCredsB },
});

const bot = new Chat({
  userName: "my-bot",
  adapters: {
    whatsappMain: waMain,
    whatsappSales: waSales,
  },
  state: createMemoryState(),
});

// Connect both accounts
await waMain.connect();
await waSales.connect();
```

All handlers (`onNewMention`, `onSubscribedMessage`, etc.) fire for messages from either account. The `thread.threadId` prefix tells you which account a message came from.

See [Thread IDs And Multi-Account](./thread-ids-and-multi-account.md) for more detail.

---

## Adapter config reference

```ts
createBaileysAdapter({
  // Unique name for this adapter instance (default: "baileys").
  // Used as the prefix in thread IDs. Must not contain ":".
  adapterName: "baileys",

  // Required. Your Baileys auth state and credential-save callback.
  auth: { state, saveCreds },

  // Display name used by the Chat SDK for the bot user.
  userName: "my-bot",

  // Override the WhatsApp Web protocol version. Defaults to the
  // latest version fetched from WhatsApp's servers at startup.
  version: [2, 3000, 1015901307],

  // Called with a QR string whenever a new QR code is available.
  // Render it however you like (terminal, image, web page, etc.).
  onQR: async (qr) => { /* ... */ },

  // Phone number for pairing-code auth (E.164, no leading "+").
  phoneNumber: "12345678901",

  // Called with the 8-digit pairing code when requested.
  onPairingCode: (code) => { /* ... */ },

  // Advanced: pass extra options directly to Baileys' makeWASocket().
  socketOptions: {},
});
```

---

## Known limitations

| Limitation | Detail |
|---|---|
| `handleWebhook()` returns `501` | Baileys uses an outbound WebSocket — there are no inbound HTTP webhooks to handle. |
| `fetchMessages()` returns `[]` | WhatsApp has no REST history API. Persist `messages.upsert` events yourself if you need history. |
| Cards sent as plain text | WhatsApp has no native card/button message format (for the unofficial API). Cards fall back to text. |
| Newsletters are skipped | Newsletter JIDs are filtered out and never dispatched. |

---

## Thread ID format

Thread IDs follow this pattern:

```
<adapterName>:<base64url(jid)>
```

For example, if `adapterName` is `"baileys"` and the JID is `15551234567@s.whatsapp.net`, the thread ID looks like:

```
baileys:MTU1NTEyMzQ1NjdAcy53aGF0c2FwcC5uZXQ
```

You rarely need to construct these manually — the adapter creates and decodes them for you. See [Thread IDs And Multi-Account](./thread-ids-and-multi-account.md) for details.
