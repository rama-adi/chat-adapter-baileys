import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "./src";

// 1. Load (or create) the session credentials
const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

// 2. Create the adapter
const whatsapp = createBaileysAdapter({
    auth: { state, saveCreds },
    userName: "my-bot",
    // Called when a QR code is available — scan with WhatsApp → Linked Devices
    onQR: async (qr) => {
        const QRCode = await import("qrcode");
        console.log(await QRCode.toString(qr, { type: "terminal" }));
    },
});

// 3. Create the Chat instance
const bot = new Chat({
    userName: "my-bot",
    adapters: { whatsapp },
    state: createMemoryState(),
});

// 4. Register handlers
function logMessage(
    source: "mention" | "subscribed" | "new",
    thread: { id: string; isDM: boolean },
    message: {
        id: string;
        text: string;
        author: { userId: string; userName: string; isMe: boolean };
    }
) {
    console.log(
        `[${source}] id=${message.id} thread=${thread.id} isDM=${thread.isDM} fromMe=${message.author.isMe} author=${message.author.userId} name=${JSON.stringify(message.author.userName)} text=${JSON.stringify(message.text)}`
    );
}

async function handleIncoming(
    source: "mention" | "subscribed" | "new",
    thread: { id: string; isDM: boolean },
    message: {
        id: string;
        text: string;
        author: { userId: string; userName: string; isMe: boolean };
    }
) {
    logMessage(source, thread, message);
    if (message.author.isMe) return;
    try {
        await whatsapp.markRead(thread.id, [message.id]);
    } catch (error) {
        console.error(`[markRead:error] thread=${thread.id} id=${message.id}`, error);
    }
}

bot.onNewMention(async (thread, message) => {
    // Mention in an unsubscribed group thread
    await handleIncoming("mention", thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
    // Message in a subscribed thread
    await handleIncoming("subscribed", thread, message);
});

bot.onNewMessage(/[\s\S]*/, async (thread, message) => {
    // Message in an unsubscribed thread (DM or group)
    await handleIncoming("new", thread, message);
});

// 5. Initialize Chat so adapters receive a Chat instance, then connect socket
await bot.initialize();
await whatsapp.connect();
