# WhatsApp Extensions

The `BaileysAdapter` exposes several methods beyond the standard Chat SDK `Adapter` interface. These cover WhatsApp features that have no equivalent in the Chat SDK's platform-agnostic model.

Call these methods directly on the adapter instance rather than through `thread.post()` or other Chat SDK helpers.

---

## Why extensions exist

The Chat SDK defines a common interface that works across Slack, Teams, Discord, WhatsApp, and so on. That interface only includes concepts that all platforms share: posting text, editing/deleting messages, reactions, and typing indicators.

Features specific to one platform — like WhatsApp's quoted replies, polls, or location pins — can't be part of the shared interface. Rather than drop them entirely, this adapter exposes them as extra methods on `BaileysAdapter` directly.

The tradeoff: extension calls are WhatsApp-specific. If you ever add a second adapter (e.g. Slack), you'll need to branch on the adapter type or handle those features separately.

## Multi-account

For single-account setups, call extension methods directly on the adapter instance.

For multi-account setups, use `createBaileysExtensions` to get a router that automatically selects the right adapter based on the thread ID prefix. `setPresence` broadcasts to all accounts.

```ts
import { createBaileysAdapter, createBaileysExtensions } from "chat-adapter-baileys";

const waMain = createBaileysAdapter({ adapterName: "baileys-main", auth: authMain });
const waSales = createBaileysAdapter({ adapterName: "baileys-sales", auth: authSales });

const wa = createBaileysExtensions(waMain, waSales);

bot.onSubscribedMessage(async (thread, message) => {
  await wa.reply(message, "Got it!");           // routes to the right account
  await wa.markRead(thread.threadId, [message.id]);
});

await wa.setPresence("available"); // sets presence on both accounts
```

If you pass a thread ID or message that doesn't match any registered adapter, `createBaileysExtensions` throws a descriptive error rather than silently sending from the wrong account.

---

## `reply(message, text)` — Quoted reply

Send a message that quotes a previous message, producing WhatsApp's native reply bubble (the grey quoted preview above the new message).

`thread.post()` has no `replyTo` concept — use this method when the visual reply reference matters.

```ts
import { createBaileysAdapter } from "chat-adapter-baileys";

const whatsapp = createBaileysAdapter({ /* ... */ });

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;

  // Shows the user's message in a grey bubble above "Got it!"
  await whatsapp.reply(message, "Got it!");
});
```

**Signature:**
```ts
reply(message: Message<WAMessage>, text: string): Promise<RawMessage<WAMessage>>
```

- `message` — the `Message` object from a handler; the raw `WAMessage` is used as the quoted context.
- `text` — the reply text. WhatsApp formatting applies (`*bold*`, `_italic_`, etc.).
- Throws if the socket is not connected.

---

## `markRead(threadId, messageIds)` — Read receipts

Send read receipts for specific messages in a thread. WhatsApp shows blue double-ticks to the sender when this is called.

The Chat SDK has no read-receipt concept — call this directly when you want to explicitly acknowledge that messages have been seen.

```ts
bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;

  // Mark this message as read immediately on receipt
  await whatsapp.markRead(thread.threadId, [message.id]);

  await thread.post("Processing your request...");
});
```

You can batch multiple message IDs in one call:

```ts
const ids = messages.map(m => m.id);
await whatsapp.markRead(thread.threadId, ids);
```

**Signature:**
```ts
markRead(threadId: string, messageIds: string[]): Promise<void>
```

- Throws if the socket is not connected.

---

## `setPresence(presence)` — Online/offline status

Set the bot's global WhatsApp presence — whether it appears as online or offline to other users.

The Chat SDK's `thread.startTyping()` sends a per-chat "composing" indicator. This method controls the bot's top-level presence status, visible on the bot's profile.

```ts
// Mark the bot as online when it starts
await bot.initialize();
await whatsapp.connect();
await whatsapp.setPresence("available");

// Mark the bot as offline during maintenance
await whatsapp.setPresence("unavailable");
```

**Signature:**
```ts
setPresence(presence: "available" | "unavailable"): Promise<void>
```

- Throws if the socket is not connected.
- Per-chat "composing" presence is handled separately by `thread.startTyping()`.

---

## `sendLocation(threadId, latitude, longitude, options?)` — Location pin

Send a native WhatsApp location message (shown as an interactive map pin). The Chat SDK has no location type, so this is only available as an extension.

```ts
bot.onSubscribedMessage(async (thread, message) => {
  if (message.text.toLowerCase().includes("office")) {
    await whatsapp.sendLocation(
      thread.threadId,
      37.7749,    // latitude
      -122.4194,  // longitude
      {
        name: "HQ Office",
        address: "1 Market St, San Francisco, CA",
      }
    );
  }
});
```

Without a name/address, a bare coordinate pin is sent:

```ts
await whatsapp.sendLocation(thread.threadId, 51.5074, -0.1278);
```

**Signature:**
```ts
sendLocation(
  threadId: string,
  latitude: number,
  longitude: number,
  options?: { name?: string; address?: string }
): Promise<RawMessage<WAMessage>>
```

- `latitude` / `longitude` — decimal degrees (WGS 84).
- `options.name` — optional place name shown on the pin.
- `options.address` — optional address line shown below the name.
- Throws if the socket is not connected.

---

## `sendPoll(threadId, question, options, selectableCount?)` — Poll

Send a native WhatsApp poll. Polls let users tap options directly in the chat. The Chat SDK has no poll concept.

```ts
// Single-choice poll (default)
await whatsapp.sendPoll(
  thread.threadId,
  "When should we hold the team sync?",
  ["Monday 10am", "Wednesday 2pm", "Friday 4pm"]
);

// Multi-choice poll — users can pick up to 2 options
await whatsapp.sendPoll(
  thread.threadId,
  "Which topics should we cover?",
  ["Design review", "Sprint planning", "Bugs", "Roadmap"],
  2   // selectableCount
);
```

**Signature:**
```ts
sendPoll(
  threadId: string,
  question: string,
  options: string[],
  selectableCount?: number   // default: 1
): Promise<RawMessage<WAMessage>>
```

- `question` — the poll question text.
- `options` — 2–12 option strings.
- `selectableCount` — how many options a user can select. `1` = single-choice, `>1` = multi-choice, `0` = unlimited.
- Throws if the socket is not connected.

> **Note:** Poll vote events are not yet forwarded through the Chat SDK handler system. You can observe raw Baileys events via `socketOptions` if you need to tally votes.

---

## `fetchGroupParticipants(threadId)` — Group membership

Fetch the full participant list for a group thread, including admin roles. The Chat SDK has no group-membership concept.

```ts
bot.onNewMention(async (thread, message) => {
  if (thread.isDM) return;

  const participants = await whatsapp.fetchGroupParticipants(thread.threadId);
  const admins = participants.filter(p => p.isAdmin);
  const total = participants.length;

  await thread.post(
    `This group has ${total} members and ${admins.length} admin(s).`
  );
  await thread.subscribe();
});
```

Check if the sender is an admin before allowing privileged commands:

```ts
bot.onSubscribedMessage(async (thread, message) => {
  if (thread.isDM || message.text !== "!shutdown") return;

  const participants = await whatsapp.fetchGroupParticipants(thread.threadId);
  const sender = participants.find(p => p.userId === message.author.userId);

  if (!sender?.isAdmin) {
    await thread.post("Only admins can use that command.");
    return;
  }

  await thread.post("Shutting down...");
});
```

**Signature:**
```ts
fetchGroupParticipants(threadId: string): Promise<BaileysGroupParticipant[]>
```

**`BaileysGroupParticipant` fields:**

| Field | Type | Description |
|---|---|---|
| `userId` | `string` | The participant's JID (e.g. `"15551234567@s.whatsapp.net"`) |
| `isAdmin` | `boolean` | `true` for both admin and super-admin roles |
| `isSuperAdmin` | `boolean` | `true` only for the group creator |

- Throws a `ValidationError` if the thread is not a group.
- Throws if the socket is not connected.
