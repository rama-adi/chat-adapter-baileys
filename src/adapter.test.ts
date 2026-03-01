import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInstance } from "chat";
import type { WAMessage } from "baileys";
import {
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
} from "baileys";
import { BaileysAdapter } from "./adapter.js";
import type { BaileysAdapterConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before vi.mock() calls
// ---------------------------------------------------------------------------

const { mockSocket, mockMakeWASocket } = vi.hoisted(() => {
  const socket = {
    ev: { process: vi.fn() },
    user: { id: "15551234567@s.whatsapp.net" },
    sendMessage: vi.fn(),
    groupMetadata: vi.fn(),
    sendPresenceUpdate: vi.fn(),
    readMessages: vi.fn(),
    end: vi.fn(),
    requestPairingCode: vi.fn(),
  };
  return { mockSocket: socket, mockMakeWASocket: vi.fn(() => socket) };
});

vi.mock("baileys", () => ({
  default: mockMakeWASocket,
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  isJidGroup: (jid: string) => jid.endsWith("@g.us"),
  isJidNewsletter: (jid: string) => jid.endsWith("@newsletter"),
  normalizeMessageContent: (content: Record<string, any> | undefined) => {
    if (!content) return undefined;
    let current = content;
    for (let i = 0; i < 5; i += 1) {
      const inner =
        current.ephemeralMessage ??
        current.viewOnceMessage ??
        current.documentWithCaptionMessage ??
        current.viewOnceMessageV2 ??
        current.viewOnceMessageV2Extension ??
        current.editedMessage;
      if (!inner?.message) break;
      current = inner.message;
    }
    return current;
  },
  extractMessageContent: (content: Record<string, any> | undefined) => content,
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("mock-media")),
  generateMessageIDV2: vi.fn(() => "generated-id"),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type EvHandler = (events: Record<string, unknown>) => Promise<void>;

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const mockChat = {
  getLogger: vi.fn(() => mockLogger),
  processMessage: vi.fn(),
  getState: vi.fn(),
  getUserName: vi.fn(() => "mybot"),
  processAction: vi.fn(),
  processAppHomeOpened: vi.fn(),
  processAssistantContextChanged: vi.fn(),
  processAssistantThreadStarted: vi.fn(),
  processReaction: vi.fn(),
  processSlashCommand: vi.fn(),
  processModalClose: vi.fn(),
  processModalSubmit: vi.fn(),
} satisfies Partial<ChatInstance> as unknown as ChatInstance;

const mockAuthState: BaileysAdapterConfig["auth"] = {
  state: { creds: {} as never, keys: {} as never },
  saveCreds: vi.fn(),
};

function makeAdapter(overrides?: Partial<BaileysAdapterConfig>): BaileysAdapter {
  return new BaileysAdapter({
    auth: mockAuthState,
    userName: "test-bot",
    ...overrides,
  });
}

function makeDMMessage(overrides?: Partial<WAMessage>): WAMessage {
  return {
    key: { remoteJid: "15551234567@s.whatsapp.net", id: "msg-dm-1", fromMe: false },
    message: { conversation: "Hello, world!" },
    pushName: "John",
    messageTimestamp: 1700000000,
    ...overrides,
  } as WAMessage;
}

function makeGroupMessage(overrides?: Partial<WAMessage>): WAMessage {
  return {
    key: {
      remoteJid: "123456789@g.us",
      id: "msg-group-1",
      fromMe: false,
      participant: "15559876543@s.whatsapp.net",
    },
    message: { conversation: "Group hello!" },
    pushName: "Alice",
    messageTimestamp: 1700000001,
    ...overrides,
  } as WAMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BaileysAdapter", () => {
  let adapter: BaileysAdapter;
  let capturedEvHandler: EvHandler | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedEvHandler = null;

    mockSocket.ev.process.mockImplementation((handler: EvHandler) => {
      capturedEvHandler = handler;
    });
    mockSocket.sendMessage.mockResolvedValue({
      key: { id: "sent-msg-id", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
      message: { conversation: "sent" },
    });
    mockSocket.requestPairingCode.mockResolvedValue("PAIR-1234");

    adapter = makeAdapter();
    await adapter.initialize(mockChat);
  });

  afterEach(() => {
    capturedEvHandler = null;
  });

  // ── Thread ID ──────────────────────────────────────────────────────────────

  describe("encodeThreadId / decodeThreadId", () => {
    it("roundtrips a DM JID", () => {
      const jid = "15551234567@s.whatsapp.net";
      const encoded = adapter.encodeThreadId({ jid });
      expect(encoded).toMatch(/^baileys:/);
      expect(adapter.decodeThreadId(encoded)).toEqual({ jid });
    });

    it("roundtrips a group JID", () => {
      const jid = "123456789@g.us";
      expect(adapter.decodeThreadId(adapter.encodeThreadId({ jid }))).toEqual({ jid });
    });

    it("handles JIDs with special characters (@ and .)", () => {
      const jid = "group.123+abc@g.us";
      expect(adapter.decodeThreadId(adapter.encodeThreadId({ jid }))).toEqual({ jid });
    });

    it("throws on an invalid thread ID (no prefix)", () => {
      expect(() => adapter.decodeThreadId("invalid")).toThrow();
    });

    it("throws on a wrong adapter prefix", () => {
      expect(() => adapter.decodeThreadId("slack:somechannel")).toThrow();
    });

    it("uses custom adapterName as the thread-id prefix", async () => {
      const custom = makeAdapter({ adapterName: "baileys-main" });
      await custom.initialize(mockChat);
      const encoded = custom.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      expect(encoded).toMatch(/^baileys-main:/);
      expect(custom.decodeThreadId(encoded)).toEqual({
        jid: "15551234567@s.whatsapp.net",
      });
    });

    it("rejects thread IDs from a different baileys account prefix", async () => {
      const accountA = makeAdapter({ adapterName: "baileys-a" });
      const accountB = makeAdapter({ adapterName: "baileys-b" });
      await accountA.initialize(mockChat);
      await accountB.initialize(mockChat);

      const threadFromA = accountA.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      expect(() => accountB.decodeThreadId(threadFromA)).toThrow();
    });

    it("throws on invalid adapterName containing ':'", () => {
      expect(
        () =>
          new BaileysAdapter({
            auth: mockAuthState,
            adapterName: "baileys:main",
          })
      ).toThrow();
    });
  });

  // ── isDM ───────────────────────────────────────────────────────────────────

  describe("isDM", () => {
    it("returns true for individual (s.whatsapp.net) JIDs", () => {
      expect(adapter.isDM(adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" }))).toBe(true);
    });

    it("returns false for group (@g.us) JIDs", () => {
      expect(adapter.isDM(adapter.encodeThreadId({ jid: "123456789@g.us" }))).toBe(false);
    });
  });

  // ── channelIdFromThreadId ─────────────────────────────────────────────────

  describe("channelIdFromThreadId", () => {
    it("returns the same value as the thread ID (channel = conversation in WhatsApp)", () => {
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      expect(adapter.channelIdFromThreadId(threadId)).toBe(threadId);
    });
  });

  // ── handleWebhook ─────────────────────────────────────────────────────────

  describe("handleWebhook", () => {
    it("returns HTTP 501 — Baileys uses WebSocket, not inbound webhooks", async () => {
      const req = new Request("https://example.com/webhook", { method: "POST" });
      const res = await adapter.handleWebhook(req);
      expect(res.status).toBe(501);
      const body = (await res.json()) as Record<string, string>;
      expect(body.error).toMatch(/webhook/i);
    });
  });

  // ── connect lifecycle ─────────────────────────────────────────────────────

  describe("connect", () => {
    it("uses configured version without calling fetchLatestBaileysVersion", async () => {
      adapter = makeAdapter({ version: [2, 9999, 1] });
      await adapter.initialize(mockChat);
      await adapter.connect();

      expect(fetchLatestBaileysVersion).not.toHaveBeenCalled();
      expect(mockMakeWASocket).toHaveBeenCalledWith(
        expect.objectContaining({ version: [2, 9999, 1] })
      );
    });

    it("fetches latest version when no version is configured", async () => {
      await adapter.connect();
      expect(fetchLatestBaileysVersion).toHaveBeenCalledOnce();
    });
  });

  // ── parseMessage ──────────────────────────────────────────────────────────

  describe("parseMessage", () => {
    it("parses a DM message — text, author, id, threadId", () => {
      const msg = adapter.parseMessage(makeDMMessage());
      expect(msg.text).toBe("Hello, world!");
      expect(msg.id).toBe("msg-dm-1");
      expect(msg.author.userId).toBe("15551234567@s.whatsapp.net");
      expect(msg.author.userName).toBe("John");
      expect(msg.author.isMe).toBe(false);
      expect(adapter.decodeThreadId(msg.threadId).jid).toBe("15551234567@s.whatsapp.net");
    });

    it("uses participant JID as sender for group messages", () => {
      const msg = adapter.parseMessage(makeGroupMessage());
      expect(msg.author.userId).toBe("15559876543@s.whatsapp.net");
    });

    it("marks fromMe messages correctly", () => {
      const raw = makeDMMessage({
        key: { remoteJid: "15551234567@s.whatsapp.net", id: "m1", fromMe: true },
      });
      expect(adapter.parseMessage(raw).author.isMe).toBe(true);
    });

    it("extracts text from extendedTextMessage", () => {
      const raw = makeDMMessage({ message: { extendedTextMessage: { text: "Extended" } } });
      expect(adapter.parseMessage(raw).text).toBe("Extended");
    });

    it("extracts text from ephemeralMessage wrappers", () => {
      const raw = makeDMMessage({
        message: {
          ephemeralMessage: {
            message: {
              conversation: "Wrapped text",
            },
          },
        },
      });
      expect(adapter.parseMessage(raw).text).toBe("Wrapped text");
    });

    it("extracts caption from imageMessage", () => {
      const raw = makeDMMessage({ message: { imageMessage: { caption: "Look at this" } } });
      expect(adapter.parseMessage(raw).text).toBe("Look at this");
    });

    it("returns empty string when there is no text content", () => {
      const raw = makeDMMessage({ message: {} });
      expect(adapter.parseMessage(raw).text).toBe("");
    });

    it("attaches image attachment for imageMessage", () => {
      const raw = makeDMMessage({
        message: { imageMessage: { mimetype: "image/jpeg", caption: "" } },
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0].type).toBe("image");
      expect(msg.attachments[0].mimeType).toBe("image/jpeg");
    });

    it("attaches document attachment for documentMessage", () => {
      const raw = makeDMMessage({
        message: {
          documentMessage: { mimetype: "application/pdf", fileName: "report.pdf", caption: "" },
        },
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.attachments[0].type).toBe("file");
      expect(msg.attachments[0].name).toBe("report.pdf");
    });

    it("extracts caption and attachment from documentWithCaptionMessage wrappers", () => {
      const raw = makeDMMessage({
        message: {
          documentWithCaptionMessage: {
            message: {
              documentMessage: {
                mimetype: "application/pdf",
                fileName: "wrapped-report.pdf",
                caption: "Wrapped caption",
              },
            },
          },
        },
      });

      const msg = adapter.parseMessage(raw);
      expect(msg.text).toBe("Wrapped caption");
      expect(msg.attachments[0].type).toBe("file");
      expect(msg.attachments[0].name).toBe("wrapped-report.pdf");
    });

    it("attaches video attachment and exposes fetchData when socket exists", async () => {
      const raw = makeDMMessage({
        message: { videoMessage: { mimetype: "video/mp4", caption: "" } },
      });
      await adapter.connect();

      const msg = adapter.parseMessage(raw);
      expect(msg.attachments[0].type).toBe("video");
      expect(msg.attachments[0].fetchData).toBeTypeOf("function");
      await msg.attachments[0].fetchData?.();
      expect(downloadMediaMessage).toHaveBeenCalled();
    });

    it("attaches audio attachment and exposes fetchData when socket exists", async () => {
      const raw = makeDMMessage({
        message: { audioMessage: { mimetype: "audio/ogg" } },
      });
      await adapter.connect();

      const msg = adapter.parseMessage(raw);
      expect(msg.attachments[0].type).toBe("audio");
      expect(msg.attachments[0].fetchData).toBeTypeOf("function");
      await msg.attachments[0].fetchData?.();
      expect(downloadMediaMessage).toHaveBeenCalled();
    });

    it("uses generateMessageIDV2 when incoming message has no id", () => {
      const raw = makeDMMessage({
        key: { remoteJid: "15551234567@s.whatsapp.net", id: undefined, fromMe: false },
      });
      const parsed = adapter.parseMessage(raw);
      expect(generateMessageIDV2).toHaveBeenCalled();
      expect(parsed.id).toBe("generated-id");
    });

    it("marks edited metadata when protocolMessage type is edit", () => {
      const raw = makeDMMessage({
        message: { protocolMessage: { type: 14 } },
      });
      expect(adapter.parseMessage(raw).metadata.edited).toBe(true);
    });
  });

  // ── fetchMessages ─────────────────────────────────────────────────────────

  describe("fetchMessages", () => {
    it("returns empty messages array (no thread history API in WhatsApp)", async () => {
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      const result = await adapter.fetchMessages(threadId);
      expect(result.messages).toEqual([]);
    });
  });

  // ── fetchChannelMessages ──────────────────────────────────────────────────

  describe("fetchChannelMessages", () => {
    it("returns empty messages array (no history API in WhatsApp)", async () => {
      const channelId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      const result = await adapter.fetchChannelMessages(channelId);
      expect(result.messages).toEqual([]);
    });
  });

  // ── listThreads ───────────────────────────────────────────────────────────

  describe("listThreads", () => {
    it("returns empty threads (no sub-threading in WhatsApp)", async () => {
      const channelId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      const result = await adapter.listThreads(channelId);
      expect(result.threads).toEqual([]);
    });
  });

  // ── fetchChannelInfo (no socket required for DMs) ─────────────────────────

  describe("fetchChannelInfo", () => {
    it("returns isDM: true and metadata for a DM channel", async () => {
      const jid = "15551234567@s.whatsapp.net";
      const channelId = adapter.encodeThreadId({ jid });
      const info = await adapter.fetchChannelInfo(channelId);
      expect(info.id).toBe(channelId);
      expect(info.isDM).toBe(true);
      expect(info.metadata).toEqual({ jid });
      expect(info.name).toBeUndefined();
    });
  });

  // ── fetchThread (no socket required for DMs) ──────────────────────────────

  describe("fetchThread", () => {
    it("returns thread info for a DM with channelId === threadId", async () => {
      const jid = "15551234567@s.whatsapp.net";
      const threadId = adapter.encodeThreadId({ jid });
      const info = await adapter.fetchThread(threadId);
      expect(info.id).toBe(threadId);
      expect(info.channelId).toBe(threadId);
      expect(info.isDM).toBe(true);
    });
  });

  // ── renderFormatted ───────────────────────────────────────────────────────

  describe("renderFormatted", () => {
    it("renders mdast content into WhatsApp formatting", () => {
      const ast = adapter.parseMessage(makeDMMessage({ message: { conversation: "*bold*" } })).formatted;
      expect(adapter.renderFormatted(ast)).toContain("*bold*");
    });
  });

  // ── openDM ────────────────────────────────────────────────────────────────

  describe("openDM", () => {
    it("appends @s.whatsapp.net to a plain phone number", async () => {
      const threadId = await adapter.openDM("15551234567");
      expect(adapter.decodeThreadId(threadId).jid).toBe("15551234567@s.whatsapp.net");
    });

    it("uses a full JID as-is", async () => {
      const jid = "15559876543@s.whatsapp.net";
      const threadId = await adapter.openDM(jid);
      expect(adapter.decodeThreadId(threadId).jid).toBe(jid);
    });
  });

  // ── With connected socket ─────────────────────────────────────────────────

  describe("with connected socket", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    // ── postMessage ──────────────────────────────────────────────────────────

    describe("postMessage", () => {
      it("calls socket.sendMessage with the JID and text payload", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        const result = await adapter.postMessage(threadId, { raw: "Hello" });
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { text: "Hello" }
        );
        expect(result.id).toBe("sent-msg-id");
      });

      it("converts Markdown bold (**text**) to WhatsApp bold (*text*)", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.postMessage(threadId, { markdown: "**bold**" });
        const [, payload] = mockSocket.sendMessage.mock.calls[0] as [string, { text: string }];
        expect(payload.text).toContain("*bold*");
        expect(payload.text).not.toMatch(/\*\*bold\*\*/);
      });
    });

    // ── editMessage ──────────────────────────────────────────────────────────

    describe("editMessage", () => {
      it("sends an edit key alongside the updated text", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.editMessage(threadId, "original-id", { raw: "Updated" });
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          {
            edit: { remoteJid: "15551234567@s.whatsapp.net", id: "original-id", fromMe: true },
            text: "Updated",
          }
        );
      });
    });

    // ── deleteMessage ────────────────────────────────────────────────────────

    describe("deleteMessage", () => {
      it("sends a delete key to revoke the message", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.deleteMessage(threadId, "msg-to-delete");
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { delete: { remoteJid: "15551234567@s.whatsapp.net", id: "msg-to-delete", fromMe: true } }
        );
      });
    });

    // ── addReaction ──────────────────────────────────────────────────────────

    describe("addReaction", () => {
      it("sends a react payload with the emoji text", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.addReaction(threadId, "msg-id", "👍");
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          {
            react: {
              text: "👍",
              key: { remoteJid: "15551234567@s.whatsapp.net", id: "msg-id", fromMe: false },
            },
          }
        );
      });
    });

    // ── removeReaction ───────────────────────────────────────────────────────

    describe("removeReaction", () => {
      it("sends an empty react text to remove the reaction", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.removeReaction(threadId, "msg-id", "👍");
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          {
            react: {
              text: "",
              key: { remoteJid: "15551234567@s.whatsapp.net", id: "msg-id", fromMe: false },
            },
          }
        );
      });
    });

    // ── startTyping ──────────────────────────────────────────────────────────

    describe("startTyping", () => {
      it("calls sendPresenceUpdate with 'composing'", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.startTyping(threadId);
        expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith(
          "composing",
          "15551234567@s.whatsapp.net"
        );
      });
    });

    // ── postChannelMessage ───────────────────────────────────────────────────

    describe("postChannelMessage", () => {
      it("delegates to postMessage (channel === thread in WhatsApp)", async () => {
        const channelId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.postChannelMessage(channelId, { raw: "Channel msg" });
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { text: "Channel msg" }
        );
      });
    });

    // ── fetchChannelInfo (group requires groupMetadata) ───────────────────────

    describe("fetchChannelInfo — group", () => {
      it("fetches the group name and participant count via groupMetadata", async () => {
        const jid = "123456789@g.us";
        mockSocket.groupMetadata.mockResolvedValue({
          subject: "Test Group",
          participants: [{ id: "a" }, { id: "b" }, { id: "c" }],
        });
        const info = await adapter.fetchChannelInfo(adapter.encodeThreadId({ jid }));
        expect(info.name).toBe("Test Group");
        expect(info.memberCount).toBe(3);
        expect(info.isDM).toBe(false);
      });

      it("returns partial info when groupMetadata throws", async () => {
        const jid = "123456789@g.us";
        mockSocket.groupMetadata.mockRejectedValue(new Error("unavailable"));
        const info = await adapter.fetchChannelInfo(adapter.encodeThreadId({ jid }));
        expect(info.isDM).toBe(false);
        expect(info.name).toBeUndefined();
      });
    });

    // ── fetchThread (group) ───────────────────────────────────────────────────

    describe("fetchThread — group", () => {
      it("returns the group subject as channelName", async () => {
        const jid = "123456789@g.us";
        mockSocket.groupMetadata.mockResolvedValue({ subject: "My Group", participants: [] });
        const info = await adapter.fetchThread(adapter.encodeThreadId({ jid }));
        expect(info.channelName).toBe("My Group");
        expect(info.isDM).toBe(false);
      });
    });

    // ── reply (extension) ─────────────────────────────────────────────────────

    describe("reply (WhatsApp extension)", () => {
      it("sends sendMessage with the quoted raw message", async () => {
        const raw = makeDMMessage();
        const message = adapter.parseMessage(raw);
        await adapter.reply(message, "Got it!");
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { text: "Got it!" },
          { quoted: raw }
        );
      });

      it("throws when the message belongs to a different adapter (multi-account guard)", async () => {
        const otherAdapter = makeAdapter({ adapterName: "baileys-other" });
        await otherAdapter.initialize(mockChat);
        // parseMessage on the other adapter stamps its own prefix onto threadId
        const otherMessage = otherAdapter.parseMessage(makeDMMessage());
        await expect(adapter.reply(otherMessage, "hi")).rejects.toThrow(/baileys-other/);
      });

      it("returns a RawMessage with the sent message id", async () => {
        const raw = makeDMMessage();
        const message = adapter.parseMessage(raw);
        const result = await adapter.reply(message, "ack");
        expect(result.id).toBe("sent-msg-id");
        expect(result.threadId).toBe(adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" }));
      });
    });

    // ── markRead (extension) ──────────────────────────────────────────────────

    describe("markRead (WhatsApp extension)", () => {
      it("calls socket.readMessages with WAMessageKey objects", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.markRead(threadId, ["msg-1", "msg-2"]);
        expect(mockSocket.readMessages).toHaveBeenCalledWith([
          { remoteJid: "15551234567@s.whatsapp.net", id: "msg-1", fromMe: false },
          { remoteJid: "15551234567@s.whatsapp.net", id: "msg-2", fromMe: false },
        ]);
      });

      it("handles an empty messageIds array without error", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.markRead(threadId, []);
        expect(mockSocket.readMessages).toHaveBeenCalledWith([]);
      });
    });

    // ── setPresence (extension) ───────────────────────────────────────────────

    describe("setPresence (WhatsApp extension)", () => {
      it("calls sendPresenceUpdate with 'available'", async () => {
        await adapter.setPresence("available");
        expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith("available");
      });

      it("calls sendPresenceUpdate with 'unavailable'", async () => {
        await adapter.setPresence("unavailable");
        expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith("unavailable");
      });
    });

    // ── sendLocation (extension) ──────────────────────────────────────────────

    describe("sendLocation (WhatsApp extension)", () => {
      it("sends a location payload with coordinates", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.sendLocation(threadId, 37.7749, -122.4194);
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          {
            location: {
              degreesLatitude: 37.7749,
              degreesLongitude: -122.4194,
              name: undefined,
              address: undefined,
            },
          }
        );
      });

      it("includes name and address when provided", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.sendLocation(threadId, 37.7749, -122.4194, {
          name: "SF HQ",
          address: "San Francisco, CA",
        });
        const [, payload] = mockSocket.sendMessage.mock.calls[0] as [
          string,
          { location: { name?: string; address?: string } },
        ];
        expect(payload.location.name).toBe("SF HQ");
        expect(payload.location.address).toBe("San Francisco, CA");
      });
    });

    // ── sendPoll (extension) ──────────────────────────────────────────────────

    describe("sendPoll (WhatsApp extension)", () => {
      it("sends a poll payload with question and options", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.sendPoll(threadId, "Best time?", ["10am", "2pm", "5pm"]);
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { poll: { name: "Best time?", values: ["10am", "2pm", "5pm"], selectableCount: 1 } }
        );
      });

      it("respects a custom selectableCount", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.sendPoll(threadId, "Pick two", ["A", "B", "C"], 2);
        const [, payload] = mockSocket.sendMessage.mock.calls[0] as [
          string,
          { poll: { selectableCount: number } },
        ];
        expect(payload.poll.selectableCount).toBe(2);
      });
    });

    // ── fetchGroupParticipants (extension) ────────────────────────────────────

    describe("fetchGroupParticipants (WhatsApp extension)", () => {
      it("returns participants with admin flags from groupMetadata", async () => {
        const threadId = adapter.encodeThreadId({ jid: "123456789@g.us" });
        mockSocket.groupMetadata.mockResolvedValue({
          subject: "Test Group",
          participants: [
            { id: "a@s.whatsapp.net", admin: "superadmin" },
            { id: "b@s.whatsapp.net", admin: "admin" },
            { id: "c@s.whatsapp.net", admin: null },
          ],
        });
        const result = await adapter.fetchGroupParticipants(threadId);
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ userId: "a@s.whatsapp.net", isAdmin: true, isSuperAdmin: true });
        expect(result[1]).toEqual({ userId: "b@s.whatsapp.net", isAdmin: true, isSuperAdmin: false });
        expect(result[2]).toEqual({ userId: "c@s.whatsapp.net", isAdmin: false, isSuperAdmin: false });
      });

      it("throws a ValidationError when the thread is not a group", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await expect(adapter.fetchGroupParticipants(threadId)).rejects.toThrow(
          /not a group/
        );
      });
    });

    // ── credential update event ───────────────────────────────────────────────

    describe("creds.update event", () => {
      it("calls saveCreds when credentials are updated", async () => {
        await capturedEvHandler!({ "creds.update": true });
        expect(mockAuthState.saveCreds).toHaveBeenCalled();
      });
    });

    // ── connection.update events ──────────────────────────────────────────────

    describe("connection.update event", () => {
      it("logs when the connection opens", async () => {
        await capturedEvHandler!({ "connection.update": { connection: "open" } });
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Connected"));
      });

      it("does not reconnect on loggedOut disconnect (code 401)", async () => {
        const callsBefore = mockMakeWASocket.mock.calls.length;
        await capturedEvHandler!({
          "connection.update": {
            connection: "close",
            lastDisconnect: { error: { output: { statusCode: 401 } } },
          },
        });
        expect(mockMakeWASocket.mock.calls.length).toBe(callsBefore);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Logged out"));
      });

      it("reconnects on restartRequired (code 515)", async () => {
        const callsBefore = mockMakeWASocket.mock.calls.length;
        await capturedEvHandler!({
          "connection.update": {
            connection: "close",
            lastDisconnect: { error: { output: { statusCode: 515 } } },
          },
        });
        expect(mockMakeWASocket.mock.calls.length).toBeGreaterThan(callsBefore);
      });

      it("does not reconnect after an explicit disconnect()", async () => {
        const callsBeforeDisconnect = mockMakeWASocket.mock.calls.length;
        await adapter.disconnect();

        await capturedEvHandler!({
          "connection.update": {
            connection: "close",
            lastDisconnect: { error: { output: { statusCode: 500 } } },
          },
        });

        expect(mockMakeWASocket.mock.calls.length).toBe(callsBeforeDisconnect);
      });
    });

    // ── messages.upsert event ─────────────────────────────────────────────────

    describe("messages.upsert event", () => {
      it("calls chat.processMessage for each notify message", async () => {
        await capturedEvHandler!({
          "messages.upsert": { messages: [makeDMMessage()], type: "notify" },
        });
        expect(mockChat.processMessage).toHaveBeenCalledWith(
          adapter,
          adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" }),
          expect.any(Function)
        );
      });

      it("skips non-notify events (type: 'append')", async () => {
        await capturedEvHandler!({
          "messages.upsert": { messages: [makeDMMessage()], type: "append" },
        });
        expect(mockChat.processMessage).not.toHaveBeenCalled();
      });

      it("skips messages with no message content", async () => {
        const empty = { key: { remoteJid: "123@s.whatsapp.net", id: "x" }, message: null };
        await capturedEvHandler!({
          "messages.upsert": { messages: [empty], type: "notify" },
        });
        expect(mockChat.processMessage).not.toHaveBeenCalled();
      });

      it("skips newsletter JIDs", async () => {
        const newsletterMsg = makeDMMessage({
          key: { remoteJid: "123456789@newsletter", id: "n1", fromMe: false },
        });
        await capturedEvHandler!({
          "messages.upsert": { messages: [newsletterMsg], type: "notify" },
        });
        expect(mockChat.processMessage).not.toHaveBeenCalled();
      });

      it("the factory passed to processMessage resolves to a parsed Message", async () => {
        await capturedEvHandler!({
          "messages.upsert": { messages: [makeDMMessage()], type: "notify" },
        });
        const [, , factory] = mockChat.processMessage.mock.calls[0] as [
          unknown,
          unknown,
          () => Promise<unknown>,
        ];
        const msg = await factory();
        expect((msg as { text: string }).text).toBe("Hello, world!");
      });
    });
  });

  // ── without socket ────────────────────────────────────────────────────────

  describe("without a connected socket", () => {
    it("postMessage throws a validation error", async () => {
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await expect(adapter.postMessage(threadId, { raw: "hi" })).rejects.toThrow();
    });

    it("startTyping is a no-op when socket is not connected", async () => {
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await adapter.startTyping(threadId);
      expect(mockSocket.sendPresenceUpdate).not.toHaveBeenCalled();
    });

    it("reply throws a validation error", async () => {
      const message = adapter.parseMessage(makeDMMessage());
      await expect(adapter.reply(message, "hi")).rejects.toThrow();
    });

    it("markRead throws a validation error", async () => {
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await expect(adapter.markRead(threadId, ["msg-1"])).rejects.toThrow();
    });

    it("setPresence throws a validation error", async () => {
      await expect(adapter.setPresence("available")).rejects.toThrow();
    });

    it("sendLocation throws a validation error", async () => {
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await expect(adapter.sendLocation(threadId, 0, 0)).rejects.toThrow();
    });

    it("sendPoll throws a validation error", async () => {
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await expect(adapter.sendPoll(threadId, "Q?", ["A", "B"])).rejects.toThrow();
    });

    it("fetchGroupParticipants throws a validation error", async () => {
      const threadId = adapter.encodeThreadId({ jid: "123456789@g.us" });
      await expect(adapter.fetchGroupParticipants(threadId)).rejects.toThrow();
    });
  });

  describe("QR and pairing callbacks", () => {
    it("emits QR and pairing code once while connecting", async () => {
      const onQR = vi.fn();
      const onPairingCode = vi.fn();
      adapter = makeAdapter({
        onQR,
        phoneNumber: "15551234567",
        onPairingCode,
      });
      await adapter.initialize(mockChat);
      await adapter.connect();

      await capturedEvHandler!({
        "connection.update": { connection: "connecting", qr: "qr-value-1" },
      });
      await capturedEvHandler!({
        "connection.update": { connection: "connecting", qr: "qr-value-2" },
      });

      expect(onQR).toHaveBeenCalledTimes(2);
      expect(onPairingCode).toHaveBeenCalledTimes(1);
      expect(mockSocket.requestPairingCode).toHaveBeenCalledWith("15551234567");
    });
  });
});
