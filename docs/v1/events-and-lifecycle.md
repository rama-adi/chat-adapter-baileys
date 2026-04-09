# Events And Lifecycle

Understanding the adapter lifecycle helps you set things up in the right order and handle edge cases like reconnections and auth flows correctly.

---

## The startup sequence

Always follow this order:

```
1. Prepare auth state          (useMultiFileAuthState or your own store)
2. Create adapter              (createBaileysAdapter)
3. Create Chat instance        (new Chat({ adapters: { ... } }))
4. Register all handlers       (bot.onNewMention, bot.onSubscribedMessage, etc.)
5. Initialize Chat             (await bot.initialize())
6. Connect                     (await adapter.connect())
```

**Why does handler registration come before `connect()`?**

`connect()` opens the WebSocket and starts receiving messages immediately. If you register handlers after connecting, any messages that arrive in the window between connecting and registering will be dropped silently. Register everything first, then connect.

```ts
const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

const whatsapp = createBaileysAdapter({ auth: { state, saveCreds }, userName: "bot" });

const bot = new Chat({ userName: "bot", adapters: { whatsapp }, state: createMemoryState() });

// ✅ Register BEFORE connect
bot.onNewMention(async (thread, message) => { /* ... */ });
bot.onSubscribedMessage(async (thread, message) => { /* ... */ });

// ✅ Initialize, then connect LAST
await bot.initialize();
await whatsapp.connect();
```

---

## What happens inside `connect()`

`connect()` creates a Baileys WebSocket (`makeWASocket`) and attaches three event listeners:

### `creds.update`

Fires whenever Baileys internally rotates or updates credentials. The adapter calls `saveCreds()` automatically so you never lose your session. You don't need to handle this yourself.

### `connection.update`

Fires on any connection state change. The adapter handles:

- **QR code available** — calls your `onQR` callback with the raw QR string.
- **Pairing code requested** — calls your `onPairingCode` callback once per socket lifetime.
- **Connection opened** — logs "Connected to WhatsApp" and sets the connected flag.
- **Connection closed** — decides whether to reconnect (see below).

### `messages.upsert`

Fires when new messages arrive. The adapter processes only `type === "notify"` events (real-time incoming messages), filtering out:

- Blank/system messages (`msg.message` is null)
- Newsletter JIDs (WhatsApp Channels / broadcast lists)

Each valid message is decoded and forwarded to `chat.processMessage()`, which dispatches it to your registered handlers.

---

## Auth flows in detail

### QR code flow

1. On first startup (no saved session), Baileys emits a `qr` field in `connection.update`.
2. The adapter calls your `onQR(qr)` callback — render the QR however you like.
3. The user scans the QR in WhatsApp → Settings → Linked Devices.
4. WhatsApp sends a `restartRequired` (code 515) close event — this is expected. The adapter reconnects automatically to complete the handshake.
5. The session is saved; subsequent startups skip the QR entirely.

```ts
const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  onQR: async (qr) => {
    // Option 1: print to terminal
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));

    // Option 2: serve as an image at /qr in your HTTP server
    // const png = await QRCode.toBuffer(qr);
    // res.type("image/png").send(png);
  },
});
```

### Pairing code flow

1. Set `phoneNumber` (E.164 without `+`) and `onPairingCode` in the config.
2. When the socket starts connecting, the adapter calls `socket.requestPairingCode(phoneNumber)`.
3. Your `onPairingCode` callback receives the 8-digit code string.
4. The user enters the code in WhatsApp → Settings → Linked Devices → Link with phone number.
5. After linking, credentials are saved and future startups are automatic.

```ts
const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  phoneNumber: "12345678901",
  onPairingCode: (code) => {
    // Display the code in your UI or log it
    console.log(`\nPairing code: ${code}\nEnter it in WhatsApp → Linked Devices\n`);
  },
});
```

> **Note:** Use either `onQR` or `phoneNumber`/`onPairingCode`, not both at the same time.

---

## Reconnect behavior

The adapter automatically reconnects when the connection drops unexpectedly. The reconnect decision is based on the disconnect status code:

| Situation | Status code | Reconnects? |
|---|---|---|
| QR scan completed (normal handshake step) | `515` (restartRequired) | Yes |
| Network error / server timeout | varies | Yes |
| Logged out from WhatsApp app | `401` (loggedOut) | **No** |
| `adapter.disconnect()` called explicitly | — | **No** |

When reconnecting after a logout, you need to delete the saved credentials and restart with a fresh QR scan:

```ts
import fs from "fs";

function onLoggedOut() {
  console.warn("Bot was logged out of WhatsApp. Delete auth_info/ and restart.");
  // fs.rmSync("./auth_info", { recursive: true, force: true });
  // process.exit(1);
}
```

---

## Disconnecting cleanly

Call `disconnect()` when you want to shut down gracefully — for example, in a SIGTERM handler:

```ts
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await whatsapp.disconnect();
  process.exit(0);
});
```

`disconnect()` closes the socket immediately and sets the `_shouldReconnect` flag to false, so no automatic reconnect is attempted.

---

## Incoming message flow (step by step)

Here is exactly what happens when a WhatsApp user sends a message that your bot should respond to:

```
WhatsApp server
  │  (WebSocket frame)
  ▼
Baileys socket  →  emits "messages.upsert"
  │
  ▼
BaileysAdapter._createSocket() event handler
  │  • checks type === "notify"
  │  • skips newsletters and empty messages
  │  • encodes JID → threadId
  ▼
chat.processMessage(adapter, threadId, () => adapter.parseMessage(msg))
  │  • builds Message object (text, author, attachments, …)
  │  • checks subscription state
  ▼
Your handler fires:
  bot.onNewMention(...)          ← if bot was @-mentioned in unsubscribed group
  bot.onSubscribedMessage(...)   ← if thread is subscribed
  bot.onNewMessage(pattern, ...) ← if message text matches the pattern
```
