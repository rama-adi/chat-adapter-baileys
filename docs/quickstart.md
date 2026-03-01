---
title: WhatsApp (Baileys) quickstart
description: Connect Chat SDK to WhatsApp — from first-time auth to a running bot.
---

# WhatsApp (Baileys) quickstart

This guide walks you through the full journey:

1. [Install](#install)
2. [Step 1 — Authenticate (one-time)](#step-1--authenticate-one-time)
3. [Step 2 — Create the adapter](#step-2--create-the-adapter)
4. [Step 3 — Build the bot](#step-3--build-the-bot)
5. [Step 4 — Connect](#step-4--connect)

---

## Install

```bash
npm install chat-adapter-baileys baileys chat
# or
pnpm add chat-adapter-baileys baileys chat
```

---

## Step 1 — Authenticate (one-time)

WhatsApp requires the bot's phone number to be linked to a session before it
can send or receive messages. This only needs to happen once. After that, the
credentials are saved to disk and reused on every restart.

> **Warning — `useMultiFileAuthState` is for development only.**
> It does heavy file I/O on every credential change, which is not
> suitable for production. Use it during setup and replace it with a
> database-backed store (e.g. Postgres, Redis) before going live.

Run a short setup script and keep the credentials in a persistent directory
(e.g. `./auth_info`). Choose **QR code** or **pairing code** below.

---

### Method A — QR code

Scan the QR with the WhatsApp app on the phone linked to the bot number.

```typescript
// scripts/auth.ts
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "baileys";
import QRCode from "qrcode"; // npm install qrcode

const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({ version, auth: state, printQRInTerminal: false });

sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
  // Display the QR code in the terminal
  if (qr) {
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  }

  if (connection === "open") {
    console.log("✓ Authenticated! Credentials saved to ./auth_info");
    process.exit(0);
  }

  // After scanning the QR, Baileys forces a reconnect with restartRequired.
  // This is expected — just recreate the socket.
  const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
  if (connection === "close" && statusCode === DisconnectReason.restartRequired) {
    // Re-run the script, or loop here — see example.ts for the full pattern
  }
});
```

Run it:

```bash
npx ts-node scripts/auth.ts
```

Scan the QR with your phone → you'll see `✓ Authenticated!`.

---

### Method B — Pairing code

No QR scan needed. WhatsApp sends an 8-character code to the phone app
instead. The phone number must be in **E.164 format without the `+`**:
`+1 (234) 567-8901` → `"12345678901"`.

```typescript
// scripts/auth.ts
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "baileys";

const PHONE_NUMBER = "12345678901"; // E.164, no leading +

const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({ version, auth: state, printQRInTerminal: false });

sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", async ({ connection, qr }) => {
  // Request the pairing code as soon as the socket starts connecting
  if (connection === "connecting" || qr) {
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log("Enter this code in WhatsApp → Linked Devices:", code);
  }

  if (connection === "open") {
    console.log("✓ Authenticated! Credentials saved to ./auth_info");
    process.exit(0);
  }
});
```

Open WhatsApp on your phone → **Settings → Linked Devices → Link a device →
Link with phone number**, enter the code. You'll see `✓ Authenticated!`.

---

## Step 2 — Create the adapter

Load the saved credentials and pass them to `createBaileysAdapter`.
The adapter does **not** connect automatically — that happens in step 4.

```typescript
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";

const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

const adapter = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "my-bot",
});
```

---

## Step 3 — Build the bot

Pass the adapter to `Chat`, then register your message handlers.

```typescript
import { Chat } from "chat";

const bot = new Chat({
  userName: "my-bot",
  adapters: { whatsapp: adapter },
  state: myStateAdapter, // e.g. new MemoryStateAdapter()
});

// Reply when @-mentioned in a group
bot.onNewMention(async (thread, message) => {
  await thread.post(`Hello, ${message.author.fullName || message.author.userName}!`);
});

// Respond to direct messages
bot.onNewMessage(/.+/, async (thread, message) => {
  if (message.author.isMe) return;
  await thread.post(`Echo: ${message.text}`);
});
```

---

## Step 4 — Connect

```typescript
await adapter.connect();
console.log("Bot is live.");
```

`connect()` creates the Baileys WebSocket, attaches all event listeners, and
handles automatic reconnection on unexpected disconnects.

---

## Configuration reference

```typescript
createBaileysAdapter({
  // ── Required ──────────────────────────────────────────────────────────────
  auth: { state, saveCreds },

  // ── Optional ──────────────────────────────────────────────────────────────

  /** Bot display name (default: "baileys-bot") */
  userName: "my-bot",

  /** WA Web version — auto-fetched if omitted */
  version: [2, 3000, 1023],

  // QR code login: called with the raw QR string
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },

  // Pairing code login: phone in E.164 without +, e.g. "12345678901"
  phoneNumber: "12345678901",
  onPairingCode: (code) => console.log("WhatsApp pairing code:", code),

  // Extra options forwarded to makeWASocket()
  socketOptions: {
    generateHighQualityLinkPreview: true,
  },
});
```

---

## Thread IDs

Every WhatsApp chat maps to one thread. The adapter encodes the JID as:

```
baileys:<base64url(jid)>
```

| Chat type     | Example JID                         |
| ------------- | ----------------------------------- |
| Individual DM | `15551234567@s.whatsapp.net`        |
| Group         | `123456789-1234567890@g.us`         |

Access the raw JID at any time:

```typescript
const { jid } = adapter.decodeThreadId(threadId);
```

---

## Media attachments

Incoming images, videos, audio, and documents arrive on `message.attachments`.
Each entry has a lazy `fetchData()` that downloads the binary on demand:

```typescript
bot.onNewMessage(/.+/, async (thread, message) => {
  for (const attachment of message.attachments) {
    const buffer = await attachment.fetchData?.();
    // save, process, or forward the buffer
  }
});
```

---

## Limitations

| Feature         | Notes                                                        |
| --------------- | ------------------------------------------------------------ |
| `handleWebhook` | Always returns 501 — Baileys is outbound WebSocket, not HTTP |
| `fetchMessages` | Returns `[]` — implement your own store from `messages.upsert` events |
| Cards           | Not supported — card content sent as plain fallback text     |
| Reactions       | Supported via `addReaction` / `removeReaction`               |
| Typing          | Supported via `startTyping`                                  |
| Group info      | Fetched automatically in `fetchThread`                       |
