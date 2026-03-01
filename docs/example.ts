/**
 * Runnable example bot for chat-adapter-baileys.
 *
 * Run with tsx/ts-node after installing dependencies and authenticating.
 */

import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";

const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "echo-bot",
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});

const bot = new Chat({
  userName: "echo-bot",
  adapters: { whatsapp },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.post(`Hi ${message.author.userName}, I saw your mention.`);
  await thread.subscribe();
});

bot.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await thread.post(`Echo: ${message.text}`);
});

bot.onNewMessage(/.+/, async (thread, message) => {
  if (!thread.isDM || message.author.isMe) return;
  await thread.post(`DM echo: ${message.text}`);
});

await whatsapp.connect();
console.log("WhatsApp adapter connected.");
