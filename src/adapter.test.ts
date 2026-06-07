import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
  jidNormalizedUser: (jid: string | undefined) =>
    (jid ?? "").split(":")[0].split("/")[0] || "",
  getKeyAuthor: (
    key: { fromMe?: boolean; participant?: string; remoteJid?: string } | undefined,
    meId?: string
  ) => {
    if (!key) return "";
    if (key.fromMe) return (meId ?? "").split(":")[0].split("/")[0] || "";
    if (key.participant) return key.participant.split(":")[0].split("/")[0];
    return (key.remoteJid ?? "").split(":")[0].split("/")[0];
  },
  // Test contract: encPayload is the utf8 bytes of the chosen option name(s),
  // joined by "|" for multi-select. Returns the SHA256 of each option as the
  // "selectedOptions" array — matching what the real WhatsApp protocol does.
  decryptPollVote: vi.fn(({ encPayload }: { encPayload: Uint8Array }) => {
    const decoded = Buffer.from(encPayload).toString("utf8");
    if (decoded.length === 0) return { selectedOptions: [] };
    const names = decoded.split("|");
    return {
      selectedOptions: names.map((n) => createHash("sha256").update(n).digest()),
    };
  }),
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

const stateStore = new Map<string, unknown>();
const stateLists = new Map<string, unknown[]>();
const mockState = {
  get: vi.fn(async <T>(key: string) => (stateStore.get(key) as T) ?? null),
  set: vi.fn(async (key: string, value: unknown) => {
    stateStore.set(key, value);
  }),
  delete: vi.fn(async (key: string) => {
    stateStore.delete(key);
  }),
  appendToList: vi.fn(
    async (
      key: string,
      value: unknown,
      options?: { maxLength?: number; ttlMs?: number }
    ) => {
      const list = stateLists.get(key) ?? [];
      list.push(value);
      if (options?.maxLength && list.length > options.maxLength) {
        list.splice(0, list.length - options.maxLength);
      }
      stateLists.set(key, list);
    }
  ),
  getList: vi.fn(async <T>(key: string) => (stateLists.get(key) as T[]) ?? []),
};

const mockChat = {
  getLogger: vi.fn(() => mockLogger),
  processMessage: vi.fn(),
  getState: vi.fn(() => mockState),
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

const generatedMessageOptions = expect.objectContaining({
  messageId: "generated-id",
});

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

function makeReactionMessage(overrides?: Partial<WAMessage>): WAMessage {
  return {
    key: {
      remoteJid: "123456789@g.us",
      id: "reaction-msg-1",
      fromMe: false,
      participant: "15559876543@s.whatsapp.net",
    },
    message: {
      reactionMessage: {
        key: {
          remoteJid: "123456789@g.us",
          id: "target-msg-1",
          fromMe: false,
          participant: "15550001111@s.whatsapp.net",
        },
        text: "👍",
      },
    },
    pushName: "Alice",
    messageTimestamp: 1700000002,
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
    stateStore.clear();
    stateLists.clear();
    capturedEvHandler = null;

    mockSocket.ev.process.mockImplementation((handler: EvHandler) => {
      capturedEvHandler = handler;
    });
    mockSocket.user.id = "15551234567@s.whatsapp.net";
    mockSocket.sendMessage.mockImplementation(
      async (
        jid: string,
        _content: unknown,
        options?: { messageId?: string }
      ) => ({
        key: {
          id: options?.messageId ?? "sent-msg-id",
          remoteJid: jid,
          fromMe: true,
        },
        message: { conversation: "sent" },
      })
    );
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
      expect(msg.metadata.fromMe).toBe(false);
      expect(adapter.decodeThreadId(msg.threadId).jid).toBe("15551234567@s.whatsapp.net");
    });

    it("uses participant JID as sender for group messages", () => {
      const msg = adapter.parseMessage(makeGroupMessage());
      expect(msg.author.userId).toBe("15559876543@s.whatsapp.net");
    });

    it("does not treat paired-phone messages as bot-authored", async () => {
      await adapter.connect();
      mockSocket.user.id = "15550000000@s.whatsapp.net";
      const raw = makeDMMessage({
        key: { remoteJid: "15559876543@s.whatsapp.net", id: "m1", fromMe: true },
      });
      const msg = adapter.parseMessage(raw);
      expect(msg.author.isMe).toBe(false);
      expect(msg.author.isBot).toBe(false);
      expect(msg.author.userId).toBe("15550000000@s.whatsapp.net");
      expect(adapter.decodeThreadId(msg.threadId).jid).toBe("15559876543@s.whatsapp.net");
      expect(msg.metadata.fromMe).toBe(true);
    });

    it("marks messages sent by the adapter as bot-authored when echoed by Baileys", async () => {
      await adapter.connect();
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await adapter.postMessage(threadId, { raw: "Hello from bot" });

      const echoed = makeDMMessage({
        key: { remoteJid: "15551234567@s.whatsapp.net", id: "generated-id", fromMe: true },
        pushName: "Me",
      });
      const msg = adapter.parseMessage(echoed);
      expect(msg.author.isMe).toBe(true);
      expect(msg.author.isBot).toBe(true);
      expect(msg.metadata.fromMe).toBe(true);
    });

    it("does not mark cached IDs as adapter-authored unless Baileys also marks fromMe", async () => {
      await adapter.connect();
      const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
      await adapter.postMessage(threadId, { raw: "Hello from bot" });

      const inbound = makeDMMessage({
        key: { remoteJid: "15551234567@s.whatsapp.net", id: "generated-id", fromMe: false },
      });
      const msg = adapter.parseMessage(inbound);
      expect(msg.author.isMe).toBe(false);
      expect(msg.author.isBot).toBe(false);
      expect(msg.metadata.fromMe).toBe(false);
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
          { text: "Hello" },
          generatedMessageOptions
        );
        expect(result.id).toBe("generated-id");
      });

      it("converts Markdown bold (**text**) to WhatsApp bold (*text*)", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.postMessage(threadId, { markdown: "**bold**" });
        const [, payload] = mockSocket.sendMessage.mock.calls[0] as [string, { text: string }];
        expect(payload.text).toContain("*bold*");
        expect(payload.text).not.toMatch(/\*\*bold\*\*/);
      });

      it("sends markdown text as a rendered caption alongside a file", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        const data = Buffer.from("img");
        await adapter.postMessage(threadId, {
          markdown: "**Bold** caption",
          files: [{ data, filename: "pic.png", mimeType: "image/png" }],
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
        const [, payload] = mockSocket.sendMessage.mock.calls[0] as [
          string,
          { image: Buffer; mimetype: string; caption: string }
        ];
        expect(payload.image).toBe(data);
        expect(payload.mimetype).toBe("image/png");
        // WhatsApp bold is *single-star*, not **double-star**
        expect(payload.caption).toContain("*Bold*");
        expect(payload.caption).not.toMatch(/\*\*Bold\*\*/);
      });

      it("sends an image file with the text as caption", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        const data = Buffer.from("fake-png");
        await adapter.postMessage(threadId, {
          raw: "Look at this",
          files: [{ data, filename: "pic.png", mimeType: "image/png" }],
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { image: data, mimetype: "image/png", caption: "Look at this" },
          generatedMessageOptions
        );
      });

      it("sends non-media files as documents with fileName", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        const data = Buffer.from("%PDF-");
        await adapter.postMessage(threadId, {
          raw: "Report attached",
          files: [{ data, filename: "report.pdf", mimeType: "application/pdf" }],
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          {
            document: data,
            mimetype: "application/pdf",
            fileName: "report.pdf",
            caption: "Report attached",
          },
          generatedMessageOptions
        );
      });

      it("sends text as a separate message when only audio attachments are present", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        const data = Buffer.from("ogg-bytes");
        await adapter.postMessage(threadId, {
          raw: "Voice note",
          files: [{ data, filename: "v.ogg", mimeType: "audio/ogg" }],
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledTimes(2);
        expect(mockSocket.sendMessage).toHaveBeenNthCalledWith(
          1,
          "15551234567@s.whatsapp.net",
          { text: "Voice note" },
          generatedMessageOptions
        );
        expect(mockSocket.sendMessage).toHaveBeenNthCalledWith(
          2,
          "15551234567@s.whatsapp.net",
          { audio: data, mimetype: "audio/ogg" },
          generatedMessageOptions
        );
      });

      it("sends multiple media items, attaching caption to the first caption-compatible item", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        const img = Buffer.from("img");
        const pdf = Buffer.from("pdf");
        await adapter.postMessage(threadId, {
          raw: "Two files",
          files: [
            { data: img, filename: "a.png", mimeType: "image/png" },
            { data: pdf, filename: "b.pdf", mimeType: "application/pdf" },
          ],
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledTimes(2);
        expect(mockSocket.sendMessage).toHaveBeenNthCalledWith(
          1,
          "15551234567@s.whatsapp.net",
          { image: img, mimetype: "image/png", caption: "Two files" },
          generatedMessageOptions
        );
        expect(mockSocket.sendMessage).toHaveBeenNthCalledWith(
          2,
          "15551234567@s.whatsapp.net",
          { document: pdf, mimetype: "application/pdf", fileName: "b.pdf" },
          generatedMessageOptions
        );
      });

      it("forwards an Attachment with fetchData (inbound re-send)", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        const fetched = Buffer.from("downloaded");
        const fetchData = vi.fn().mockResolvedValue(fetched);
        await adapter.postMessage(threadId, {
          raw: "",
          attachments: [
            { type: "image", mimeType: "image/jpeg", name: "x", fetchData },
          ],
        });
        expect(fetchData).toHaveBeenCalledTimes(1);
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { image: fetched, mimetype: "image/jpeg" },
          generatedMessageOptions
        );
      });

      it("sends an Attachment via URL when no binary data is available", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.postMessage(threadId, {
          raw: "hi",
          attachments: [
            {
              type: "video",
              mimeType: "video/mp4",
              name: "clip",
              url: "https://example.com/clip.mp4",
            },
          ],
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          {
            video: { url: "https://example.com/clip.mp4" },
            mimetype: "video/mp4",
            caption: "hi",
          },
          generatedMessageOptions
        );
      });

      it("throws when an attachment has no data, fetchData, or url", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await expect(
          adapter.postMessage(threadId, {
            raw: "oops",
            attachments: [{ type: "image", mimeType: "image/png", name: "x" }],
          })
        ).rejects.toThrow(/attachment has no data/);
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
          },
          generatedMessageOptions
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
          { delete: { remoteJid: "15551234567@s.whatsapp.net", id: "msg-to-delete", fromMe: true } },
          generatedMessageOptions
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
          },
          generatedMessageOptions
        );
      });

      it("includes participant when reacting to a group message", async () => {
        const threadId = adapter.encodeThreadId({ jid: "123456789@g.us" });
        await adapter.addReaction(
          threadId,
          "msg-id",
          "👍",
          "15559876543@s.whatsapp.net"
        );
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "123456789@g.us",
          {
            react: {
              text: "👍",
              key: {
                remoteJid: "123456789@g.us",
                id: "msg-id",
                fromMe: false,
                participant: "15559876543@s.whatsapp.net",
              },
            },
          },
          generatedMessageOptions
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
          },
          generatedMessageOptions
        );
      });

      it("includes participant when removing a group reaction", async () => {
        const threadId = adapter.encodeThreadId({ jid: "123456789@g.us" });
        await adapter.removeReaction(
          threadId,
          "msg-id",
          "👍",
          "15559876543@s.whatsapp.net"
        );
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "123456789@g.us",
          {
            react: {
              text: "",
              key: {
                remoteJid: "123456789@g.us",
                id: "msg-id",
                fromMe: false,
                participant: "15559876543@s.whatsapp.net",
              },
            },
          },
          generatedMessageOptions
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
          { text: "Channel msg" },
          generatedMessageOptions
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
      it("marks the incoming message as read before sending the quoted reply", async () => {
        const raw = makeDMMessage();
        const message = adapter.parseMessage(raw);
        await adapter.reply(message, "Got it!");

        expect(mockSocket.readMessages).toHaveBeenCalledWith([
          {
            remoteJid: "15551234567@s.whatsapp.net",
            id: "msg-dm-1",
            fromMe: false,
            participant: undefined,
          },
        ]);
        expect(mockSocket.readMessages.mock.invocationCallOrder[0]).toBeLessThan(
          mockSocket.sendMessage.mock.invocationCallOrder[0]
        );
      });

      it("includes the participant when reading a group message before replying", async () => {
        const raw = makeGroupMessage();
        const message = adapter.parseMessage(raw);
        await adapter.reply(message, "Got it!");

        expect(mockSocket.readMessages).toHaveBeenCalledWith([
          {
            remoteJid: "123456789@g.us",
            id: "msg-group-1",
            fromMe: false,
            participant: "15559876543@s.whatsapp.net",
          },
        ]);
      });

      it("does not send a read receipt for fromMe messages", async () => {
        const raw = makeDMMessage({
          key: {
            remoteJid: "15551234567@s.whatsapp.net",
            id: "msg-dm-1",
            fromMe: true,
          },
        });
        const message = adapter.parseMessage(raw);
        await adapter.reply(message, "Got it!");

        expect(mockSocket.readMessages).not.toHaveBeenCalled();
      });

      it("sends sendMessage with the quoted raw message", async () => {
        const raw = makeDMMessage();
        const message = adapter.parseMessage(raw);
        await adapter.reply(message, "Got it!");
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { text: "Got it!" },
          { quoted: raw, messageId: "generated-id" }
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
        expect(result.id).toBe("generated-id");
        expect(result.threadId).toBe(adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" }));
      });

      it("throws when the parsed threadId and raw JID do not match", async () => {
        const raw = makeDMMessage();
        const message = adapter.parseMessage(raw);
        message.threadId = adapter.encodeThreadId({ jid: "123456789@g.us" });

        await expect(adapter.reply(message, "ack")).rejects.toThrow(/threadId does not match/);
      });

      it("sends a quoted reply with an image + caption when given attachments", async () => {
        const raw = makeDMMessage();
        const message = adapter.parseMessage(raw);
        const data = Buffer.from("png-bytes");
        await adapter.reply(message, {
          raw: "Here it is",
          files: [{ data, filename: "pic.png", mimeType: "image/png" }],
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledTimes(1);
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { image: data, mimetype: "image/png", caption: "Here it is" },
          { quoted: raw, messageId: "generated-id" }
        );
      });

      it("quotes only the first message when replying with multiple attachments", async () => {
        const raw = makeDMMessage();
        const message = adapter.parseMessage(raw);
        const a = Buffer.from("a");
        const b = Buffer.from("b");
        await adapter.reply(message, {
          raw: "two",
          files: [
            { data: a, filename: "a.png", mimeType: "image/png" },
            { data: b, filename: "b.pdf", mimeType: "application/pdf" },
          ],
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledTimes(2);
        expect(mockSocket.sendMessage).toHaveBeenNthCalledWith(
          1,
          "15551234567@s.whatsapp.net",
          { image: a, mimetype: "image/png", caption: "two" },
          { quoted: raw, messageId: "generated-id" }
        );
        // Second send has no `quoted` third arg
        expect(mockSocket.sendMessage).toHaveBeenNthCalledWith(
          2,
          "15551234567@s.whatsapp.net",
          { document: b, mimetype: "application/pdf", fileName: "b.pdf" },
          generatedMessageOptions
        );
      });
    });

    // ── markRead (extension) ──────────────────────────────────────────────────

    describe("markRead (WhatsApp extension)", () => {
      it("calls socket.readMessages with WAMessageKey objects", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.markRead(threadId, ["msg-1", "msg-2"]);
        expect(mockSocket.readMessages).toHaveBeenCalledWith([
          { remoteJid: "15551234567@s.whatsapp.net", id: "msg-1", fromMe: false, participant: undefined },
          { remoteJid: "15551234567@s.whatsapp.net", id: "msg-2", fromMe: false, participant: undefined },
        ]);
      });

      it("includes participant when provided for group read receipts", async () => {
        const threadId = adapter.encodeThreadId({ jid: "123456789@g.us" });
        await adapter.markRead(
          threadId,
          ["msg-1"],
          "107082225311887@lid"
        );
        expect(mockSocket.readMessages).toHaveBeenCalledWith([
          {
            remoteJid: "123456789@g.us",
            id: "msg-1",
            fromMe: false,
            participant: "107082225311887@lid",
          },
        ]);
      });

      it("accepts named arguments", async () => {
        const threadId = adapter.encodeThreadId({ jid: "123456789@g.us" });
        await adapter.markRead({
          threadId,
          messageIds: ["msg-1"],
          participant: "107082225311887@lid",
        });
        expect(mockSocket.readMessages).toHaveBeenCalledWith([
          {
            remoteJid: "123456789@g.us",
            id: "msg-1",
            fromMe: false,
            participant: "107082225311887@lid",
          },
        ]);
      });

      it("handles an empty messageIds array without error", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.markRead(threadId, []);
        expect(mockSocket.readMessages).not.toHaveBeenCalled();
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
          },
          generatedMessageOptions
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

      it("accepts named arguments", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.sendLocation({
          threadId,
          latitude: 37.7749,
          longitude: -122.4194,
          name: "SF HQ",
          address: "San Francisco, CA",
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          {
            location: {
              degreesLatitude: 37.7749,
              degreesLongitude: -122.4194,
              name: "SF HQ",
              address: "San Francisco, CA",
            },
          },
          generatedMessageOptions
        );
      });

      it("rejects invalid latitude values", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await expect(adapter.sendLocation(threadId, 91, 0)).rejects.toThrow(/latitude/);
      });

      it("rejects invalid longitude values", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await expect(adapter.sendLocation(threadId, 0, 181)).rejects.toThrow(/longitude/);
      });
    });

    // ── sendPoll (extension) ──────────────────────────────────────────────────

    describe("sendPoll (WhatsApp extension)", () => {
      it("sends a poll payload with question and options", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.sendPoll(threadId, "Best time?", ["10am", "2pm", "5pm"]);
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { poll: { name: "Best time?", values: ["10am", "2pm", "5pm"], selectableCount: 1 } },
          generatedMessageOptions
        );
      });

      it("accepts named arguments", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: "poll-named-args", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
          message: { messageContextInfo: { messageSecret: Buffer.alloc(32, 5) } },
        });
        await adapter.sendPoll({
          threadId,
          question: "Best time?",
          options: ["10am", "2pm", "5pm"],
          selectableCount: 2,
          metadata: { askedBy: "user-42" },
        });
        expect(mockSocket.sendMessage).toHaveBeenCalledWith(
          "15551234567@s.whatsapp.net",
          { poll: { name: "Best time?", values: ["10am", "2pm", "5pm"], selectableCount: 2 } },
          generatedMessageOptions
        );
        expect(mockState.set).toHaveBeenCalledWith(
          "baileys:baileys:poll:poll-named-args",
          expect.objectContaining({
            metadata: { askedBy: "user-42" },
          }),
          expect.anything()
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

      it("rejects polls with fewer than 2 options", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await expect(adapter.sendPoll(threadId, "Q?", ["A"])).rejects.toThrow(/between 2 and 12 options/);
      });

      it("rejects empty poll options", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await expect(adapter.sendPoll(threadId, "Q?", ["A", " "])).rejects.toThrow(/must not be empty/);
      });

      it("rejects negative selectableCount values", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await expect(adapter.sendPoll(threadId, "Q?", ["A", "B"], -1)).rejects.toThrow(/selectableCount/);
      });

      it("persists poll metadata in the SDK state adapter on send", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        const secret = Buffer.alloc(32, 7);
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: "poll-1", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
          message: {
            pollCreationMessageV3: {},
            messageContextInfo: { messageSecret: secret },
          },
        });

        await adapter.sendPoll(threadId, "Time?", ["10am", "2pm"]);

        expect(mockState.set).toHaveBeenCalledWith(
          "baileys:baileys:poll:poll-1",
          expect.objectContaining({
            question: "Time?",
            options: ["10am", "2pm"],
            messageSecret: secret.toString("base64"),
          }),
          30 * 24 * 60 * 60 * 1000
        );
      });

      it("warns and skips storage when the sent poll has no messageSecret", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: "poll-no-secret", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
          message: { pollCreationMessageV3: {} },
        });

        await adapter.sendPoll(threadId, "Q?", ["A", "B"]);

        expect(mockState.set).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("messageSecret")
        );
      });

      it("uses the configured pollTtlMs when provided", async () => {
        adapter = makeAdapter({ pollTtlMs: 5000 });
        await adapter.initialize(mockChat);
        await adapter.connect();
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: "poll-ttl", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
          message: { messageContextInfo: { messageSecret: Buffer.alloc(32, 1) } },
        });

        await adapter.sendPoll(threadId, "Q?", ["A", "B"]);

        expect(mockState.set).toHaveBeenCalledWith(
          expect.stringContaining("poll-ttl"),
          expect.any(Object),
          5000
        );
      });

      it("treats pollTtlMs=0 as no TTL", async () => {
        adapter = makeAdapter({ pollTtlMs: 0 });
        await adapter.initialize(mockChat);
        await adapter.connect();
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: "poll-no-ttl", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
          message: { messageContextInfo: { messageSecret: Buffer.alloc(32, 2) } },
        });

        await adapter.sendPoll(threadId, "Q?", ["A", "B"]);

        expect(mockState.set).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Object),
          undefined
        );
      });

      it("persists caller-supplied metadata alongside the poll entry", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: "poll-meta", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
          message: { messageContextInfo: { messageSecret: Buffer.alloc(32, 3) } },
        });

        await adapter.sendPoll(threadId, "Q?", ["A", "B"], 1, {
          metadata: { askedBy: "user-42", quizId: 7 },
        });

        expect(mockState.set).toHaveBeenCalledWith(
          "baileys:baileys:poll:poll-meta",
          expect.objectContaining({
            metadata: { askedBy: "user-42", quizId: 7 },
          }),
          expect.anything()
        );
      });

      it("omits the metadata key entirely when none is provided", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: "poll-nometa", remoteJid: "15551234567@s.whatsapp.net", fromMe: true },
          message: { messageContextInfo: { messageSecret: Buffer.alloc(32, 4) } },
        });

        await adapter.sendPoll(threadId, "Q?", ["A", "B"]);

        const [, stored] = mockState.set.mock.calls.find(
          ([key]) => key === "baileys:baileys:poll:poll-nometa"
        ) as [string, Record<string, unknown>];
        expect(Object.prototype.hasOwnProperty.call(stored, "metadata")).toBe(false);
      });
    });

    // ── poll vote handling (pollUpdateMessage) ────────────────────────────────

    describe("poll vote handling (pollUpdateMessage)", () => {
      async function sendStubbedPoll(opts: {
        jid: string;
        pollId: string;
        question: string;
        options: string[];
        secret?: Buffer;
        metadata?: unknown;
      }) {
        const threadId = adapter.encodeThreadId({ jid: opts.jid });
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: opts.pollId, remoteJid: opts.jid, fromMe: true },
          message: {
            messageContextInfo: { messageSecret: opts.secret ?? Buffer.alloc(32, 9) },
          },
        });
        await adapter.sendPoll(
          threadId,
          opts.question,
          opts.options,
          1,
          opts.metadata !== undefined ? { metadata: opts.metadata } : undefined
        );
        return threadId;
      }

      function makePollVoteMessage(opts: {
        pollId: string;
        chosen: string[];
        remoteJid: string;
        id?: string;
        fromMe?: boolean;
        participant?: string;
        voterPushName?: string;
      }): WAMessage {
        return {
          key: {
            remoteJid: opts.remoteJid,
            id: opts.id ?? `vote-${opts.pollId}`,
            fromMe: opts.fromMe ?? false,
            participant: opts.participant,
          },
          message: {
            pollUpdateMessage: {
              pollCreationMessageKey: {
                remoteJid: opts.remoteJid,
                id: opts.pollId,
                fromMe: true,
              },
              vote: {
                encPayload: Buffer.from(opts.chosen.join("|"), "utf8"),
                encIv: Buffer.alloc(12, 0),
              },
              senderTimestampMs: 1700000003000,
            },
          },
          pushName: opts.voterPushName ?? "Voter",
          messageTimestamp: 1700000003,
        } as WAMessage;
      }

      it("decrypts a DM vote and routes the chosen option as the message text", async () => {
        const jid = "15551234567@s.whatsapp.net";
        const threadId = await sendStubbedPoll({
          jid,
          pollId: "poll-dm",
          question: "Time?",
          options: ["10am", "2pm", "5pm"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-dm",
                chosen: ["2pm"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        expect(mockChat.processMessage).toHaveBeenCalledWith(
          adapter,
          threadId,
          expect.any(Function)
        );
        const [, , factory] = mockChat.processMessage.mock.calls[0] as [
          unknown,
          unknown,
          () => Promise<{ text: string; author: { userId: string } }>,
        ];
        const built = await factory();
        expect(built.text).toBe("2pm");
        expect(built.author.userId).toBe("15551234567@s.whatsapp.net");
      });

      it("does not treat paired-phone poll votes as bot-authored", async () => {
        mockSocket.user.id = "15550000000@s.whatsapp.net";
        const jid = "15559876543@s.whatsapp.net";
        await sendStubbedPoll({
          jid,
          pollId: "poll-owner-vote",
          question: "Time?",
          options: ["10am", "2pm", "5pm"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-owner-vote",
                chosen: ["10am"],
                remoteJid: jid,
                fromMe: true,
                voterPushName: "Owner",
              }),
            ],
            type: "notify",
          },
        });

        const [, , factory] = mockChat.processMessage.mock.calls[0] as [
          unknown,
          unknown,
          () => Promise<{ author: { userId: string; isMe: boolean; isBot: boolean } }>,
        ];
        const built = await factory();
        expect(built.author.userId).toBe("15550000000@s.whatsapp.net");
        expect(built.author.isMe).toBe(false);
        expect(built.author.isBot).toBe(false);
      });

      it("invokes onPollVote handlers with the structured decrypted payload", async () => {
        const handler = vi.fn();
        adapter.onPollVote(handler);

        const jid = "15551234567@s.whatsapp.net";
        const threadId = await sendStubbedPoll({
          jid,
          pollId: "poll-cb",
          question: "Pick",
          options: ["A", "B", "C"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-cb",
                chosen: ["A", "C"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId,
            pollMessageId: "poll-cb",
            question: "Pick",
            options: ["A", "B", "C"],
            selectedOptions: ["A", "C"],
            voter: expect.objectContaining({ userId: jid }),
          })
        );
      });

      it("round-trips sendPoll metadata to onPollVote handlers", async () => {
        const handler = vi.fn();
        adapter.onPollVote(handler);

        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({
          jid,
          pollId: "poll-meta-rt",
          question: "Q?",
          options: ["A", "B"],
          metadata: { askedBy: "user-42" },
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-meta-rt",
                chosen: ["A"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            pollMessageId: "poll-meta-rt",
            metadata: { askedBy: "user-42" },
          })
        );
      });

      it("delivers metadata as undefined when the poll was sent without any", async () => {
        const handler = vi.fn();
        adapter.onPollVote(handler);

        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({
          jid,
          pollId: "poll-nometa-rt",
          question: "Q?",
          options: ["A", "B"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-nometa-rt",
                chosen: ["A"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        const vote = handler.mock.calls[0][0] as { metadata?: unknown };
        expect(vote.metadata).toBeUndefined();
      });

      it("filters handlers registered with a specific pollMessageId", async () => {
        const matchingHandler = vi.fn();
        const otherHandler = vi.fn();
        adapter.onPollVote("poll-match", matchingHandler);
        adapter.onPollVote("poll-other", otherHandler);

        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({
          jid,
          pollId: "poll-match",
          question: "Q?",
          options: ["A", "B"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-match",
                chosen: ["A"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        expect(matchingHandler).toHaveBeenCalledOnce();
        expect(otherHandler).not.toHaveBeenCalled();
      });

      it("filters handlers registered with an array of pollMessageIds", async () => {
        const handler = vi.fn();
        adapter.onPollVote(["poll-a", "poll-b"], handler);

        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({ jid, pollId: "poll-b", question: "Q?", options: ["A", "B"] });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({ pollId: "poll-b", chosen: ["A"], remoteJid: jid }),
            ],
            type: "notify",
          },
        });

        expect(handler).toHaveBeenCalledOnce();
      });

      it("dispatches to multiple handlers in registration order", async () => {
        const order: string[] = [];
        adapter.onPollVote(() => { order.push("first"); });
        adapter.onPollVote(() => { order.push("second"); });

        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({ jid, pollId: "poll-multi", question: "Q?", options: ["A", "B"] });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({ pollId: "poll-multi", chosen: ["A"], remoteJid: jid }),
            ],
            type: "notify",
          },
        });

        expect(order).toEqual(["first", "second"]);
      });

      it("isolates a thrown handler so other handlers still run", async () => {
        const broken = vi.fn(() => {
          throw new Error("oops");
        });
        const ok = vi.fn();
        adapter.onPollVote(broken);
        adapter.onPollVote(ok);

        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({ jid, pollId: "poll-iso", question: "Q?", options: ["A", "B"] });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({ pollId: "poll-iso", chosen: ["A"], remoteJid: jid }),
            ],
            type: "notify",
          },
        });

        expect(broken).toHaveBeenCalledOnce();
        expect(ok).toHaveBeenCalledOnce();
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.stringContaining("handler threw"),
          expect.any(Error)
        );
      });

      it("rejects onPollVote called with a filter but no handler", () => {
        expect(() => (adapter as unknown as { onPollVote: (x: string) => void }).onPollVote("only-id")).toThrow(
          /handler is required/
        );
      });

      it("uses the participant JID as the voter for group polls", async () => {
        const groupJid = "123456789@g.us";
        await sendStubbedPoll({
          jid: groupJid,
          pollId: "poll-group",
          question: "Snack?",
          options: ["pizza", "tacos"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-group",
                chosen: ["tacos"],
                remoteJid: groupJid,
                participant: "15559876543@s.whatsapp.net",
                voterPushName: "Alice",
              }),
            ],
            type: "notify",
          },
        });

        const [, , factory] = mockChat.processMessage.mock.calls[0] as [
          unknown,
          unknown,
          () => Promise<{ text: string; author: { userId: string; userName: string } }>,
        ];
        const built = await factory();
        expect(built.text).toBe("tacos");
        expect(built.author.userId).toBe("15559876543@s.whatsapp.net");
        expect(built.author.userName).toBe("Alice");
      });

      it("emits an empty-text message when the voter cleared their vote", async () => {
        const handler = vi.fn();
        adapter.onPollVote(handler);

        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({
          jid,
          pollId: "poll-clear",
          question: "Q?",
          options: ["A", "B"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-clear",
                chosen: [],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({ selectedOptions: [] })
        );
        const [, , factory] = mockChat.processMessage.mock.calls[0] as [
          unknown,
          unknown,
          () => Promise<{ text: string }>,
        ];
        expect((await factory()).text).toBe("");
      });

      it("warns and drops the vote when the poll is unknown to the state store", async () => {
        const jid = "15551234567@s.whatsapp.net";
        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "never-sent",
                chosen: ["X"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        expect(mockChat.processMessage).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("never-sent")
        );
      });

      it("drops votes when decryption throws", async () => {
        const baileys = await import("baileys");
        const decryptMock = vi.mocked(baileys.decryptPollVote);
        decryptMock.mockImplementationOnce(() => {
          throw new Error("bad ciphertext");
        });

        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({
          jid,
          pollId: "poll-broken",
          question: "Q?",
          options: ["A", "B"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-broken",
                chosen: ["A"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        expect(mockChat.processMessage).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.stringContaining("decrypt poll vote"),
          expect.any(Error)
        );
      });

      it("ignores hashes that don't match any stored option", async () => {
        const jid = "15551234567@s.whatsapp.net";
        const baileys = await import("baileys");
        const decryptMock = vi.mocked(baileys.decryptPollVote);
        decryptMock.mockImplementationOnce(() => ({
          selectedOptions: [createHash("sha256").update("Z").digest()],
        }) as never);

        await sendStubbedPoll({
          jid,
          pollId: "poll-mismatch",
          question: "Q?",
          options: ["A", "B"],
        });

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-mismatch",
                chosen: ["A"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        const [, , factory] = mockChat.processMessage.mock.calls[0] as [
          unknown,
          unknown,
          () => Promise<{ text: string }>,
        ];
        expect((await factory()).text).toBe("");
      });
    });

    // ── tracked poll registry (listTrackedPolls / forgetPoll) ────────────────

    describe("tracked poll registry", () => {
      async function sendStubbedPoll(opts: {
        jid: string;
        pollId: string;
        question: string;
        options: string[];
        secret?: Buffer;
        metadata?: unknown;
      }) {
        const threadId = adapter.encodeThreadId({ jid: opts.jid });
        mockSocket.sendMessage.mockResolvedValueOnce({
          key: { id: opts.pollId, remoteJid: opts.jid, fromMe: true },
          message: {
            messageContextInfo: { messageSecret: opts.secret ?? Buffer.alloc(32, 9) },
          },
        });
        await adapter.sendPoll(
          threadId,
          opts.question,
          opts.options,
          1,
          opts.metadata !== undefined ? { metadata: opts.metadata } : undefined
        );
        return threadId;
      }

      function makePollVoteMessage(opts: {
        pollId: string;
        chosen: string[];
        remoteJid: string;
        participant?: string;
      }): WAMessage {
        return {
          key: {
            remoteJid: opts.remoteJid,
            id: `vote-${opts.pollId}`,
            fromMe: false,
            participant: opts.participant,
          },
          message: {
            pollUpdateMessage: {
              pollCreationMessageKey: {
                remoteJid: opts.remoteJid,
                id: opts.pollId,
                fromMe: true,
              },
              vote: {
                encPayload: Buffer.from(opts.chosen.join("|"), "utf8"),
                encIv: Buffer.alloc(12, 0),
              },
              senderTimestampMs: 1700000003000,
            },
          },
          pushName: "Voter",
          messageTimestamp: 1700000003,
        } as WAMessage;
      }

      it("listTrackedPolls returns polls with question, options, and threadId", async () => {
        const jid = "15551234567@s.whatsapp.net";
        const expectedThreadId = adapter.encodeThreadId({ jid });
        await sendStubbedPoll({
          jid,
          pollId: "poll-track-1",
          question: "Lunch?",
          options: ["Pizza", "Burger"],
        });
        await sendStubbedPoll({
          jid,
          pollId: "poll-track-2",
          question: "Drink?",
          options: ["Water", "Soda"],
        });

        const tracked = await adapter.listTrackedPolls();
        expect(tracked).toEqual([
          {
            pollMessageId: "poll-track-1",
            threadId: expectedThreadId,
            question: "Lunch?",
            options: ["Pizza", "Burger"],
          },
          {
            pollMessageId: "poll-track-2",
            threadId: expectedThreadId,
            question: "Drink?",
            options: ["Water", "Soda"],
          },
        ]);
      });

      it("listTrackedPolls surfaces persisted metadata on each tracked entry", async () => {
        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({
          jid,
          pollId: "poll-track-meta",
          question: "Lunch?",
          options: ["Pizza", "Burger"],
          metadata: { askedBy: "user-42" },
        });

        const tracked = await adapter.listTrackedPolls();
        expect(tracked).toHaveLength(1);
        expect(tracked[0]).toMatchObject({
          pollMessageId: "poll-track-meta",
          metadata: { askedBy: "user-42" },
        });
      });

      it("listTrackedPolls returns empty when nothing has been tracked", async () => {
        expect(await adapter.listTrackedPolls()).toEqual([]);
      });

      it("listTrackedPolls filters out entries whose stored data is gone", async () => {
        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({ jid, pollId: "poll-keep", question: "Q?", options: ["A", "B"] });
        await sendStubbedPoll({ jid, pollId: "poll-gone", question: "Q?", options: ["A", "B"] });

        // Simulate the entry expiring out of the StateAdapter (TTL elapsed) —
        // index still has the id, but get() returns null.
        stateStore.delete("baileys:baileys:poll:poll-gone");

        const tracked = await adapter.listTrackedPolls();
        expect(tracked.map((p) => p.pollMessageId)).toEqual(["poll-keep"]);
      });

      it("listTrackedPolls dedupes index entries", async () => {
        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({ jid, pollId: "poll-dup", question: "Q?", options: ["A", "B"] });
        // Send a second poll with the same id (e.g. retry). Index now has two
        // entries for the same id; result should still list it once.
        await sendStubbedPoll({ jid, pollId: "poll-dup", question: "Q?", options: ["A", "B"] });

        const tracked = await adapter.listTrackedPolls();
        expect(tracked.map((p) => p.pollMessageId)).toEqual(["poll-dup"]);
      });

      it("forgetPoll removes the stored entry so listTrackedPolls drops it", async () => {
        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({ jid, pollId: "poll-forget", question: "Q?", options: ["A", "B"] });
        expect((await adapter.listTrackedPolls()).map((p) => p.pollMessageId)).toContain(
          "poll-forget"
        );

        await adapter.forgetPoll("poll-forget");

        expect(mockState.delete).toHaveBeenCalledWith("baileys:baileys:poll:poll-forget");
        expect(await adapter.listTrackedPolls()).toEqual([]);
      });

      it("listTrackedPolls + onPollVote re-registration round-trips after restart", async () => {
        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({
          jid,
          pollId: "poll-resume",
          question: "Time?",
          options: ["10am", "2pm"],
        });

        // Simulate restart: build a new adapter against the same persistent
        // state. In-memory subscriptions are gone — re-register from state.
        const restarted = makeAdapter();
        await restarted.initialize(mockChat);
        await restarted.connect();

        const tracked = await restarted.listTrackedPolls();
        const handler = vi.fn();
        for (const poll of tracked) {
          restarted.onPollVote(poll.pollMessageId, handler);
        }

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makePollVoteMessage({
                pollId: "poll-resume",
                chosen: ["10am"],
                remoteJid: jid,
              }),
            ],
            type: "notify",
          },
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0]).toMatchObject({
          pollMessageId: "poll-resume",
          selectedOptions: ["10am"],
        });
      });

      it("appends to the index with the configured pollTtlMs", async () => {
        adapter = makeAdapter({ pollTtlMs: 5000 });
        await adapter.initialize(mockChat);
        await adapter.connect();
        const jid = "15551234567@s.whatsapp.net";
        await sendStubbedPoll({ jid, pollId: "poll-ttl-idx", question: "Q?", options: ["A", "B"] });

        expect(mockState.appendToList).toHaveBeenCalledWith(
          "baileys:baileys:poll-index",
          "poll-ttl-idx",
          expect.objectContaining({ ttlMs: 5000 })
        );
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
      it("forwards reaction messages to chat.processReaction", async () => {
        await capturedEvHandler!({
          "messages.upsert": { messages: [makeReactionMessage()], type: "notify" },
        });

        expect(mockChat.processReaction).toHaveBeenCalledWith(
          expect.objectContaining({
            adapter,
            added: true,
            messageId: "target-msg-1",
            rawEmoji: "👍",
            threadId: adapter.encodeThreadId({ jid: "123456789@g.us" }),
            user: expect.objectContaining({
              userId: "15559876543@s.whatsapp.net",
              userName: "Alice",
            }),
          })
        );
        expect(mockChat.processMessage).not.toHaveBeenCalled();
      });

      it("treats empty reaction text as a reaction removal", async () => {
        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makeReactionMessage({
                message: {
                  reactionMessage: {
                    key: {
                      remoteJid: "123456789@g.us",
                      id: "target-msg-1",
                      fromMe: false,
                      participant: "15550001111@s.whatsapp.net",
                    },
                    text: "",
                  },
                },
              }),
            ],
            type: "notify",
          },
        });

        expect(mockChat.processReaction).toHaveBeenCalledWith(
          expect.objectContaining({
            added: false,
            rawEmoji: "",
          })
        );
      });

      it("does not treat paired-phone reactions as bot-authored", async () => {
        mockSocket.user.id = "15550000000@s.whatsapp.net";
        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makeReactionMessage({
                key: {
                  remoteJid: "15559876543@s.whatsapp.net",
                  id: "manual-reaction",
                  fromMe: true,
                },
                pushName: "Owner",
              }),
            ],
            type: "notify",
          },
        });

        expect(mockChat.processReaction).toHaveBeenCalledWith(
          expect.objectContaining({
            user: expect.objectContaining({
              userId: "15550000000@s.whatsapp.net",
              isMe: false,
              isBot: false,
            }),
          })
        );
      });

      it("marks adapter-sent reaction echoes as bot-authored", async () => {
        const threadId = adapter.encodeThreadId({ jid: "15551234567@s.whatsapp.net" });
        await adapter.addReaction(threadId, "target-msg-1", "👍");
        mockChat.processReaction.mockClear();

        await capturedEvHandler!({
          "messages.upsert": {
            messages: [
              makeReactionMessage({
                key: {
                  remoteJid: "15551234567@s.whatsapp.net",
                  id: "generated-id",
                  fromMe: true,
                },
                pushName: "Bot",
              }),
            ],
            type: "notify",
          },
        });

        expect(mockChat.processReaction).toHaveBeenCalledWith(
          expect.objectContaining({
            user: expect.objectContaining({
              isMe: true,
              isBot: true,
            }),
          })
        );
      });

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
