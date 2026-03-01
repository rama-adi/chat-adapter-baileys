# Thread IDs And Multi-Account

---

## What is a thread ID?

Every conversation in the Chat SDK is identified by a **thread ID** — a stable string that uniquely identifies a chat across the lifetime of your bot. The adapter generates these IDs from WhatsApp JIDs (Jabber IDs), which are WhatsApp's internal identifiers for conversations.

Thread IDs are used throughout the Chat SDK for:

- Routing messages to the correct handler
- Tracking subscriptions (`thread.subscribe()` / `thread.unsubscribe()`)
- Deduplicating messages so the same message isn't processed twice
- Posting proactively to a known conversation

---

## Thread ID format

```
<adapterName>:<base64url(jid)>
```

Where:

- `<adapterName>` — the `adapterName` you passed to `createBaileysAdapter()`, defaulting to `"baileys"`.
- `<base64url(jid)>` — the WhatsApp JID encoded as Base64URL (no padding, URL-safe characters).

### Examples

| Conversation | JID | Thread ID (with default adapterName) |
|---|---|---|
| DM with +1 555 123 4567 | `15551234567@s.whatsapp.net` | `baileys:MTU1NTEyMzQ1NjdAcy53aGF0c2FwcC5uZXQ` |
| Group chat | `123456789-1000000000@g.us` | `baileys:MTIzNDU2Nzg5LTEwMDAwMDAwMDBAgLnVz` |

You don't normally construct these by hand. The adapter creates them when a message arrives, and the Chat SDK passes them into your handlers via the `thread` object.

### Inspecting a thread ID in a handler

```ts
bot.onSubscribedMessage(async (thread, message) => {
  // The encoded thread ID
  console.log(thread.threadId);
  // e.g. "baileys:MTU1NTEyMzQ1NjdAcy53aGF0c2FwcC5uZXQ"

  // Whether it's a DM or group
  console.log(thread.isDM);
  // true for DMs, false for groups
});
```

---

## Why the `adapterName` prefix matters

When you run a single WhatsApp account, all thread IDs start with `"baileys:"` by default and there are no collisions.

When you run **multiple WhatsApp accounts** in one `Chat` instance, two different accounts could have a conversation with the same JID (e.g. both have a DM with `15551234567@s.whatsapp.net`). Without namespacing, those would produce identical thread IDs, causing:

- Message routing bugs (messages from one account trigger handlers meant for the other)
- Subscription state shared across accounts (subscribing in account A accidentally subscribes account B)
- Dedup keys colliding across accounts

By giving each adapter a unique `adapterName`, the thread IDs become:

```
baileys-main:MTU1NTEyMzQ1NjdAcy53aGF0c2FwcC5uZXQ   ← account A's DM
baileys-sales:MTU1NTEyMzQ1NjdAcy53aGF0c2FwcC5uZXQ  ← account B's DM (same JID, different prefix)
```

These are treated as completely separate threads.

---

## Running multiple accounts

Each account needs:
1. Its own auth state directory (separate `useMultiFileAuthState` folder)
2. A unique `adapterName` (no `":"` allowed in the name)
3. Its own adapter instance

```ts
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";

// Load credentials for each account from separate folders
const { state: stateMain, saveCreds: saveMain } = await useMultiFileAuthState("./auth_main");
const { state: stateSales, saveCreds: saveSales } = await useMultiFileAuthState("./auth_sales");

// Create an adapter for each account
const waMain = createBaileysAdapter({
  adapterName: "baileys-main",   // unique name — no ":" allowed
  auth: { state: stateMain, saveCreds: saveMain },
  userName: "main-bot",
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log("[main] Scan QR:");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});

const waSales = createBaileysAdapter({
  adapterName: "baileys-sales",
  auth: { state: stateSales, saveCreds: saveSales },
  userName: "sales-bot",
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log("[sales] Scan QR:");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});

// Single Chat instance handles both accounts
const bot = new Chat({
  userName: "my-bot",
  adapters: {
    whatsappMain: waMain,
    whatsappSales: waSales,
  },
  state: createMemoryState(),
});

// Handlers fire for messages from either account
bot.onNewMention(async (thread, message) => {
  // Detect which account received this message by looking at the thread ID prefix
  const isMainAccount = thread.threadId.startsWith("baileys-main:");
  const account = isMainAccount ? "main" : "sales";

  await thread.post(`[${account}] Hi ${message.author.userName}!`);
  await thread.subscribe();
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await thread.post(`Echo from ${thread.threadId.split(":")[0]}: ${message.text}`);
});

// Initialize Chat once, then connect both accounts (each opens its own WebSocket)
await bot.initialize();
await waMain.connect();
await waSales.connect();
```

---

## Sending to a known thread ID proactively

If you have stored a thread ID from a previous session, you can post to it without waiting for an incoming message:

```ts
// Thread ID stored earlier (e.g. in a database)
const storedThreadId = "baileys-main:MTU1NTEyMzQ1NjdAcy53aGF0c2FwcC5uZXQ";

await bot.postTo(storedThreadId, "Reminder: your order has shipped!");
```

Thread IDs are stable as long as `adapterName` doesn't change — so they're safe to store in a database.

---

## Opening a DM thread by phone number

To proactively start a DM with a user whose phone number you know:

```ts
// Returns the thread ID for a DM with that number
const threadId = await waMain.openDM("15551234567");

// Post to it
await bot.postTo(threadId, "Hello! This is an automated message.");
```

`openDM` accepts either a bare phone number (`"15551234567"`) or a full JID (`"15551234567@s.whatsapp.net"`).

---

## Constraints

- `adapterName` must **not** contain `":"` — the adapter validates this at construction time and throws if you pass an invalid name.
- Thread IDs from one adapter cannot be used with another adapter, even if `adapterName` is changed later.
- If you change `adapterName` on an existing deployment, all stored thread IDs become invalid.
