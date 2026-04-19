import {
  ConsoleLogger,
  Message,
  defaultEmojiResolver,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type Author,
  type ChannelInfo,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FileUpload,
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
  extractFiles,
  cardToFallbackText,
} from "@chat-adapter/shared";
import makeWASocket, {
  DisconnectReason,
  decryptPollVote,
  extractMessageContent as extractBaileysMessageContent,
  fetchLatestBaileysVersion,
  getKeyAuthor,
  isJidGroup,
  isJidNewsletter,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  downloadMediaMessage,
  generateMessageIDV2,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import { createHash } from "node:crypto";
import { BaileysFormatConverter } from "./format-converter.js";
import type {
  BaileysAdapterConfig,
  BaileysGroupParticipant,
  BaileysPollVote,
  BaileysPollVoteHandler,
  BaileysSendPollOptions,
  BaileysThreadId,
  BaileysTrackedPoll,
} from "./types.js";

const DEFAULT_POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_INDEX_MAX_LENGTH = 1000;

interface StoredPollEntry {
  question: string;
  options: string[];
  creatorJid: string;
  /** base64-encoded message secret */
  messageSecret: string;
  /** Encoded thread ID where the poll was sent. May be undefined for entries written by older versions. */
  threadId?: string;
  /** Arbitrary caller-supplied metadata, round-tripped into every vote. */
  metadata?: unknown;
}

interface PollVoteSubscription {
  /** When set, only votes whose pollMessageId is in this set fire the handler. */
  filter?: Set<string>;
  handler: BaileysPollVoteHandler;
}

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
  private _pollVoteSubscriptions: PollVoteSubscription[] = [];

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

          const content = getMessageContent(msg);
          const reaction = content?.reactionMessage;
          const pollUpdate = content?.pollUpdateMessage;
          const threadId = this.encodeThreadId({ jid });

          if (reaction && this._chat) {
            this._chat.processReaction({
              adapter: this,
              added: isReactionAdded(reaction.text),
              emoji: defaultEmojiResolver.fromGChat(reaction.text ?? ""),
              messageId: reaction.key?.id ?? "",
              raw: msg,
              rawEmoji: reaction.text ?? "",
              threadId,
              user: buildReactionAuthor(msg, this._socket?.user?.id),
            });
            continue;
          }

          if (pollUpdate && this._chat) {
            await this._handlePollUpdate(msg, pollUpdate, threadId);
            continue;
          }

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
    return this._sendPostable(jid, message, threadId);
  }

  private async _sendPostable(
    jid: string,
    message: AdapterPostableMessage,
    threadId: string,
    options?: { quoted?: WAMessage }
  ): Promise<RawMessage<WAMessage>> {
    const socket = this._requireSocket();

    const card = extractCard(message);
    const text = card
      ? cardToFallbackText(card)
      : this._converter.renderPostable(message);

    const media = await buildMediaPayloads(message);

    if (media.length === 0) {
      const sent = await sendOne(socket, jid, { text }, options);
      return this._toRawMessage(sent, threadId);
    }

    const captionIdx = text.length > 0 ? media.findIndex(canCarryCaption) : -1;
    const payloads: MediaPayload[] = [];
    if (text.length > 0 && captionIdx === -1) {
      payloads.push({ text });
    }
    media.forEach((m, i) => {
      payloads.push(i === captionIdx ? { ...m, caption: text } : m);
    });

    let first: WAMessage | undefined;
    for (let i = 0; i < payloads.length; i++) {
      // Only the first send carries the `quoted` reference, matching
      // WhatsApp's native behaviour where only one message in a batch quotes.
      const opts = i === 0 ? options : undefined;
      const sent = await sendOne(socket, jid, payloads[i], opts);
      if (!first) first = sent ?? undefined;
    }

    return this._toRawMessage(first, threadId);
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
    emoji: EmojiValue | string,
    participant?: string
  ): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const text = typeof emoji === "string" ? emoji : emoji.toString();
    const key: WAMessageKey = {
      remoteJid: jid,
      id: messageId,
      fromMe: false,
      participant,
    };
    await socket.sendMessage(jid, { react: { text, key } });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
    participant?: string
  ): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const key: WAMessageKey = {
      remoteJid: jid,
      id: messageId,
      fromMe: false,
      participant,
    };
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
   * Accepts either a plain string or any `AdapterPostableMessage` shape,
   * including ones with `attachments` / `files`. When attachments are present,
   * only the first outgoing message carries the quoted reference — matching
   * WhatsApp's native behaviour.
   *
   * @example
   * ```typescript
   * // text-only reply
   * await whatsapp.reply(message, "Got it!");
   *
   * // reply with an image + caption, all quoting the original
   * await whatsapp.reply(message, {
   *   raw: "Here's the screenshot you asked for",
   *   files: [{ data: buffer, filename: "shot.png", mimeType: "image/png" }],
   * });
   * ```
   */
  async reply(
    message: Message<WAMessage>,
    content: AdapterPostableMessage
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
    if (message.threadId !== this.encodeThreadId({ jid })) {
      throw new ValidationError(
        "baileys",
        "reply: message threadId does not match the quoted message JID"
      );
    }

    // In practice, quoted replies are more reliable when the inbound message
    // has been acknowledged first, especially for unofficial clients.
    if (!raw.key.fromMe && raw.key.id) {
      await this.markRead(
        message.threadId,
        [raw.key.id],
        getParticipantForMessage(raw)
      );
    }

    return this._sendPostable(jid, content, this.encodeThreadId({ jid }), {
      quoted: raw,
    });
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
   *   await whatsapp.markRead(
   *     thread.threadId,
   *     [message.id],
   *     thread.isDM ? undefined : message.author.userId
   *   );
   * });
   * ```
   */
  async markRead(
    threadId: string,
    messageIds: string[],
    participant?: string
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const keys = messageIds.map((id) => ({
      remoteJid: jid,
      id,
      fromMe: false,
      participant,
    }));
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
    assertValidLatitude(latitude);
    assertValidLongitude(longitude);

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
   *
   * // With arbitrary metadata round-tripped to onPollVote:
   * await whatsapp.sendPoll(thread.threadId, "Lunch?", ["A", "B"], 1, {
   *   metadata: { askedBy: userId },
   * });
   * ```
   */
  async sendPoll(
    threadId: string,
    question: string,
    options: string[],
    selectableCount = 1,
    sendOptions?: BaileysSendPollOptions
  ): Promise<RawMessage<WAMessage>> {
    assertValidPoll(question, options, selectableCount);

    const { jid } = this.decodeThreadId(threadId);
    const socket = this._requireSocket();
    const sent = await socket.sendMessage(jid, {
      poll: { name: question, values: options, selectableCount },
    });

    await this._rememberPoll(
      sent,
      threadId,
      question,
      options,
      sendOptions?.metadata
    );

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

  // ---------------------------------------------------------------------------
  // Poll vote handling
  // ---------------------------------------------------------------------------

  /**
   * Register a handler for decrypted poll votes.
   *
   * WhatsApp poll votes arrive as `pollUpdateMessage` events and are E2E
   * encrypted. The adapter automatically decrypts votes for polls the bot
   * sent via {@link BaileysAdapter.sendPoll} (the poll's `messageSecret` is
   * persisted via the SDK's `StateAdapter`) and dispatches them here.
   *
   * Decrypted votes are also forwarded to `chat.processMessage` with the
   * selected option names joined as the message text — so handlers like
   * `chat.onSubscribedMessage` still see them. Use this method when you need
   * the structured payload (poll question, voter, selected option names).
   *
   * Mirrors the Chat SDK's filtered-handler shape (`onReaction(emoji, fn)`,
   * `onAction(actionIds, fn)`).
   *
   * @example
   * ```ts
   * // All votes on any poll the bot has sent.
   * wa.onPollVote((vote) => {
   *   console.log(`${vote.voter.userName}: ${vote.selectedOptions.join(", ")}`);
   * });
   *
   * // Votes scoped to a single poll.
   * const poll = await wa.sendPoll(thread.threadId, "Lunch?", ["A", "B"]);
   * wa.onPollVote(poll.id, async (vote) => {
   *   await thread.post(`${vote.voter.userName} picked ${vote.selectedOptions[0]}`);
   * });
   *
   * // Votes scoped to several polls.
   * wa.onPollVote([pollA.id, pollB.id], handler);
   * ```
   *
   * Multiple handlers can be registered; all matching handlers run in
   * registration order. An empty `selectedOptions` array means the voter
   * cleared their vote.
   */
  onPollVote(handler: BaileysPollVoteHandler): void;
  onPollVote(
    pollMessageIds: string | string[],
    handler: BaileysPollVoteHandler
  ): void;
  onPollVote(
    arg1: string | string[] | BaileysPollVoteHandler,
    arg2?: BaileysPollVoteHandler
  ): void {
    if (typeof arg1 === "function") {
      this._pollVoteSubscriptions.push({ handler: arg1 });
      return;
    }
    if (!arg2) {
      throw new ValidationError(
        "baileys",
        "onPollVote: handler is required when filtering by poll message id."
      );
    }
    const ids = Array.isArray(arg1) ? arg1 : [arg1];
    this._pollVoteSubscriptions.push({
      filter: new Set(ids),
      handler: arg2,
    });
  }

  /**
   * List polls the adapter is currently tracking — i.e. polls previously sent
   * via {@link BaileysAdapter.sendPoll} whose decryption metadata still lives
   * in the SDK's `StateAdapter`.
   *
   * Use this on startup to re-register per-poll handlers after a process
   * restart (in-memory `onPollVote(pollId, handler)` registrations don't
   * survive restarts, but the stored metadata does).
   *
   * Stale index entries (entries whose poll TTL has expired or were cleared
   * via {@link BaileysAdapter.forgetPoll}) are filtered out — the returned
   * list only contains polls that can actually decrypt incoming votes.
   *
   * @example
   * ```ts
   * const tracked = await wa.listTrackedPolls();
   * for (const poll of tracked) {
   *   wa.onPollVote(poll.pollMessageId, (vote) => {
   *     console.log(`vote on "${poll.question}":`, vote.selectedOptions);
   *   });
   * }
   * ```
   */
  async listTrackedPolls(): Promise<BaileysTrackedPoll[]> {
    if (!this._chat) return [];
    const state = this._chat.getState();
    const ids = await state.getList<string>(this._pollIndexKey());
    if (ids.length === 0) return [];

    const seen = new Set<string>();
    const tracked: BaileysTrackedPoll[] = [];

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);

      const entry = await state.get<StoredPollEntry>(this._pollKey(id));
      if (!entry) continue;

      tracked.push({
        pollMessageId: id,
        threadId: entry.threadId ?? "",
        question: entry.question,
        options: entry.options,
        metadata: entry.metadata,
      });
    }

    return tracked;
  }

  /**
   * Forget a tracked poll — deletes its decryption metadata from the
   * `StateAdapter`. Subsequent votes on this poll won't be decrypted.
   *
   * Useful once a poll has closed and you no longer want to receive votes
   * on it (e.g. the deadline passed). The index entry is left in place but
   * filtered out by {@link BaileysAdapter.listTrackedPolls}.
   */
  async forgetPoll(pollMessageId: string): Promise<void> {
    if (!this._chat) return;
    await this._chat.getState().delete(this._pollKey(pollMessageId));
  }

  private _pollKey(pollMessageId: string): string {
    return `baileys:${this.name}:poll:${pollMessageId}`;
  }

  private _pollIndexKey(): string {
    return `baileys:${this.name}:poll-index`;
  }

  private async _rememberPoll(
    sent: WAMessage | undefined,
    threadId: string,
    question: string,
    options: string[],
    metadata: unknown
  ): Promise<void> {
    const id = sent?.key?.id;
    if (!this._chat || !id) {
      return;
    }

    const secret = (
      sent?.message as { messageContextInfo?: { messageSecret?: Uint8Array } } | undefined
    )?.messageContextInfo?.messageSecret;

    if (!secret) {
      this._logger.warn(
        "sendPoll: no messageSecret on sent poll — incoming votes won't be decryptable."
      );
      return;
    }

    const creatorJid = jidNormalizedUser(this._socket?.user?.id ?? "");
    const entry: StoredPollEntry = {
      question,
      options,
      creatorJid,
      messageSecret: Buffer.from(secret).toString("base64"),
      threadId,
      ...(metadata !== undefined ? { metadata } : {}),
    };

    const ttl = this._config.pollTtlMs ?? DEFAULT_POLL_TTL_MS;
    const ttlOpt = ttl > 0 ? ttl : undefined;
    const state = this._chat.getState();
    await state.set(this._pollKey(id), entry, ttlOpt);
    await state.appendToList(this._pollIndexKey(), id, {
      maxLength: POLL_INDEX_MAX_LENGTH,
      ttlMs: ttlOpt,
    });
  }

  private async _handlePollUpdate(
    msg: WAMessage,
    update: NonNullable<NonNullable<WAMessage["message"]>["pollUpdateMessage"]>,
    threadId: string
  ): Promise<void> {
    const pollMessageId = update.pollCreationMessageKey?.id;
    if (!pollMessageId || !this._chat) {
      return;
    }

    const stored = await this._chat
      .getState()
      .get<StoredPollEntry>(this._pollKey(pollMessageId));

    if (!stored) {
      this._logger.warn(
        `pollUpdateMessage: no stored poll for id=${pollMessageId} — ` +
          "the bot may have restarted with a non-persistent state adapter, " +
          "or the poll was sent by a different bot instance."
      );
      return;
    }

    const meId = jidNormalizedUser(this._socket?.user?.id ?? "");
    const voterJid = getKeyAuthor(msg.key, meId);
    const messageSecret = new Uint8Array(
      Buffer.from(stored.messageSecret, "base64")
    );

    let voteMsg: { selectedOptions?: Uint8Array[] | null };
    try {
      voteMsg = decryptPollVote(update.vote ?? {}, {
        pollEncKey: messageSecret,
        pollMsgId: pollMessageId,
        pollCreatorJid: stored.creatorJid,
        voterJid,
      });
    } catch (err) {
      this._logger.error("Failed to decrypt poll vote", err);
      return;
    }

    const optionByHash = new Map<string, string>();
    for (const option of stored.options) {
      const hash = createHash("sha256").update(option).digest("hex");
      optionByHash.set(hash, option);
    }

    const selectedOptions: string[] = [];
    for (const hashBytes of voteMsg.selectedOptions ?? []) {
      const name = optionByHash.get(Buffer.from(hashBytes).toString("hex"));
      if (name) selectedOptions.push(name);
    }

    const author = buildReactionAuthor(msg, this._socket?.user?.id);

    const vote: BaileysPollVote = {
      threadId,
      pollMessageId,
      question: stored.question,
      options: stored.options,
      selectedOptions,
      voter: author,
      raw: msg,
      metadata: stored.metadata,
    };

    for (const sub of this._pollVoteSubscriptions) {
      if (sub.filter && !sub.filter.has(pollMessageId)) continue;
      try {
        await sub.handler(vote);
      } catch (err) {
        this._logger.error("onPollVote handler threw", err);
      }
    }

    const text = selectedOptions.join(", ");
    const formatted = this._converter.toAst(text);
    const messageId = msg.key.id ?? generateMessageIDV2();

    this._chat.processMessage(this, threadId, async () =>
      new Message<WAMessage>({
        id: messageId,
        threadId,
        text,
        formatted,
        raw: msg,
        author,
        metadata: {
          dateSent: new Date(Number(msg.messageTimestamp ?? 0) * 1000),
          edited: false,
        },
        attachments: [],
      })
    );
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

function getParticipantForMessage(msg: WAMessage): string | undefined {
  const jid = msg.key.remoteJid ?? "";
  if (!isJidGroup(jid)) {
    return undefined;
  }

  return msg.key.participant ?? undefined;
}

function isReactionAdded(text: string | null | undefined): boolean {
  return (text ?? "").length > 0;
}

function buildReactionAuthor(
  msg: WAMessage,
  botUserId?: string
): Author {
  const jid = msg.key.remoteJid ?? "";
  const isGroup = isJidGroup(jid);
  const isMe = msg.key.fromMe ?? false;
  const userId = isMe
    ? (botUserId ?? "unknown@s.whatsapp.net")
    : isGroup
      ? (msg.key.participant ?? jid)
      : jid;

  return {
    userId,
    userName: msg.pushName ?? userId.split("@")[0],
    fullName: msg.pushName ?? "",
    isBot: false,
    isMe,
  };
}

function assertValidLatitude(latitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new ValidationError(
      "baileys",
      `sendLocation: latitude must be between -90 and 90. Received ${latitude}.`
    );
  }
}

function assertValidLongitude(longitude: number): void {
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new ValidationError(
      "baileys",
      `sendLocation: longitude must be between -180 and 180. Received ${longitude}.`
    );
  }
}

// ---------------------------------------------------------------------------
// Media payload helpers
// ---------------------------------------------------------------------------

type MediaSource = Buffer | { url: string };

type MediaPayload =
  | { text: string }
  | { image: MediaSource; mimetype?: string; caption?: string }
  | { video: MediaSource; mimetype?: string; caption?: string }
  | { audio: MediaSource; mimetype?: string; ptt?: boolean }
  | { document: MediaSource; mimetype?: string; fileName?: string; caption?: string };

function canCarryCaption(payload: MediaPayload): boolean {
  return "image" in payload || "video" in payload || "document" in payload;
}

/**
 * Call `socket.sendMessage` while omitting the options arg when not provided.
 * Keeps the call shape `(jid, payload)` in the common case so existing test
 * assertions (and Baileys' own argument handling) stay unchanged.
 */
async function sendOne(
  socket: WASocket,
  jid: string,
  payload: MediaPayload,
  options?: { quoted?: WAMessage }
): Promise<WAMessage | undefined> {
  const content = payload as Parameters<WASocket["sendMessage"]>[1];
  if (options) {
    return socket.sendMessage(jid, content, options);
  }
  return socket.sendMessage(jid, content);
}

function extractAttachments(message: AdapterPostableMessage): Attachment[] {
  if (typeof message === "string") return [];
  if ("attachments" in message && Array.isArray(message.attachments)) {
    return message.attachments;
  }
  return [];
}

async function buildMediaPayloads(
  message: AdapterPostableMessage
): Promise<MediaPayload[]> {
  const attachments = extractAttachments(message);
  const files = extractFiles(message);

  const payloads: MediaPayload[] = [];
  for (const att of attachments) {
    payloads.push(await attachmentToMedia(att));
  }
  for (const file of files) {
    payloads.push(await fileToMedia(file));
  }
  return payloads;
}

async function attachmentToMedia(att: Attachment): Promise<MediaPayload> {
  const source = await resolveAttachmentSource(att);
  switch (att.type) {
    case "image":
      return { image: source, mimetype: att.mimeType };
    case "video":
      return { video: source, mimetype: att.mimeType };
    case "audio":
      return { audio: source, mimetype: att.mimeType ?? "audio/ogg" };
    case "file":
    default:
      return {
        document: source,
        mimetype: att.mimeType ?? "application/octet-stream",
        fileName: att.name ?? "document",
      };
  }
}

async function fileToMedia(file: FileUpload): Promise<MediaPayload> {
  const buffer = await fileDataToBuffer(file.data);
  const mime = file.mimeType ?? "application/octet-stream";
  if (mime.startsWith("image/")) {
    return { image: buffer, mimetype: mime };
  }
  if (mime.startsWith("video/")) {
    return { video: buffer, mimetype: mime };
  }
  if (mime.startsWith("audio/")) {
    return { audio: buffer, mimetype: mime };
  }
  return { document: buffer, mimetype: mime, fileName: file.filename };
}

async function resolveAttachmentSource(att: Attachment): Promise<MediaSource> {
  if (att.data) {
    return fileDataToBuffer(att.data);
  }
  if (att.fetchData) {
    return await att.fetchData();
  }
  if (att.url) {
    return { url: att.url };
  }
  throw new ValidationError(
    "baileys",
    "attachment has no data, fetchData, or url to send"
  );
}

async function fileDataToBuffer(
  data: Buffer | Blob | ArrayBuffer
): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof (data as Blob).arrayBuffer === "function") {
    return Buffer.from(await (data as Blob).arrayBuffer());
  }
  throw new ValidationError(
    "baileys",
    "unsupported file data type — expected Buffer, ArrayBuffer, or Blob"
  );
}

function assertValidPoll(
  question: string,
  options: string[],
  selectableCount: number
): void {
  if (question.trim().length === 0) {
    throw new ValidationError("baileys", "sendPoll: question must not be empty.");
  }

  if (options.length < 2 || options.length > 12) {
    throw new ValidationError(
      "baileys",
      `sendPoll: WhatsApp polls require between 2 and 12 options. Received ${options.length}.`
    );
  }

  if (options.some((option) => option.trim().length === 0)) {
    throw new ValidationError(
      "baileys",
      "sendPoll: poll options must not be empty."
    );
  }

  if (!Number.isInteger(selectableCount) || selectableCount < 0) {
    throw new ValidationError(
      "baileys",
      `sendPoll: selectableCount must be an integer >= 0. Received ${selectableCount}.`
    );
  }
}
