# chat-adapter-baileys

WhatsApp (Baileys) adapter for the [Chat SDK](https://www.npmjs.com/package/chat).

> [!WARNING]
> This adapter uses Baileys, a third-party unofficial WhatsApp Web API. It is not an official WhatsApp/Meta API and may break when WhatsApp changes internal protocols. WhatsApp may also suspend or ban numbers/accounts that use unofficial automation. Use at your own risk and evaluate compliance requirements before production use.

...with that out of the way, let's continue with the docs.

This package lets you run Chat SDK bots on WhatsApp via Baileys. It handles the WhatsApp WebSocket connection, message parsing, formatting, media attachments, reactions, and typing indicators — so you can focus on your bot logic.

## Install

```bash
pnpm add chat-adapter-baileys baileys chat @chat-adapter/state-memory
```

Optional — for terminal QR rendering during development:

```bash
pnpm add qrcode
```

## Quick Start

The setup has five steps: prepare auth, create the adapter, create a `Chat` instance, register handlers, then connect. **Always register handlers before connecting** — messages can arrive as soon as `connect()` is called.

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";

// 1. Load (or create) the session credentials
const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

// 2. Create the adapter
const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "my-bot",
  // Called when a QR code is available — scan with WhatsApp → Linked Devices
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});

// 3. Create the Chat instance
const bot = new Chat({
  userName: "my-bot",
  adapters: { whatsapp },
  state: createMemoryState(),
});

// 4. Register handlers
bot.onNewMention(async (thread, message) => {
  // Fires when the bot is @-mentioned in a group it hasn't subscribed to
  await thread.post(`Hello ${message.author.userName}!`);
  await thread.subscribe(); // subscribe so follow-up messages are also handled
});

bot.onSubscribedMessage(async (thread, message) => {
  // Fires for every message in a subscribed thread
  if (message.author.isMe) return;
  await thread.post(`You said: ${message.text}`);
});

bot.onNewMessage(/.+/, async (thread, message) => {
  // Fires for any message matching the pattern in an unsubscribed thread
  if (!thread.isDM || message.author.isMe) return;
  await thread.post(`DM received: ${message.text}`);
});

// 5. Connect — open the WhatsApp WebSocket
await whatsapp.connect();
```

Credentials are saved to `./auth_info` on first login. Subsequent startups reuse the saved session — no QR scan needed.

## Multi-Account Support

Run one adapter instance per WhatsApp account. Give each a unique `adapterName` to avoid thread ID collisions:

```ts
const { state: stateMain, saveCreds: saveMain } = await useMultiFileAuthState("./auth_main");
const { state: stateSales, saveCreds: saveSales } = await useMultiFileAuthState("./auth_sales");

const waMain = createBaileysAdapter({
  adapterName: "baileys-main",   // unique — used as thread ID prefix
  auth: { state: stateMain, saveCreds: saveMain },
});

const waSales = createBaileysAdapter({
  adapterName: "baileys-sales",
  auth: { state: stateSales, saveCreds: saveSales },
});

const bot = new Chat({
  userName: "my-bot",
  adapters: { whatsappMain: waMain, whatsappSales: waSales },
  state: createMemoryState(),
});

await waMain.connect();
await waSales.connect();
```

All handlers receive messages from both accounts. The thread ID prefix (`baileys-main:` vs `baileys-sales:`) tells you which account a message came from.

## Adapter Config

```ts
createBaileysAdapter({
  // Unique name for this adapter — used as thread ID prefix. No ":" allowed.
  adapterName: "baileys",           // default

  // Required. Your Baileys auth state + credential-save callback.
  auth: { state, saveCreds },

  // Display name for the bot in Chat SDK logs.
  userName: "my-bot",

  // Override the WhatsApp Web protocol version. Fetched automatically if omitted.
  version: [2, 3000, 1015901307],

  // Called with a QR string when a new QR is available. Render it however you like.
  onQR: async (qr) => { /* ... */ },

  // Phone number for pairing-code auth (E.164, no "+"). Use instead of onQR.
  phoneNumber: "12345678901",

  // Called with the 8-digit pairing code. User enters it in WhatsApp → Linked Devices.
  onPairingCode: (code) => { /* ... */ },

  // Advanced: extra options passed directly to Baileys' makeWASocket().
  socketOptions: {},
});
```

## WhatsApp Extensions

`BaileysAdapter` exposes extra methods for WhatsApp features that have no equivalent in the Chat SDK interface. Call these directly on the adapter instance:

| Method | Description |
|---|---|
| `whatsapp.reply(message, text)` | Send a quoted reply (native WhatsApp reply bubble) |
| `whatsapp.markRead(threadId, messageIds)` | Send read receipts (blue double-ticks) |
| `whatsapp.setPresence("available" \| "unavailable")` | Set bot's global online/offline status |
| `whatsapp.sendLocation(threadId, lat, lon, options?)` | Send a native location pin |
| `whatsapp.sendPoll(threadId, question, options, selectableCount?)` | Send a WhatsApp poll |
| `whatsapp.fetchGroupParticipants(threadId)` | List group members with admin roles |

See [Extensions](./docs/extensions.md) for full documentation and examples.

## Behavior Notes

- **Transport**: WebSocket-based (`connect()`), not HTTP webhooks. `handleWebhook()` returns `501`.
- **Message history**: `fetchMessages()` / `fetchChannelMessages()` return empty arrays — WhatsApp has no REST history API. Persist `messages.upsert` events yourself if you need history.
- **Cards**: Sent as plain-text fallback — WhatsApp has no native card format.
- **Media**: Incoming attachments include a lazy `fetchData()` for on-demand binary download.
- **Reconnect**: Automatic on unexpected disconnects. Does not reconnect after logout or explicit `disconnect()`.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Docs

- [Quickstart](./docs/quickstart.md) — step-by-step setup guide
- [Runnable Example](./docs/example.ts) — full working bot with commands, media, and reactions
- [Concepts Mapping](./docs/concepts.md) — how Chat SDK concepts map to WhatsApp
- [Events And Lifecycle](./docs/events-and-lifecycle.md) — connection lifecycle, auth flows, reconnect behavior
- [Thread IDs And Multi-Account](./docs/thread-ids-and-multi-account.md) — thread ID format and multi-account setup
- [Formatting And Media](./docs/formatting-and-media.md) — text formatting and media attachment handling
- [Extensions](./docs/extensions.md) — WhatsApp-specific features beyond the Chat SDK interface

## License

MIT
