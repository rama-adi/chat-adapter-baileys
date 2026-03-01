import {
  ConsoleLogger,
  Message,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type Author,
  type ChannelInfo,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type ListThreadsOptions,
  type ListThreadsResult,
  type Logger,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import {
  ValidationError,
  extractCard,
  cardToFallbackText,
} from "@chat-adapter/shared";
import makeWASocket, {
  DisconnectReason,
  extractMessageContent as extractBaileysMessageContent,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidNewsletter,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  downloadMediaMessage,
  generateMessageIDV2,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import { BaileysFormatConverter } from "./format-converter.js";
import type { BaileysAdapterConfig, BaileysGroupParticipant, BaileysThreadId } from "./types.js";

export class BaileysAdapter
  implements Adapter<BaileysThreadId, WAMessage>
{
  readonly name: string;
  readonly userName: string;

  private _socket: WASocket | null = null;
  private _chat: ChatInstance | null = null;
  private _logger: Logger;
  private _config: BaileysAdapterConfig;
  private _converter = new BaileysFormatConverter();
  private _isConnected = false;
  private _shouldReconnect = true;
  /** Guard so we only request a pairing code once per socket lifetime. */
  private _pairingCodeRequested = false;

  constructor(config: BaileysAdapterConfig) {
    const adapterName = config.adapterName ?? "baileys";
    if (adapterName.includes(":")) {
      throw new ValidationError(
        "baileys",
        `Invalid adapterName "${adapterName}". ":" is not allowed.`
      );
    }

    this._config = config;
    this.name = adapterName;
    this.userName = config.userName ?? "baileys-bot";
    this._logger = config.logger ?? new ConsoleLogger();
  }

  get botUserId(): string | undefined {
    return this._socket?.user?.id ?? undefined;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this._chat = chat;
    this._logger = chat.getLogger("baileys");
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect to WhatsApp via a persistent WebSocket.
   *
   * Call this after registering all handlers on your `Chat` instance.
   * The adapter handles automatic reconnection on unexpected disconnects.
   *
   * @example
   * ```typescript
   * const bot = new Chat({ adapters: { whatsapp: adapter }, ... });
   * bot.onNewMention(async (thread, msg) => { ... });
   * await adapter.connect();
   * ```
   */
  async connect(): Promise<void> {
    this._shouldReconnect = true;
    await this._createSocket();
  }

  /** Disconnect from WhatsApp and clean up the socket. */
  async disconnect(): Promise<void> {
    this._isConnected = false;
    this._shouldReconnect = false;
    if (this._socket) {
      this._socket.end(undefined);
      this._socket = null;
    }
  }

  private async _createSocket(): Promise<void> {
    const { state, saveCreds } = this._config.auth;

    let version = this._config.version;
    if (!version) {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
      this._logger.debug(`Using WhatsApp Web v${version.join(".")}`);
    }

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined),
      },
      ...(this._config.socketOptions ?? {}),
    } as Parameters<typeof makeWASocket>[0]);

    this._socket = socket;
    this._pairingCodeRequested = false;

    socket.ev.process(async (events) => {
      // ── credentials updated ─────────────────────────────────────────────────
      if (events["creds.update"]) {
        await saveCreds();
      }

      // ── connection state ─────────────────────────────────────────────────────
      if (events["connection.update"]) {
        const { connection, lastDisconnect, qr } = events["connection.update"];

        // QR code — pass to caller for display
        if (qr && this._config.onQR) {
          await this._config.onQR(qr);
        }

        // Pairing code — request once when the socket starts connecting
        if (
          this._config.phoneNumber &&
          this._config.onPairingCode &&
          !this._pairingCodeRequested &&
          (connection === "connecting" || qr)
        ) {
          this._pairingCodeRequested = true;
          try {
            const code = await socket.requestPairingCode(
              this._config.phoneNumber
            );
            this._config.onPairingCode(code);
          } catch (err) {
            this._logger.error("Failed to request pairing code", err);
          }
        }

        if (connection === "open") {
          this._isConnected = true;
          this._logger.info("Connected to WhatsApp");
        }

        if (connection === "close") {
          this._isConnected = false;
          const statusCode = (
            lastDisconnect?.error as { output?: { statusCode?: number } }
          )?.output?.statusCode;

          // restartRequired (515) is expected after a QR scan — Baileys
          // forces a reconnect to complete the handshake. Not an error.
          const isExpectedRestart =
            statusCode === DisconnectReason.restartRequired;
          const shouldReconnect =
            this._shouldReconnect && statusCode !== DisconnectReason.loggedOut;

          this._logger.info(
            isExpectedRestart
              ? "Restarting socket after QR auth handshake…"
              : `Connection closed (code=${statusCode ?? "unknown"}, reconnect=${shouldReconnect})`
          );

          if (shouldReconnect) {
            await this._createSocket();
          } else {
            this._logger.warn("Logged out — not reconnecting.");
          }
        }
      }

      // ── new messages ─────────────────────────────────────────────────────────
      if (events["messages.upsert"] && this._chat) {
        const { messages, type } = events["messages.upsert"];

        if (type !== "notify") return;

        for (const msg of messages) {
          // Skip system / empty messages
          if (!msg.message) continue;
          // Skip status broadcasts and newsletters
          const jid = msg.key.remoteJid ?? "";
          if (isJidNewsletter(jid)) continue;

          const threadId = this.encodeThreadId({ jid });

          this._chat.processMessage(
            this,
            threadId,
            async () => this.parseMessage(msg)
          );
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Thread ID encode / decode
  // ---------------------------------------------------------------------------

  encodeThreadId(data: BaileysThreadId): string {
    const encoded = Buffer.from(data.jid).toString("base64url");
    return `${this.name}:${encoded}`;
  }

  decodeThreadId(threadId: string): BaileysThreadId {
    const prefix = `${this.name}:`;
    if (!threadId.startsWith(prefix)) {
      throw new ValidationError(
        "baileys",
        `Invalid Baileys thread ID: ${threadId}`
      );
    }
    const encodedJid = threadId.slice(prefix.length);
    const jid = Buffer.from(encodedJid, "base64url").toString();
    return { jid };
  }

  channelIdFromThreadId(threadId: string): string {
    // WhatsApp has no channel/thread distinction — channel = thread
    return threadId;
  }

  isDM(threadId: string): boolean {
    const { jid } = this.decodeThreadId(threadId);
    return !isJidGroup(jid) && !isJidNewsletter(jid);
  }

  // ---------------------------------------------------------------------------
  // Webhook (not applicable for Baileys)
  // ---------------------------------------------------------------------------

  /**
   * Baileys uses a persistent WebSocket — not inbound HTTP webhooks.
   * This method always returns HTTP 501 Not Implemented.
   *
   * To receive messages, call `adapter.connect()` instead.
   */
  async handleWebhook(
    _request: Request,
    _options?: WebhookOptions
  ): Promise<Response> {
    return new Response(
      JSON.stringify({
        error:
          "Baileys adapter does not use HTTP webhooks. " +
          "Call adapter.connect() to start the WhatsApp WebSocket connection.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } }
    );
  }

  // ---------------------------------------------------------------------------
  // Message parsing
  // ---------------------------------------------------------------------------

  parseMessage(raw: WAMessage): Message<WAMessage> {
    const jid = raw.key.remoteJid ?? "";
    const isGroup = isJidGroup(jid);
    const isMe = raw.key.fromMe ?? false;
    const content = getMessageContent(raw);

    const senderId = isMe
      ? (this._socket?.user?.id ?? "unknown@s.whatsapp.net")
      : isGroup
        ? (raw.key.participant ?? jid)
        : jid;

    const text = extractTextFromMessage(content);
    const threadId = this.encodeThreadId({ jid });

    const attachments: Attachment[] = buildAttachments(raw, content, this._socket);

    return new Message<WAMessage>({
      id: raw.key.id ?? generateMessageIDV2(),
      threadId,
      text,
      formatted: this._converter.toAst(text),
      raw,
      author: {
        userId: senderId,
        userName: raw.pushName ?? senderId.split("@")[0],
        fullName: raw.pushName ?? "",
        isBot: false,
        isMe,
      } satisfies Author,
      metadata: {
        dateSent: new Date(
          (Number(raw.messageTimestamp ?? 0)) * 1000
        ),
        edited:
          raw.message?.editedMessage != null ||
          raw.message?.protocolMessage?.type === 14,
      },
      attachments,
    });
  }

  // ---------------------------------------------------------------------------
  // Sending messages
  // ---------------------------------------------------------------------------

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WAMessage>> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();

    const card = extractCard(message);
    const text = card
      ? cardToFallbackText(card)
      : this._converter.renderPostable(message);

    const sent = await socket.sendMessage(jid, { text });
    return this._toRawMessage(sent, threadId);
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WAMessage>> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();

    const card = extractCard(message);
    const text = card
      ? cardToFallbackText(card)
      : this._converter.renderPostable(message);

    const key: WAMessageKey = { remoteJid: jid, id: messageId, fromMe: true };
    const sent = await socket.sendMessage(jid, { edit: key, text });
    return this._toRawMessage(sent, threadId);
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const key: WAMessageKey = { remoteJid: jid, id: messageId, fromMe: true };
    await socket.sendMessage(jid, { delete: key });
  }

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const text = typeof emoji === "string" ? emoji : emoji.toString();
    const key: WAMessageKey = { remoteJid: jid, id: messageId, fromMe: false };
    await socket.sendMessage(jid, { react: { text, key } });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const key: WAMessageKey = { remoteJid: jid, id: messageId, fromMe: false };
    // Empty text removes the reaction
    await socket.sendMessage(jid, { react: { text: "", key } });
  }

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions
  ): Promise<FetchResult<WAMessage>> {
    // WhatsApp (Baileys) does not expose a REST-style message history API.
    // Implement your own message store by persisting messages received via
    // the `messages.upsert` event and querying it here.
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { jid } = this.decodeThreadId(threadId);
    const isGroup = isJidGroup(jid);

    let channelName: string | undefined;
    if (isGroup && this._socket) {
      try {
        const meta = await this._socket.groupMetadata(jid);
        channelName = meta.subject;
      } catch {
        // group metadata unavailable
      }
    }

    return {
      id: threadId,
      channelId: threadId,
      channelName,
      isDM: !isGroup,
      metadata: { jid },
    };
  }

  // ---------------------------------------------------------------------------
  // Channel methods
  // ---------------------------------------------------------------------------

  /**
   * Fetch channel metadata.
   *
   * In WhatsApp, a "channel" is just the JID — a group or DM conversation.
   * For groups, this fetches the group subject and participant count.
   */
  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const { jid } = this.decodeThreadId(channelId);
    const isGroup = isJidGroup(jid);

    let name: string | undefined;
    let memberCount: number | undefined;

    if (isGroup && this._socket) {
      try {
        const meta = await this._socket.groupMetadata(jid);
        name = meta.subject;
        memberCount = meta.participants?.length;
      } catch {
        // group metadata unavailable
      }
    }

    return {
      id: channelId,
      name,
      isDM: !isGroup,
      memberCount,
      metadata: { jid },
    };
  }

  /**
   * Fetch channel-level messages.
   *
   * WhatsApp has no REST history API — same limitation as `fetchMessages`.
   * Implement your own store by persisting messages from `messages.upsert`.
   */
  async fetchChannelMessages(
    _channelId: string,
    _options?: FetchOptions
  ): Promise<FetchResult<WAMessage>> {
    return { messages: [] };
  }

  /**
   * List threads in a channel.
   *
   * WhatsApp has no sub-threads — each conversation (JID) is a single
   * flat message stream. Returns an empty result accordingly.
   */
  async listThreads(
    _channelId: string,
    _options?: ListThreadsOptions
  ): Promise<ListThreadsResult<WAMessage>> {
    return { threads: [] };
  }

  /**
   * Post a message to a channel.
   *
   * In WhatsApp there is no channel/thread distinction — a channel IS the
   * conversation, so this delegates directly to `postMessage`.
   */
  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WAMessage>> {
    return this.postMessage(channelId, message);
  }

  // ---------------------------------------------------------------------------
  // Direct messages
  // ---------------------------------------------------------------------------

  async openDM(userId: string): Promise<string> {
    // Normalise: if plain phone number, append the default WA server
    const jid = userId.includes("@")
      ? userId
      : `${userId}@s.whatsapp.net`;
    return this.encodeThreadId({ jid });
  }

  // ---------------------------------------------------------------------------
  // Typing indicator
  // ---------------------------------------------------------------------------

  async startTyping(threadId: string, _status?: string): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    if (this._socket) {
      await this._socket.sendPresenceUpdate("composing", jid);
    }
  }

  // ---------------------------------------------------------------------------
  // Formatted content
  // ---------------------------------------------------------------------------

  renderFormatted(content: FormattedContent): string {
    return this._converter.fromAst(content);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _requireSocket(): WASocket {
    if (!this._socket) {
      throw new ValidationError(
        "baileys",
        "Socket not connected. Call adapter.connect() first."
      );
    }
    return this._socket;
  }

  // ---------------------------------------------------------------------------
  // WhatsApp extensions (not part of the Chat SDK Adapter interface)
  // ---------------------------------------------------------------------------

  /**
   * Send a quoted reply to a message, producing WhatsApp's native reply bubble.
   *
   * The Chat SDK's `thread.post()` has no concept of quoting a specific message.
   * Use this method directly on the adapter when you need the visual reply reference.
   *
   * @example
   * ```typescript
   * bot.onSubscribedMessage(async (thread, message) => {
   *   await whatsapp.reply(message, "Got it!");
   * });
   * ```
   */
  async reply(
    message: Message<WAMessage>,
    text: string
  ): Promise<RawMessage<WAMessage>> {
    // Validate that the message belongs to this adapter instance.
    // This catches accidental cross-account calls in multi-account setups
    // (e.g. calling waMain.reply() with a message that arrived on waSales).
    const prefix = `${this.name}:`;
    if (!message.threadId.startsWith(prefix)) {
      throw new ValidationError(
        "baileys",
        `reply: message belongs to adapter "${message.threadId.split(":")[0]}", not "${this.name}"`
      );
    }
    const raw = message.raw;
    const jid = raw.key.remoteJid ?? "";
    if (!jid) {
      throw new ValidationError("baileys", "reply: message has no remoteJid");
    }
    const socket = this._requireSocket();
    const sent = await socket.sendMessage(jid, { text }, { quoted: raw });
    return this._toRawMessage(sent, this.encodeThreadId({ jid }));
  }

  /**
   * Mark one or more messages as read, sending read receipts to the sender.
   *
   * The Chat SDK has no read-receipt concept — call this directly when you want
   * to explicitly acknowledge messages.
   *
   * @example
   * ```typescript
   * bot.onSubscribedMessage(async (thread, message) => {
   *   await whatsapp.markRead(thread.threadId, [message.id]);
   * });
   * ```
   */
  async markRead(threadId: string, messageIds: string[]): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const keys = messageIds.map((id) => ({ remoteJid: jid, id, fromMe: false }));
    await socket.readMessages(keys);
  }

  /**
   * Set the bot's global WhatsApp presence — whether it appears online or offline.
   *
   * The Chat SDK's `thread.startTyping()` sends a per-chat composing presence.
   * This method controls the bot's top-level online/offline status.
   *
   * @example
   * ```typescript
   * await whatsapp.setPresence("available");   // appears online
   * await whatsapp.setPresence("unavailable"); // appears offline
   * ```
   */
  async setPresence(presence: "available" | "unavailable"): Promise<void> {
    const socket = this._requireSocket();
    await socket.sendPresenceUpdate(presence);
  }

  /**
   * Send a location pin to a thread.
   *
   * WhatsApp supports native location messages (shown as a map pin). The Chat SDK
   * has no location type, so this is exposed as an adapter extension.
   *
   * @example
   * ```typescript
   * await whatsapp.sendLocation(thread.threadId, 37.7749, -122.4194, {
   *   name: "San Francisco",
   *   address: "San Francisco, CA, USA",
   * });
   * ```
   */
  async sendLocation(
    threadId: string,
    latitude: number,
    longitude: number,
    options?: { name?: string; address?: string }
  ): Promise<RawMessage<WAMessage>> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const sent = await socket.sendMessage(jid, {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name: options?.name,
        address: options?.address,
      },
    });
    return this._toRawMessage(sent, threadId);
  }

  /**
   * Send a WhatsApp poll to a thread.
   *
   * Polls are a native WhatsApp feature with no Chat SDK equivalent.
   * `selectableCount` controls how many options a user can pick (default: 1).
   *
   * @example
   * ```typescript
   * await whatsapp.sendPoll(thread.threadId, "What time works for the call?", [
   *   "10:00 AM",
   *   "2:00 PM",
   *   "5:00 PM",
   * ]);
   * ```
   */
  async sendPoll(
    threadId: string,
    question: string,
    options: string[],
    selectableCount = 1
  ): Promise<RawMessage<WAMessage>> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const sent = await socket.sendMessage(jid, {
      poll: { name: question, values: options, selectableCount },
    });
    return this._toRawMessage(sent, threadId);
  }

  /**
   * Fetch the list of participants in a group thread.
   *
   * The Chat SDK has no group-membership concept. Use this to get the full
   * participant list including admin status.
   *
   * Throws if the thread is not a group.
   *
   * @example
   * ```typescript
   * const participants = await whatsapp.fetchGroupParticipants(thread.threadId);
   * const admins = participants.filter(p => p.isAdmin);
   * await thread.post(`Admins: ${admins.map(p => p.userId).join(", ")}`);
   * ```
   */
  async fetchGroupParticipants(
    threadId: string
  ): Promise<BaileysGroupParticipant[]> {
    const { jid } = this.decodeThreadId(threadId);
    if (!isJidGroup(jid)) {
      throw new ValidationError(
        "baileys",
        "fetchGroupParticipants: thread is not a group"
      );
    }
    const socket = this._requireSocket();
    const meta = await socket.groupMetadata(jid);
    return meta.participants.map((p) => ({
      userId: p.id,
      isAdmin: p.admin === "admin" || p.admin === "superadmin",
      isSuperAdmin: p.admin === "superadmin",
    }));
  }

  private _toRawMessage(
    sent: WAMessage | undefined,
    threadId: string
  ): RawMessage<WAMessage> {
    if (!sent) {
      throw new ValidationError("baileys", "sendMessage returned no message.");
    }
    return {
      id: sent.key.id ?? generateMessageIDV2(),
      raw: sent,
      threadId,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractTextFromMessage(
  content: NonNullable<WAMessage["message"]> | undefined
): string {
  const m = content;
  if (!m) return "";
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.buttonsMessage?.contentText ??
    m.listMessage?.description ??
    m.templateMessage?.hydratedTemplate?.hydratedContentText ??
    ""
  );
}

function getMessageContent(
  msg: WAMessage
): NonNullable<WAMessage["message"]> | undefined {
  const normalized = normalizeMessageContent(msg.message);
  if (!normalized) return undefined;
  return (
    extractBaileysMessageContent(normalized) ??
    normalized
  ) as NonNullable<WAMessage["message"]>;
}

function buildAttachments(
  msg: WAMessage,
  content: NonNullable<WAMessage["message"]> | undefined,
  socket: WASocket | null
): Attachment[] {
  const m = content;
  if (!m) return [];

  const attachments: Attachment[] = [];

  if (m.imageMessage) {
    attachments.push({
      type: "image",
      mimeType: m.imageMessage.mimetype ?? "image/jpeg",
      name: "image",
      fetchData: socket
        ? () =>
            downloadMediaMessage(msg, "buffer", {}) as Promise<Buffer>
        : undefined,
    });
  } else if (m.videoMessage) {
    attachments.push({
      type: "video",
      mimeType: m.videoMessage.mimetype ?? "video/mp4",
      name: "video",
      fetchData: socket
        ? () =>
            downloadMediaMessage(msg, "buffer", {}) as Promise<Buffer>
        : undefined,
    });
  } else if (m.audioMessage) {
    attachments.push({
      type: "audio",
      mimeType: m.audioMessage.mimetype ?? "audio/ogg",
      name: "audio",
      fetchData: socket
        ? () =>
            downloadMediaMessage(msg, "buffer", {}) as Promise<Buffer>
        : undefined,
    });
  } else if (m.documentMessage) {
    attachments.push({
      type: "file",
      mimeType:
        m.documentMessage.mimetype ?? "application/octet-stream",
      name: m.documentMessage.fileName ?? "document",
      fetchData: socket
        ? () =>
            downloadMediaMessage(msg, "buffer", {}) as Promise<Buffer>
        : undefined,
    });
  }

  return attachments;
}
