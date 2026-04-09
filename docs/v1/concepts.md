# Concepts Mapping

The Chat SDK uses a platform-agnostic model (`Thread`, `Channel`, `Message`, etc.) that adapters translate to and from each platform's native concepts. This page explains how those Chat SDK concepts map to WhatsApp's model when using this adapter.

---

## Thread → WhatsApp conversation (JID)

In the Chat SDK, a **thread** is a container for a sequence of messages — typically a chat room, DM, or topic thread. On WhatsApp there are only two kinds of conversations:

- **Direct message (DM)** — a one-on-one chat with another user. JID format: `15551234567@s.whatsapp.net`
- **Group chat** — a group conversation with multiple participants. JID format: `123456789-1234567890@g.us`

Each WhatsApp JID maps 1-to-1 to a Chat SDK thread. There is no concept of sub-threads or topics inside a WhatsApp conversation, so a thread and its channel are always the same conversation.

```ts
// When the bot receives a message, thread.threadId contains the encoded JID:
bot.onSubscribedMessage(async (thread, message) => {
  console.log(thread.threadId); // e.g. "baileys:MTU1NTEyMzQ1NjdAcy53aGF0c2FwcC5uZXQ"
  console.log(thread.isDM);     // true for DMs, false for groups
});
```

---

## Channel → same WhatsApp conversation

The Chat SDK has a `Channel` abstraction for platforms that distinguish between a top-level channel and threads inside it (e.g. Slack channels with message threads). WhatsApp has no such distinction — every conversation is flat.

Because of this:

- `channelIdFromThreadId()` returns the thread ID unchanged.
- `postChannelMessage()` delegates to `postMessage()` — posting to the "channel" is the same as posting to the conversation.
- `listThreads()` returns an empty array — there are no sub-threads to list.

In practice you won't call these methods directly; they're used by the Chat SDK internally.

---

## Message model mapping

When Baileys delivers a `WAMessage`, the adapter converts it into a Chat SDK `Message` object. Here's how the fields map:

| Chat SDK field | WhatsApp / Baileys source |
|---|---|
| `message.id` | `msg.key.id` |
| `message.text` | `conversation`, `extendedTextMessage.text`, image/video/document captions |
| `message.formatted` | Parsed AST from `message.text` via `BaileysFormatConverter` |
| `message.attachments` | Populated for image, video, audio, and document messages |
| `message.author.userId` | Sender's JID |
| `message.author.userName` | `msg.pushName` (the sender's display name) |
| `message.author.isMe` | `msg.key.fromMe` |
| `message.metadata.dateSent` | `msg.messageTimestamp` converted to a `Date` |
| `message.metadata.edited` | Detected from `editedMessage` or protocol message type 14 |

Example — log full message info when the bot receives a mention:

```ts
bot.onNewMention(async (thread, message) => {
  console.log("Message ID:", message.id);
  console.log("Author:", message.author.userName, "(", message.author.userId, ")");
  console.log("Text:", message.text);
  console.log("Sent at:", message.metadata.dateSent);
  console.log("Is edited:", message.metadata.edited);
  console.log("Attachments:", message.attachments.length);
});
```

---

## Reactions

WhatsApp supports emoji reactions on individual messages. The adapter maps the Chat SDK reaction methods to Baileys' `react` payload:

- `message.addReaction("👍")` — sends a reaction with the given emoji to the message.
- `message.removeReaction("👍")` — sends an empty-string reaction, which WhatsApp interprets as removing any existing reaction.

```ts
bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;

  // Acknowledge every message with a checkmark
  await message.addReaction("✅");

  // Later, if you want to remove it:
  // await message.removeReaction("✅");
});
```

You can also observe reactions from other users:

```ts
bot.onReaction(["👍", "👎"], async (event) => {
  const action = event.isAdded ? "reacted with" : "removed";
  console.log(`${event.author.userName} ${action} ${event.emoji}`);
});
```

---

## Typing indicator

`thread.startTyping()` sends WhatsApp's "composing" presence update, which shows the "typing..." indicator to other participants. This is a best-effort no-op — if the socket isn't connected when called, it silently does nothing.

```ts
bot.onNewMention(async (thread, message) => {
  await thread.startTyping(); // shows "typing..." to the group

  // Simulate some processing time
  const reply = await generateReply(message.text);

  await thread.post(reply);
});
```

> **Note:** WhatsApp presence updates are rate-limited. Sending them too frequently may be ignored by clients.

---

## Webhook model

Baileys connects to WhatsApp by opening a **persistent outbound WebSocket** to WhatsApp's servers. It does not listen for inbound HTTP requests. This means:

- You do **not** expose a webhook URL for WhatsApp to call.
- `handleWebhook()` always returns HTTP `501 Not Implemented`.
- Incoming messages arrive via the `messages.upsert` Baileys event, which the adapter subscribes to internally.

If you have HTTP server code that routes to `adapter.handleWebhook()`, nothing will break — it just returns 501. To actually receive messages in gateway mode, call `await bot.initialize()` and then `adapter.connect()`.

---

## Message history

`fetchMessages()` and `fetchChannelMessages()` both return empty arrays. WhatsApp's unofficial API (Baileys) does not expose a REST endpoint for fetching historical messages.

If you need message history, build your own store:

```ts
import { Chat } from "chat";
import type { WAMessage } from "baileys";

// Simple in-memory store (replace with a database in production)
const messageStore = new Map<string, WAMessage[]>();

const bot = new Chat({ /* ... */ });

// Persist every incoming message
bot.onAnyMessage(async (thread, message) => {
  const jid = thread.threadId;
  const existing = messageStore.get(jid) ?? [];
  existing.push(message.raw);
  messageStore.set(jid, existing);
});

// Query the store whenever you need history
function getHistory(threadId: string): WAMessage[] {
  return messageStore.get(threadId) ?? [];
}
```

---

## Opening DMs proactively

You can construct a thread ID for a DM and post to it without waiting for the other person to message first:

```ts
// Get a thread ID for a phone number (E.164 format, no "+")
const threadId = await whatsapp.openDM("15551234567");

// Post a message to that DM
await bot.postTo(threadId, "Hello from the bot!");
```

`openDM` accepts either a bare phone number or a full JID (`15551234567@s.whatsapp.net`).
