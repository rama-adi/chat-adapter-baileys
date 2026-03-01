# WhatsApp (Baileys) Quickstart

This guide shows how to run a Chat SDK bot on WhatsApp with `chat-adapter-baileys`.

## 1. Install

```bash
pnpm add chat-adapter-baileys baileys chat
```

Optional for terminal QR rendering:

```bash
pnpm add qrcode
```

## 2. Prepare auth state

For local development, `useMultiFileAuthState` is the fastest way to start.

```ts
import { useMultiFileAuthState } from "baileys";

const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
```

Production note: replace this with your own persistent auth store.

## 3. Create adapter

### QR flow

```ts
import { createBaileysAdapter } from "chat-adapter-baileys";

const adapter = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "my-bot",
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});
```

### Pairing code flow

```ts
const adapter = createBaileysAdapter({
  auth: { state, saveCreds },
  phoneNumber: "12345678901", // E.164 without '+'
  onPairingCode: (code) => {
    console.log("Enter this code in WhatsApp Linked Devices:", code);
  },
});
```

## 4. Create Chat instance and handlers

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";

const bot = new Chat({
  userName: "my-bot",
  adapters: { whatsapp: adapter },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.post(`Hello ${message.author.userName}`);
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await thread.post(`Echo: ${message.text}`);
});
```

## 5. Connect

```ts
await adapter.connect();
```

## Multi-account in one Chat instance

Use one adapter instance per account and set a unique `adapterName` on each:

```ts
const waA = createBaileysAdapter({ adapterName: "baileys-a", auth: authA });
const waB = createBaileysAdapter({ adapterName: "baileys-b", auth: authB });

const bot = new Chat({
  userName: "my-bot",
  adapters: {
    whatsappA: waA,
    whatsappB: waB,
  },
  state: createMemoryState(),
});
```

This avoids thread identity collisions across accounts.

## Limitations

- `handleWebhook()` returns `501` (WebSocket transport only)
- `fetchMessages()` and `fetchChannelMessages()` return empty results by default
- cards are converted to fallback text

## Thread IDs

Thread IDs are encoded as:

```txt
<adapterName>:<base64url(jid)>
```

Example JIDs:
- DM: `15551234567@s.whatsapp.net`
- Group: `123456789-1234567890@g.us`
