# Migrating from v1 to v2

This guide helps you upgrade from `chat-adapter-baileys` v1.x to v2.x. Version 2 keeps the adapter focused on normal WhatsApp behavior, removes the old out-of-band extension router, and tightens a few transport behaviors that were too loose for an unofficial client.

Related docs:

- [Extensions](./extensions.md) — how to use WhatsApp-specific methods in v2
- [Quickstart](./quickstart.md) — setting up a new bot from scratch
- [Error Handling](../error-handling.md) — validation errors and troubleshooting

---

## Breaking changes

### `createBaileysExtensions(...)` removed

The `createBaileysExtensions(...)` function is no longer available. Multi-account extension routing is no longer done through a package-level router object.

**What to do instead:**

- Use `requireBaileysAdapter(thread)` to get the WhatsApp adapter from within handlers
- Use `isBaileysAdapter(adapter)` to branch on platform when supporting multiple adapters

### Dependency minimums raised

Peer and dev dependencies were raised to the current Chat SDK line:

| Package | v1 minimum | v2 minimum |
|---------|-----------|------------|
| `chat` | `^4.0.0` | `^4.24.0` |
| `@chat-adapter/shared` | `^4.0.0` | `^4.24.0` |
| `@chat-adapter/state-memory` | `^4.0.0` | `^4.24.0` |

---

## Migration steps

### 1. Update dependencies

Update your `package.json` to require the newer versions:

**Before (v1):**

```json
{
  "peerDependencies": {
    "chat": "^4.0.0"
  },
  "dependencies": {
    "@chat-adapter/shared": "^4.0.0",
    "baileys": "7.0.0-rc.9"
  }
}
```

**After (v2):**

```json
{
  "peerDependencies": {
    "chat": "^4.24.0"
  },
  "dependencies": {
    "@chat-adapter/shared": "^4.24.0",
    "baileys": "7.0.0-rc.9"
  },
  "devDependencies": {
    "@chat-adapter/state-memory": "^4.24.0",
    "chat": "^4.24.0"
  }
}
```

### 2. Replace extension router usage

In v1, you created a router object with `createBaileysExtensions(...)` and called methods on it:

```ts
import { createBaileysAdapter, createBaileysExtensions } from "chat-adapter-baileys";

const waMain = createBaileysAdapter({ adapterName: "baileys-main", auth: authMain });
const waSales = createBaileysAdapter({ adapterName: "baileys-sales", auth: authSales });

const wa = createBaileysExtensions(waMain, waSales);

bot.onSubscribedMessage(async (thread, message) => {
  await wa.reply(message, "Got it!");
  await wa.markRead(thread.threadId, [message.id]);
});
```

In v2, use the adapter already attached to the thread:

```ts
import { requireBaileysAdapter } from "chat-adapter-baileys";

bot.onSubscribedMessage(async (thread, message) => {
  const wa = requireBaileysAdapter(thread);
  await wa.reply(message, "Got it!");
  await wa.markRead(
    thread.threadId,
    [message.id],
    thread.isDM ? undefined : message.author.userId
  );
});
```

If you need to branch by platform (e.g., supporting both WhatsApp and Slack):

```ts
import { isBaileysAdapter } from "chat-adapter-baileys";

bot.onSubscribedMessage(async (thread, message) => {
  const adapter = thread.adapter;

  if (isBaileysAdapter(adapter)) {
    await adapter.markRead(
      thread.threadId,
      [message.id],
      thread.isDM ? undefined : message.author.userId
    );
    return;
  }

  await thread.post("Read receipts are not supported here.");
});
```

**Why this changed:**

In v1, WhatsApp extensions lived in a separate router object outside the Chat SDK handler context. In v2, the extension surface stays on the concrete `BaileysAdapter`, and handlers reach it through `thread.adapter` narrowing. This is simpler, more type-safe, and works naturally in multi-account setups because each thread already carries the adapter that received the message.

### 3. Update multi-account patterns

For per-thread operations, use the thread's adapter:

```ts
const wa = requireBaileysAdapter(thread);
await wa.reply(message, "Handled by the right account");
```

For account-wide operations (like setting presence), keep direct references to the adapters:

```ts
await Promise.all([
  waMain.setPresence("available"),
  waSales.setPresence("available"),
]);
```

### 4. Update reaction handlers

Inbound WhatsApp reactions now trigger Chat SDK reaction handlers. Update any reaction handling code to use the current event fields:

```ts
bot.onReaction(["👍", "👎"], async (event) => {
  const action = event.added ? "added" : "removed";
  console.log(`${event.user.userName} ${action} ${event.emoji}`);
});
```

Note the current Chat SDK event fields:

- `event.added` — boolean indicating if the reaction was added or removed
- `event.user` — the user who reacted
- `event.messageId` — the message that was reacted to

Do not use older example field names like `event.isAdded` or `event.author`.

### 5. Review stricter transport validation

Version 2 is less permissive in a few places. Check your code for these patterns:

**`reply(message, text)`:**

- Now validates that `message.threadId` matches the quoted message JID
- Now marks the inbound message as read before sending the quoted reply

**`markRead(threadId, messageIds, participant?)`:**

- Now returns immediately when `messageIds` is empty

**`sendLocation(threadId, latitude, longitude, options?)`:**

- Now rejects invalid coordinates

**`sendPoll(threadId, question, options, selectableCount?)`:**

- Now rejects:
  - Empty question text
  - Fewer than 2 options
  - More than 12 options
  - Empty option strings
  - Negative or non-integer `selectableCount`

If your v1 code relied on loose input handling, fix the caller rather than trying to preserve the old behavior.

---

## What stays the same

- `BaileysAdapter` still exposes the same WhatsApp-specific methods:
  - `reply(...)`
  - `markRead(...)`
  - `setPresence(...)`
  - `sendLocation(...)`
  - `sendPoll(...)`
  - `fetchGroupParticipants(...)`
- `baileys` remains on `7.0.0-rc.9`
- Cards still degrade to plain-text fallback
- WhatsApp still has no real sub-threads
- History fetching still returns empty unless you persist your own message store
- Slash commands, modals, ephemeral messages, and scheduled messages are still intentionally unsupported

---

## Migration checklist

- [ ] Upgrade `chat` and `@chat-adapter/*` dependencies to `4.24.0`
- [ ] Remove all uses of `createBaileysExtensions(...)`
- [ ] Replace router usage with `requireBaileysAdapter(thread)` or `isBaileysAdapter(thread.adapter)`
- [ ] Update any reaction handlers to use `event.added` and `event.user`
- [ ] Check callers for invalid location or poll inputs that v2 now rejects
