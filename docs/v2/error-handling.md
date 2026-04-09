# Error Handling and Validation

This guide explains the errors you might encounter when using the WhatsApp adapter and how to handle them gracefully.

Related docs:

- [Quickstart](./quickstart.md) — basic setup and first bot
- [Concepts](./concepts.md) — how Chat SDK concepts map to WhatsApp
- [Events and Lifecycle](./events-and-lifecycle.md) — connection flow and WebSocket errors
- [Thread IDs and Multi-Account](./thread-ids-and-multi-account.md) — thread ID validation and constraints
- [Extensions](./extensions.md) — WhatsApp-specific methods with their validation rules
- [Formatting and Media](./formatting-and-media.md) — text formatting and file handling
- [Migrating from v1 to v2](../migration/v1-to-v2.md) — upgrade guide

---

## Understanding ValidationError

The adapter throws `ValidationError` (from `@chat-adapter/shared`) when you pass invalid arguments or call methods in the wrong state. These errors have:

- A clear message explaining what went wrong
- The adapter name as context
- Suggestions for fixing the issue

Always wrap adapter calls in try-catch blocks when dealing with user input or external data:

```ts
import { ValidationError } from "@chat-adapter/shared";

bot.onSubscribedMessage(async (thread, message) => {
  try {
    await requireBaileysAdapter(thread).sendLocation(
      thread.threadId,
      999,  // Invalid latitude
      -122.4194
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      // Send a friendly error to the user
      await thread.post("Invalid coordinates. Latitude must be between -90 and 90.");
      return;
    }
    throw err; // Re-throw unexpected errors
  }
});
```

---

## Common validation scenarios

### Adapter name contains colon

**When it happens:** Creating an adapter with `:` in the `adapterName`.

**Why:** Thread IDs use `adapterName:encodedJid` format, so `:` is reserved.

```ts
// This throws immediately
const wa = createBaileysAdapter({
  adapterName: "baileys:main",  // ❌ Invalid — contains ":"
  auth: { state, saveCreds },
});
// ValidationError: Invalid adapterName "baileys:main". ":" is not allowed.
```

**Fix:** Use hyphens or underscores instead:

```ts
adapterName: "baileys-main"  // ✅ Valid
```

---

### Socket not connected

**When it happens:** Calling any method that requires an active connection before `connect()` or after `disconnect()`.

**Affected methods:** All sending methods (`postMessage`, `reply`, `sendPoll`, etc.) plus `markRead`, `setPresence`, `fetchGroupParticipants`.

```ts
const wa = createBaileysAdapter({ auth: { state, saveCreds } });
// Forgot to call wa.connect()

await wa.setPresence("available");
// ValidationError: Socket not connected. Call adapter.connect() first.
```

**Fix:** Ensure proper startup sequence:

```ts
await bot.initialize();
await wa.connect();  // ✅ Connect before using methods
await wa.setPresence("available");
```

---

### Invalid thread ID format

**When it happens:** Passing a malformed thread ID to `decodeThreadId()` or any method that accepts thread IDs.

**Why:** Thread IDs must follow `adapterName:base64url(jid)` format.

```ts
// Wrong adapter name prefix
wa.decodeThreadId("slack:MTU1NTEyMzQ1NjdAcy53aGF0c2FwcC5uZXQ");
// ValidationError: Invalid Baileys thread ID: slack:MTU1...
```

**Fix:** Only use thread IDs that came from the adapter itself (via handlers or `openDM`).

---

### Reply message belongs to different adapter

**When it happens:** Calling `reply()` with a message that came from a different adapter instance.

**Common in:** Multi-account setups where you accidentally mix up `waMain` and `waSales`.

```ts
const waMain = createBaileysAdapter({ adapterName: "main", auth: authMain });
const waSales = createBaileysAdapter({ adapterName: "sales", auth: authSales });

bot.onSubscribedMessage(async (thread, message) => {
  // If message came from waSales, this will fail:
  await waMain.reply(message, "Got it!");
  // ValidationError: reply: message belongs to adapter "sales", not "main"
});
```

**Fix:** Use the thread's attached adapter instead of a hardcoded reference:

```ts
bot.onSubscribedMessage(async (thread, message) => {
  const wa = requireBaileysAdapter(thread);  // ✅ Gets the right adapter
  await wa.reply(message, "Got it!");
});
```

---

### Reply message thread mismatch

**When it happens:** The message's thread ID doesn't match its raw JID — usually indicates data corruption or manual thread ID construction.

```ts
// Rare — only happens with corrupted data
wa.reply(corruptedMessage, "text");
// ValidationError: reply: message threadId does not match the quoted message JID
```

**Fix:** Don't manually construct thread IDs. Use `openDM()` or thread IDs from handlers.

---

### Invalid location coordinates

**When it happens:** Passing out-of-range latitude or longitude to `sendLocation()`.

```ts
await wa.sendLocation(threadId, 999, -122.4194);
// ValidationError: sendLocation: latitude must be between -90 and 90. Received 999.

await wa.sendLocation(threadId, 37.7749, 999);
// ValidationError: sendLocation: longitude must be between -180 and 180. Received 999.
```

**Fix:** Validate coordinates before calling:

```ts
function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}
```

---

### Invalid poll configuration

**When it happens:** `sendPoll()` receives bad parameters.

| Issue | Error message |
|-------|---------------|
| Empty question | `sendPoll: question must not be empty.` |
| Too few options | `sendPoll: WhatsApp polls require between 2 and 12 options. Received 1.` |
| Too many options | Same as above, when > 12 |
| Empty option string | `sendPoll: poll options must not be empty.` |
| Bad selectableCount | `sendPoll: selectableCount must be an integer >= 0. Received -1.` |

```ts
await wa.sendPoll(threadId, "", ["A", "B"]);
// ValidationError: sendPoll: question must not be empty.

await wa.sendPoll(threadId, "Question?", ["Only one option"]);
// ValidationError: WhatsApp polls require between 2 and 12 options. Received 1.
```

**Fix:** Validate user input before creating polls:

```ts
async function createSafePoll(threadId: string, question: string, options: string[]) {
  const trimmedQuestion = question.trim();
  const validOptions = options.map(o => o.trim()).filter(o => o.length > 0);
  
  if (trimmedQuestion.length === 0) {
    throw new Error("Question cannot be empty");
  }
  if (validOptions.length < 2 || validOptions.length > 12) {
    throw new Error("Need 2-12 valid options");
  }
  
  return wa.sendPoll(threadId, trimmedQuestion, validOptions);
}
```

---

### Not a group thread

**When it happens:** Calling `fetchGroupParticipants()` on a DM thread.

```ts
// thread.isDM is true
await wa.fetchGroupParticipants(threadId);
// ValidationError: fetchGroupParticipants: thread is not a group
```

**Fix:** Check `thread.isDM` first:

```ts
if (!thread.isDM) {
  const participants = await wa.fetchGroupParticipants(thread.threadId);
  // ...
}
```

---

### Message has no remote JID

**When it happens:** Extremely rare — the raw Baileys message is missing its JID field when calling `reply()`.

```ts
wa.reply(incompleteMessage, "text");
// ValidationError: reply: message has no remoteJid
```

**Fix:** This indicates corrupted or synthetic message data. Ensure you're only replying to genuine incoming messages from handlers.

---

### Context doesn't belong to a Baileys adapter

**When it happens:** Calling `requireBaileysAdapter()` with a thread or adapter from a different platform (e.g., passing a Slack thread to a WhatsApp adapter).

**Common in:** Multi-adapter bots where handler logic accidentally mixes up adapter types.

```ts
// Assuming 'thread' came from a Slack adapter, not WhatsApp
const wa = requireBaileysAdapter(thread);
// ValidationError: This context does not belong to a Baileys adapter.
```

**Fix:** Ensure you're using the correct adapter for the context. Use `isBaileysAdapter()` to check first if unsure:

```ts
if (isBaileysAdapter(thread.adapter)) {
  const wa = requireBaileysAdapter(thread);
  // ... use WhatsApp-specific methods
}
```

---

### Internal: sendMessage returned no message

**When it happens:** Extremely rare — Baileys' `sendMessage()` returns undefined, usually due to a network or protocol failure.

```ts
// Rare internal error
await wa.postMessage(threadId, "Hello");
// ValidationError: sendMessage returned no message.
```

**Fix:** This indicates a serious Baileys or network failure. Retry the operation or check your connection. If persistent, check Baileys logs for underlying issues.

---

## WebSocket errors (not ValidationError)

Baileys emits WebSocket errors that aren't `ValidationError` instances. These indicate network or protocol issues rather than input validation problems.

### Common WebSocket error scenarios

| Situation | What happens | How to handle |
|-----------|--------------|-------------|
| **Connection dropped unexpectedly** | Baileys auto-reconnects automatically | No action needed — the adapter handles this |
| **Logged out (status code 401)** | Session invalidated from WhatsApp app | Delete saved credentials and re-authenticate with a fresh QR scan |
| **Network timeout** | Temporary connection loss | The adapter will retry with exponential backoff |
| **Server restart (code 515)** | Expected during QR scan handshake | The adapter reconnects automatically to complete authentication |

### Handling logged-out errors

When the bot is logged out from the WhatsApp app (code 401), you need to clear credentials and restart:

```ts
import fs from "fs";

function onLoggedOut() {
  console.warn("Bot was logged out. Delete auth_info/ and restart.");
  fs.rmSync("./auth_info", { recursive: true, force: true });
  process.exit(1);
}
```

See [Events and Lifecycle](./events-and-lifecycle.md) for detailed reconnection behavior and how to monitor connection state.

---

## Best practices for error handling

### 1. Distinguish validation from unexpected errors

```ts
bot.onSubscribedMessage(async (thread, message) => {
  try {
    const wa = requireBaileysAdapter(thread);
    await wa.sendLocation(threadId, lat, lng);
  } catch (err) {
    if (err instanceof ValidationError) {
      // User input problem — tell them
      await thread.post(`Invalid input: ${err.message}`);
      return;
    }
    
    // System problem — log and maybe alert
    console.error("Unexpected error:", err);
    await thread.post("Something went wrong. Please try again.");
  }
});
```

### 2. Pre-validate user input

Don't let validation errors reach the adapter — check first:

```ts
function validatePhoneNumber(num: string): boolean {
  return /^\d{10,15}$/.test(num.replace(/\D/g, ""));
}
```

### 3. Handle missing attachments gracefully

Not an error, but worth checking:

```ts
if (!attachment.fetchData) {
  await thread.post("This attachment can't be downloaded.");
  return;
}
```

### 4. Log validation errors for debugging

```ts
} catch (err) {
  if (err instanceof ValidationError) {
    console.warn("Validation failed:", err.message);
    // Handle gracefully...
  }
}
```

---

## Error message reference

| Method | Validation errors |
|--------|-------------------|
| `constructor` | `Invalid adapterName "X". ":" is not allowed.` |
| `reply` | `message belongs to adapter "X", not "Y"`, `message has no remoteJid`, `message threadId does not match the quoted message JID` |
| `markRead` | Socket not connected (via `_requireSocket`) |
| `sendLocation` | `latitude must be between -90 and 90`, `longitude must be between -180 and 180` |
| `sendPoll` | `question must not be empty`, `between 2 and 12 options`, `options must not be empty`, `selectableCount must be an integer >= 0` |
| `fetchGroupParticipants` | `thread is not a group` |
| `decodeThreadId` | `Invalid Baileys thread ID: X` |
| `requireBaileysAdapter` | `This context does not belong to a Baileys adapter.` |
| Internal (`_toRawMessage`) | `sendMessage returned no message.` |
| All sending methods | `Socket not connected. Call adapter.connect() first.` |
