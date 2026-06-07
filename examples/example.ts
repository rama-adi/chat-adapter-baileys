/**
 * Kitchen sink WhatsApp example for chat-adapter-baileys.
 *
 * Run from this repository:
 *
 *   pnpm dlx tsx examples/example.ts
 *
 * Optional pairing-code auth instead of QR:
 *
 *   WA_PAIRING_PHONE=15551234567 pnpm dlx tsx examples/example.ts
 *
 * Try it:
 *
 *   1. Pair a personal WhatsApp account.
 *   2. From the paired phone itself, send "!identity" to any DM or group where
 *      this bot can receive the message.
 *   3. Confirm the handler replies with metadata.fromMe=true and
 *      author.isMe=false. That verifies the paired-account identity fix:
 *      owner-sent messages reach onNewMessage, but adapter echoes still remain
 *      self messages for Chat SDK loop prevention.
 *   4. Send the commands listed by "!help" to exercise the adapter API surface:
 *      named markRead/sendLocation/sendPoll arguments, poll metadata, poll
 *      vote handlers, tracked poll listing, replies, reactions, and
 *      pairing-code auth.
 */

import { Chat, type Message, type Thread } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState, type WAMessage } from "baileys";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  createBaileysAdapter,
  requireBaileysAdapter,
  type BaileysAdapterConfig,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const adapterName = process.env.WA_ADAPTER_NAME ?? "baileys-kitchen-sink";
const defaultAuthDir = "./auth_info_example";
const authDir = process.env.WA_AUTH_DIR ?? defaultAuthDir;
const botName = process.env.WA_BOT_NAME ?? "baileys-kitchen-sink";
const pairingPhone = process.env.WA_PAIRING_PHONE;
const usingDefaultAuthDir = !process.env.WA_AUTH_DIR;

if (pairingPhone && usingDefaultAuthDir) {
  try {
    const rawCreds = await readFile(`${authDir}/creds.json`, "utf8");
    const creds = JSON.parse(rawCreds) as {
      me?: unknown;
      pairingCode?: unknown;
      registered?: boolean;
    };
    if (creds.registered === false && (creds.me || creds.pairingCode)) {
      await rm(authDir, { recursive: true, force: true });
      console.warn(`Removed incomplete pairing auth state from ${authDir}.`);
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
}

const { state, saveCreds } = await useMultiFileAuthState(authDir);

const authConfig: Pick<
  BaileysAdapterConfig,
  "phoneNumber" | "onPairingCode" | "onQR"
> = pairingPhone
  ? {
      phoneNumber: pairingPhone,
      onPairingCode: (code) => {
        console.log(`Pairing code for ${pairingPhone}: ${code}`);
        console.log("Enter it in WhatsApp > Linked devices > Link with phone number.");
      },
    }
  : {
      onQR: async (qr) => {
        const QRCode = require("qrcode") as {
          toString(data: string, options: { type: "terminal" }): Promise<string>;
        };
        console.log("\nScan this QR in WhatsApp > Linked devices:\n");
        console.log(await QRCode.toString(qr, { type: "terminal" }));
      },
    };

const whatsapp = createBaileysAdapter({
  adapterName,
  auth: { state, saveCreds },
  userName: botName,
  pollTtlMs: 7 * 24 * 60 * 60 * 1000,
  ...authConfig,
});

const bot = new Chat({
  userName: botName,
  adapters: { whatsapp },
  state: createMemoryState(),
});

type IncomingSource = "mention" | "subscribed" | "new";

interface Command {
  name: string;
  args: string[];
}

function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;

  const [name = "", ...args] = trimmed.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), args };
}

function metadataFromMe(message: Message): boolean | undefined {
  return (message.metadata as { fromMe?: boolean }).fromMe;
}

function participantFor(thread: Thread, message: Message): string | undefined {
  return thread.isDM ? undefined : message.author.userId;
}

function formatIdentity(source: IncomingSource, thread: Thread, message: Message): string {
  return [
    `source=${source}`,
    `thread=${thread.id}`,
    `isDM=${thread.isDM}`,
    `message.id=${message.id}`,
    `author.userId=${message.author.userId}`,
    `author.userName=${message.author.userName}`,
    `author.isMe=${message.author.isMe}`,
    `author.isBot=${message.author.isBot}`,
    `metadata.fromMe=${metadataFromMe(message)}`,
    `metadata.edited=${message.metadata.edited}`,
    `attachments=${message.attachments.length}`,
  ].join("\n");
}

function helpText(): string {
  return [
    "Kitchen sink example commands:",
    "!identity - print author.isMe/isBot and metadata.fromMe",
    "!subscribe - subscribe this thread for onSubscribedMessage",
    "!unsubscribe - unsubscribe this thread",
    "!markread - mark this message read using named arguments",
    "!reply [text] - send a native quoted reply",
    "!react - add and remove a reaction through the adapter",
    "!location - send a native WhatsApp location pin",
    "!poll - send a poll with metadata and scoped vote handler",
    "!polls - list tracked polls and metadata",
    "!forget <pollMessageId> - forget one tracked poll",
    "!presence available|unavailable - set global WhatsApp presence",
    "!dm <phone-or-jid> <text> - open a DM thread and post directly",
  ].join("\n");
}

async function handleIncoming(
  source: IncomingSource,
  thread: Thread,
  message: Message<WAMessage>
): Promise<void> {
  console.log(`\n[${source}]\n${formatIdentity(source, thread, message)}`);
  console.log(`text=${JSON.stringify(message.text)}`);

  if (message.author.isMe) {
    console.log("Skipping adapter-authored echo.");
    return;
  }

  const command = parseCommand(message.text);
  if (!command) return;

  const wa = requireBaileysAdapter(thread);
  const participant = participantFor(thread, message);

  switch (command.name) {
    case "help":
      await thread.post(helpText());
      return;

    case "identity":
      await thread.post(formatIdentity(source, thread, message));
      return;

    case "subscribe":
      await thread.subscribe();
      await thread.post("Subscribed. Follow-up messages now use onSubscribedMessage.");
      return;

    case "unsubscribe":
      await thread.unsubscribe();
      await thread.post("Unsubscribed. Matching commands now use onNewMessage again.");
      return;

    case "markread":
      await wa.markRead({
        threadId: thread.id,
        messageIds: [message.id],
        participant,
      });
      await thread.post("Marked this message read with markRead({ ... }).");
      return;

    case "reply":
      await wa.reply(message, command.args.join(" ") || "Quoted reply from the kitchen sink example.");
      return;

    case "react":
      await wa.addReaction(thread.id, message.id, "✅", participant);
      await thread.post("Reaction added. Removing it in 2 seconds...");
      setTimeout(() => {
        void wa.removeReaction(thread.id, message.id, "✅", participant).catch((error) => {
          console.error("removeReaction failed", error);
        });
      }, 2000);
      return;

    case "location":
      await wa.sendLocation({
        threadId: thread.id,
        latitude: -6.2088,
        longitude: 106.8456,
        name: "Jakarta example pin",
        address: "Jakarta, Indonesia",
      });
      return;

    case "poll": {
      const poll = await wa.sendPoll({
        threadId: thread.id,
        question: "Which adapter path should we verify?",
        options: ["identity", "poll metadata", "location"],
        selectableCount: 1,
        metadata: {
          createdBy: message.author.userId,
          createdFrom: source,
          purpose: "kitchen sink example",
        },
      });

      wa.onPollVote(poll.id, async (vote) => {
        await thread.post(
          [
            `Scoped vote handler fired for poll ${vote.pollMessageId}.`,
            `voter=${vote.voter.userName}`,
            `selected=${vote.selectedOptions.join(", ") || "(cleared)"}`,
            `metadata=${JSON.stringify(vote.metadata)}`,
          ].join("\n")
        );
      });

      await thread.post(`Poll sent and scoped handler registered: ${poll.id}`);
      return;
    }

    case "polls": {
      const tracked = await wa.listTrackedPolls();
      if (tracked.length === 0) {
        await thread.post("No tracked polls.");
        return;
      }

      await thread.post(
        tracked
          .map((poll) =>
            [
              `id=${poll.pollMessageId}`,
              `question=${poll.question}`,
              `options=${poll.options.join(", ")}`,
              `metadata=${JSON.stringify(poll.metadata)}`,
            ].join("\n")
          )
          .join("\n\n")
      );
      return;
    }

    case "forget": {
      const [pollMessageId] = command.args;
      if (!pollMessageId) {
        await thread.post("Usage: !forget <pollMessageId>");
        return;
      }

      await wa.forgetPoll(pollMessageId);
      await thread.post(`Forgot tracked poll ${pollMessageId}.`);
      return;
    }

    case "presence": {
      const presence = command.args[0];
      if (presence !== "available" && presence !== "unavailable") {
        await thread.post("Usage: !presence available|unavailable");
        return;
      }

      await wa.setPresence(presence);
      await thread.post(`Presence set to ${presence}.`);
      return;
    }

    case "dm": {
      const [userId, ...textParts] = command.args;
      const text = textParts.join(" ");
      if (!userId || !text) {
        await thread.post("Usage: !dm <phone-or-jid> <text>");
        return;
      }

      const dmThreadId = await wa.openDM(userId);
      await wa.postMessage(dmThreadId, { raw: text });
      await thread.post(`Sent DM to ${userId}.`);
      return;
    }

    default:
      await thread.post(`Unknown command "${command.name}". Send !help.`);
  }
}

whatsapp.onPollVote(async (vote) => {
  console.log(
    [
      "\n[poll-vote:global]",
      `thread=${vote.threadId}`,
      `poll=${vote.pollMessageId}`,
      `question=${vote.question}`,
      `voter=${vote.voter.userId}`,
      `voter.isMe=${vote.voter.isMe}`,
      `voter.isBot=${vote.voter.isBot}`,
      `selected=${vote.selectedOptions.join(", ") || "(cleared)"}`,
      `metadata=${JSON.stringify(vote.metadata)}`,
    ].join("\n")
  );
});

bot.onReaction(async (event) => {
  console.log(
    [
      "\n[reaction]",
      `thread=${event.threadId}`,
      `message=${event.messageId}`,
      `emoji=${event.rawEmoji}`,
      `added=${event.added}`,
      `user=${event.user.userId}`,
      `user.isMe=${event.user.isMe}`,
      `user.isBot=${event.user.isBot}`,
    ].join("\n")
  );
});

bot.onNewMention(async (thread, message) => {
  await handleIncoming("mention", thread, message as Message<WAMessage>);
});

bot.onSubscribedMessage(async (thread, message) => {
  await handleIncoming("subscribed", thread, message as Message<WAMessage>);
});

bot.onNewMessage(/^!/, async (thread, message) => {
  await handleIncoming("new", thread, message as Message<WAMessage>);
});

await bot.initialize();

const tracked = await whatsapp.listTrackedPolls();
for (const poll of tracked) {
  whatsapp.onPollVote(poll.pollMessageId, (vote) => {
    console.log(
      `[poll-vote:resumed] id=${vote.pollMessageId} selected=${vote.selectedOptions.join(", ") || "(cleared)"}`
    );
  });
}
console.log(`Resumed ${tracked.length} tracked poll handler(s).`);

await whatsapp.connect();

console.log(`Socket started for adapter "${adapterName}". Send !help in WhatsApp after it opens.`);

const shutdown = async () => {
  console.log("\nShutting down...");
  await whatsapp.setPresence("unavailable").catch(() => undefined);
  await whatsapp.disconnect();
  await bot.shutdown();
  process.exit(0);
};

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
