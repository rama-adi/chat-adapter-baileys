import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInstance } from "chat";
import type { WAMessage } from "baileys";
import { BaileysAdapter } from "./adapter.js";
import { createBaileysExtensions } from "./extensions-router.js";
import type { BaileysAdapterConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockSocketA, mockSocketB, mockMakeWASocket } = vi.hoisted(() => {
  const makeSocket = () => ({
    ev: { process: vi.fn() },
    user: { id: "bot@s.whatsapp.net" },
    sendMessage: vi.fn().mockResolvedValue({
      key: { id: "sent-id", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
      message: { conversation: "sent" },
    }),
    groupMetadata: vi.fn(),
    sendPresenceUpdate: vi.fn(),
    readMessages: vi.fn(),
    end: vi.fn(),
    requestPairingCode: vi.fn(),
  });

  const socketA = makeSocket();
  const socketB = makeSocket();
  let callCount = 0;
  const mockMake = vi.fn(() => (callCount++ % 2 === 0 ? socketA : socketB));
  return { mockSocketA: socketA, mockSocketB: socketB, mockMakeWASocket: mockMake };
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
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("mock")),
  generateMessageIDV2: vi.fn(() => "generated-id"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const mockChat = {
  getLogger: vi.fn(() => mockLogger),
  processMessage: vi.fn(),
  getState: vi.fn(),
  getUserName: vi.fn(() => "bot"),
  processAction: vi.fn(),
  processAppHomeOpened: vi.fn(),
  processAssistantContextChanged: vi.fn(),
  processAssistantThreadStarted: vi.fn(),
  processReaction: vi.fn(),
  processSlashCommand: vi.fn(),
  processModalClose: vi.fn(),
  processModalSubmit: vi.fn(),
} satisfies Partial<ChatInstance> as unknown as ChatInstance;

const mockAuth: BaileysAdapterConfig["auth"] = {
  state: { creds: {} as never, keys: {} as never },
  saveCreds: vi.fn(),
};

function makeDMMessage(jid: string, id = "msg-1"): WAMessage {
  return {
    key: { remoteJid: jid, id, fromMe: false },
    message: { conversation: "hello" },
    pushName: "User",
    messageTimestamp: 1700000000,
  } as WAMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBaileysExtensions", () => {
  let adapterA: BaileysAdapter;
  let adapterB: BaileysAdapter;
  let wa: ReturnType<typeof createBaileysExtensions>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockSocketA.ev.process.mockImplementation(vi.fn());
    mockSocketB.ev.process.mockImplementation(vi.fn());
    mockSocketA.sendMessage.mockResolvedValue({
      key: { id: "sent-id", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
      message: { conversation: "sent" },
    });
    mockSocketB.sendMessage.mockResolvedValue({
      key: { id: "sent-id", remoteJid: "15559876543@s.whatsapp.net", fromMe: true },
      message: { conversation: "sent" },
    });

    adapterA = new BaileysAdapter({ auth: mockAuth, adapterName: "baileys-a" });
    adapterB = new BaileysAdapter({ auth: mockAuth, adapterName: "baileys-b" });
    await adapterA.initialize(mockChat);
    await adapterB.initialize(mockChat);
    await adapterA.connect();
    await adapterB.connect();

    wa = createBaileysExtensions(adapterA, adapterB);
  });

  // ── reply ─────────────────────────────────────────────────────────────────

  describe("reply", () => {
    it("routes to adapterA for a message from account A", async () => {
      const raw = makeDMMessage("15551234567@s.whatsapp.net");
      const message = adapterA.parseMessage(raw);
      await wa.reply(message, "hi");
      expect(mockSocketA.sendMessage).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        { text: "hi" },
        { quoted: raw }
      );
      expect(mockSocketB.sendMessage).not.toHaveBeenCalled();
    });

    it("routes to adapterB for a message from account B", async () => {
      const raw = makeDMMessage("15559876543@s.whatsapp.net");
      const message = adapterB.parseMessage(raw);
      await wa.reply(message, "hi");
      expect(mockSocketB.sendMessage).toHaveBeenCalled();
      expect(mockSocketA.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ── markRead ──────────────────────────────────────────────────────────────

  describe("markRead", () => {
    it("routes to adapterA for a thread from account A", async () => {
      const threadId = adapterA.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await wa.markRead(threadId, ["msg-1"]);
      expect(mockSocketA.readMessages).toHaveBeenCalled();
      expect(mockSocketB.readMessages).not.toHaveBeenCalled();
    });

    it("routes to adapterB for a thread from account B", async () => {
      const threadId = adapterB.encodeThreadId({ jid: "15559876543@s.whatsapp.net" });
      await wa.markRead(threadId, ["msg-1"]);
      expect(mockSocketB.readMessages).toHaveBeenCalled();
      expect(mockSocketA.readMessages).not.toHaveBeenCalled();
    });
  });

  // ── setPresence ───────────────────────────────────────────────────────────

  describe("setPresence", () => {
    it("broadcasts to all adapters", async () => {
      await wa.setPresence("available");
      expect(mockSocketA.sendPresenceUpdate).toHaveBeenCalledWith("available");
      expect(mockSocketB.sendPresenceUpdate).toHaveBeenCalledWith("available");
    });
  });

  // ── sendLocation ──────────────────────────────────────────────────────────

  describe("sendLocation", () => {
    it("routes to the correct adapter", async () => {
      const threadId = adapterB.encodeThreadId({ jid: "15559876543@s.whatsapp.net" });
      await wa.sendLocation(threadId, 51.5, -0.1);
      expect(mockSocketB.sendMessage).toHaveBeenCalledWith(
        "15559876543@s.whatsapp.net",
        expect.objectContaining({ location: expect.anything() })
      );
      expect(mockSocketA.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ── sendPoll ──────────────────────────────────────────────────────────────

  describe("sendPoll", () => {
    it("routes to the correct adapter", async () => {
      const threadId = adapterA.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await wa.sendPoll(threadId, "Vote?", ["Yes", "No"]);
      expect(mockSocketA.sendMessage).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        expect.objectContaining({ poll: expect.anything() })
      );
      expect(mockSocketB.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ── fetchGroupParticipants ────────────────────────────────────────────────

  describe("fetchGroupParticipants", () => {
    it("routes to the correct adapter", async () => {
      const threadId = adapterB.encodeThreadId({ jid: "123456789@g.us" });
      mockSocketB.groupMetadata.mockResolvedValue({
        subject: "Group",
        participants: [{ id: "a@s.whatsapp.net", admin: null }],
      });
      const result = await wa.fetchGroupParticipants(threadId);
      expect(result).toHaveLength(1);
      expect(mockSocketB.groupMetadata).toHaveBeenCalled();
      expect(mockSocketA.groupMetadata).not.toHaveBeenCalled();
    });
  });

  // ── unknown adapter ───────────────────────────────────────────────────────

  describe("unknown adapter prefix", () => {
    it("throws a descriptive error when no adapter is registered for the prefix", async () => {
      const unknownThreadId = "baileys-unknown:c29tZWppZA";
      await expect(wa.markRead(unknownThreadId, [])).rejects.toThrow(/baileys-unknown/);
    });
  });
});
