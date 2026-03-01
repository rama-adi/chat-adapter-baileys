/**
 * Full example: echo bot using chat-adapter-baileys
 *
 * This file shows the complete lifecycle in one script:
 *   1. Load (or establish) auth credentials
 *   2. Create the adapter + Chat instance
 *   3. Register handlers
 *   4. Connect
 *
 * For production use:
 *   - Replace useMultiFileAuthState with a database-backed store
 *   - Replace MemoryStateAdapter with a persistent state adapter
 *   - Run the auth setup once in a separate script (see quickstart.md)
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";
import { Chat } from "chat";

// ---------------------------------------------------------------------------
// Auth state
// WARNING: useMultiFileAuthState is NOT for production use — it does heavy
// file I/O. Swap for a DB-backed store before going live.
// ---------------------------------------------------------------------------
const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

// ---------------------------------------------------------------------------
// Adapter — choose QR or pairing code below, not both
// ---------------------------------------------------------------------------
const adapter = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "echo-bot",

  // ── Option A: QR code ──────────────────────────────────────────────────
  // Scan the QR with WhatsApp on your phone.
  onQR: async (qr) => {
    // Install: npm install qrcode
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },

  // ── Option B: Pairing code ─────────────────────────────────────────────
  // Uncomment these and remove onQR above.
  // phoneNumber: "12345678901",  // E.164, no leading +
  // onPairingCode: (code) => {
  //   console.log("Enter this code in WhatsApp → Linked Devices:", code);
  // },
});

// ---------------------------------------------------------------------------
// Chat SDK instance + handlers
// ---------------------------------------------------------------------------
const bot = new Chat({
  userName: "echo-bot",
  adapters: { whatsapp: adapter },
  // Replace with a real state adapter (Redis, Postgres, etc.) in production
  state: new MemoryStateAdapter(),
});

// Reply when @-mentioned in a group
bot.onNewMention(async (thread, message) => {
  await thread.post(
    `Hello, ${message.author.fullName || message.author.userName}! You mentioned me.`
  );
  // Subscribe so follow-up messages also reach onSubscribedMessage
  await thread.subscribe();
});

// Handle follow-ups in threads the bot has subscribed to
bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await thread.post(`Got it: "${message.text}"`);
});

// Echo direct messages
bot.onNewMessage(/.+/, async (thread, message) => {
  if (message.author.isMe || !thread.isDM) return;
  await thread.post(`Echo: ${message.text}`);
});

// ---------------------------------------------------------------------------
// Connect — starts the WhatsApp WebSocket.
// The adapter handles reconnection automatically on unexpected disconnects.
// ---------------------------------------------------------------------------
await adapter.connect();
console.log("Bot connected. Waiting for messages…");
