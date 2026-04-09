/**
 * Comprehensive runnable example for chat-adapter-baileys.
 *
 * This file demonstrates the most common patterns for building a WhatsApp bot
 * with the Chat SDK. Run it with tsx or ts-node after installing dependencies:
 *
 *   pnpm add chat-adapter-baileys baileys chat @chat-adapter/state-memory qrcode
 *   npx tsx docs/example.ts
 *
 * On first run, a QR code is printed to the terminal. Scan it with WhatsApp
 * (Settings → Linked Devices → Link a Device). Credentials are saved to
 * ./auth_info and reused on subsequent runs — no re-scan needed.
 *
 * What this demonstrates:
 *   - QR-based auth and session persistence
 *   - Responding to @mentions in group chats
 *   - Command parsing in subscribed threads
 *   - Handling direct messages separately
 *   - Typing indicator
 *   - Reading and downloading media attachments
 *   - Adding and observing emoji reactions
 *   - Clean shutdown
 */

import { Chat, type Message } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";

// ---------------------------------------------------------------------------
// 1. Auth state
//
// useMultiFileAuthState reads/writes credentials from the given folder.
// The folder is created automatically if it doesn't exist.
// For production, replace this with a database-backed store.
// ---------------------------------------------------------------------------

const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

// ---------------------------------------------------------------------------
// 2. Create the adapter
//
// The adapter connects to WhatsApp via Baileys. The onQR callback is called
// whenever a new QR code is available — render it however suits your setup.
// ---------------------------------------------------------------------------

const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "helper-bot",
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log("\nScan this QR code in WhatsApp → Linked Devices:\n");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});

// ---------------------------------------------------------------------------
// 3. Create the Chat instance
//
// The Chat instance coordinates all adapters and dispatches messages to
// your handlers. Register ALL handlers before calling bot.initialize()/adapter.connect().
// ---------------------------------------------------------------------------

const bot = new Chat({
  userName: "helper-bot",
  adapters: { whatsapp },
  state: createMemoryState(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a command like "!ping" or "!echo hello world" from a message.
 * Returns null if the message doesn't start with "!".
 */
function extractCommand(text: string): { cmd: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  return { cmd: cmd.toLowerCase(), args };
}

/**
 * Summarize attachments without downloading them — useful for quick acks.
 * Returns null if the message has no attachments.
 */
async function summarizeIncomingMedia(message: Message): Promise<string | null> {
  if (!message.attachments.length) return null;

  const lines = message.attachments.map(
    (a) => `• ${a.type}${a.mimeType ? ` (${a.mimeType})` : ""}${a.name ? ` — ${a.name}` : ""}`
  );
  return `Received ${message.attachments.length} attachment(s):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// 4a. Handle @mentions in group chats
//
// onNewMention fires when the bot is @-mentioned in a group thread that it
// hasn't yet subscribed to. The typical response is to greet the user and
// subscribe so future messages are also handled by onSubscribedMessage.
// ---------------------------------------------------------------------------

bot.onNewMention(async (thread, message) => {
  // Show the typing indicator before doing any async work
  await thread.startTyping();

  await thread.post(
    `Hi ${message.author.userName}! I'm here.\n` +
      `Commands: !help, !ping, !echo <text>, !whoami, !unsubscribe`
  );

  // Subscribe so follow-up messages trigger onSubscribedMessage
  await thread.subscribe();
});

// ---------------------------------------------------------------------------
// 4b. Handle messages in subscribed threads
//
// After thread.subscribe(), every new message in that thread fires this
// handler — both in groups and in DMs if you subscribed to them.
// ---------------------------------------------------------------------------

bot.onSubscribedMessage(async (thread, message) => {
  // Ignore messages sent by the bot itself to avoid feedback loops
  if (message.author.isMe) return;

  // If the user sent media, acknowledge it first
  const mediaNotice = await summarizeIncomingMedia(message);
  if (mediaNotice) {
    await thread.post(mediaNotice);
  }

  // Parse a command; if there's no command, do nothing
  const parsed = extractCommand(message.text);
  if (!parsed) return;

  const { cmd, args } = parsed;

  switch (cmd) {
    case "help":
      await thread.post(
        "Available commands:\n" +
          "  !ping          — check if the bot is alive\n" +
          "  !echo <text>   — repeat back your text\n" +
          "  !whoami        — show your user info\n" +
          "  !unsubscribe   — stop the bot from watching this thread"
      );
      return;

    case "ping":
      await thread.post("pong");
      // React to the original message with a checkmark
      await message.addReaction("✅");
      return;

    case "echo":
      await thread.post(args.join(" ") || "(no text provided)");
      return;

    case "whoami":
      await thread.post(
        `You are: ${message.author.userName}\n` +
          `User ID: ${message.author.userId}\n` +
          `Thread: ${thread.isDM ? "Direct message" : "Group chat"}`
      );
      return;

    case "unsubscribe":
      await thread.unsubscribe();
      await thread.post("Done — I'll stop watching this thread.");
      return;

    default:
      await thread.post(`Unknown command: !${cmd}. Send !help for a list.`);
  }
});

// ---------------------------------------------------------------------------
// 4c. Handle new direct messages
//
// onNewMessage with a pattern fires when a message matching the pattern
// arrives in a thread the bot hasn't subscribed to. Filtering for
// thread.isDM lets you handle DMs separately from group mentions.
// ---------------------------------------------------------------------------

bot.onNewMessage(/.+/, async (thread, message) => {
  if (message.author.isMe) return;
  if (!thread.isDM) return; // Only handle DMs here; groups are handled above

  const parsed = extractCommand(message.text);

  if (!parsed) {
    // Not a command — echo the message back
    await thread.post(`You said: "${message.text}"\nSend !help for commands.`);
    return;
  }

  switch (parsed.cmd) {
    case "help":
      await thread.post("DM commands: !help, !ping, !echo <text>");
      return;
    case "ping":
      await thread.post("pong (DM)");
      return;
    case "echo":
      await thread.post(parsed.args.join(" ") || "(no text provided)");
      return;
    default:
      await thread.post(`Unknown command: !${parsed.cmd}`);
  }
});

// ---------------------------------------------------------------------------
// 4d. Observe reactions from other users
//
// onReaction fires when a user adds or removes one of the listed emojis
// from any message. Useful for logging, voting, or approval flows.
// ---------------------------------------------------------------------------

bot.onReaction(["👍", "👎", "✅", "❌"], async (event) => {
  const action = event.isAdded ? "added" : "removed";
  console.log(
    `[reaction] ${event.author.userName} ${action} ${event.emoji} on message ${event.messageId}`
  );
});

// ---------------------------------------------------------------------------
// 5. Clean shutdown
//
// Call disconnect() to close the WebSocket before exiting. This prevents
// the process from hanging on open handles.
// ---------------------------------------------------------------------------

process.on("SIGTERM", async () => {
  console.log("\nShutting down...");
  await whatsapp.disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await whatsapp.disconnect();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// 6. Initialize and connect
//
// Always call bot.initialize() and connect() AFTER registering all handlers.
// The adapter opens the WebSocket and starts receiving messages immediately.
// Auto-reconnect is enabled by default for unexpected disconnects.
// ---------------------------------------------------------------------------

await bot.initialize();
await whatsapp.connect();
console.log("WhatsApp adapter connected. Waiting for messages...");
