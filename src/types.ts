import type { Author, Logger } from "chat";
import type { AuthenticationState, WAMessage, WAVersion } from "baileys";

/** Decoded thread ID components for WhatsApp (Baileys) */
export interface BaileysThreadId {
  /** WhatsApp JID, e.g. "15551234567@s.whatsapp.net" or "123456789@g.us" */
  jid: string;
}

/** A participant returned by {@link BaileysAdapter.fetchGroupParticipants} */
export interface BaileysGroupParticipant {
  /** The participant's JID, e.g. `"15551234567@s.whatsapp.net"` */
  userId: string;
  /** True for both admin and super-admin roles */
  isAdmin: boolean;
  /** True only for the group creator (super-admin) */
  isSuperAdmin: boolean;
}

/**
 * Decrypted poll vote delivered to {@link BaileysAdapterConfig.onPollVote}.
 *
 * WhatsApp poll votes are end-to-end encrypted; the adapter tracks each poll
 * sent via {@link BaileysAdapter.sendPoll} (using the Chat SDK's `StateAdapter`
 * for persistence) and decrypts incoming `pollUpdateMessage` events back into
 * the option names the voter selected.
 *
 * `selectedOptions` is empty when the voter cleared their vote.
 */
export interface BaileysPollVote {
  /** Encoded thread ID where the poll lives */
  threadId: string;
  /** Message ID of the original poll the bot sent */
  pollMessageId: string;
  /** Original poll question */
  question: string;
  /** Original poll options (in send order) */
  options: string[];
  /** Option names the voter currently has selected (empty = vote cleared) */
  selectedOptions: string[];
  /** Author info for the voter */
  voter: Author;
  /** Raw Baileys vote message */
  raw: WAMessage;
  /**
   * Arbitrary metadata supplied to {@link BaileysAdapter.sendPoll}. Persisted
   * alongside the poll's decryption state and round-tripped unchanged to every
   * vote on that poll. `undefined` when no metadata was provided.
   */
  metadata?: unknown;
}

/** Configuration for the Baileys adapter */
export interface BaileysAdapterConfig {
  /**
   * Adapter identity used by Chat SDK serialization and thread ID prefixes.
   *
   * For multi-account deployments in a single `Chat` instance, set a unique
   * value per account (for example: `"baileys-main"` and `"baileys-sales"`).
   *
   * Must not contain `:` because thread IDs use `name:encodedJid` format.
   * Defaults to `"baileys"`.
   */
  adapterName?: string;

  /**
   * Baileys authentication state.
   * Obtain this via `useMultiFileAuthState` or a custom auth store
   * — typically in a separate setup script.
   *
   * @example
   * ```typescript
   * import { useMultiFileAuthState } from "baileys";
   * const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
   * const adapter = createBaileysAdapter({ auth: { state, saveCreds } });
   * ```
   */
  auth: {
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  };

  /**
   * WhatsApp Web version to use.
   * Auto-fetched via `fetchLatestBaileysVersion()` if not provided.
   */
  version?: WAVersion;

  /** Bot display name (defaults to "baileys-bot") */
  userName?: string;

  /** Logger instance */
  logger?: Logger;

  /**
   * Called when a QR code string is emitted during initial connection.
   * Convert it to an image or terminal output with a library like `qrcode`.
   *
   * @example
   * ```typescript
   * import QRCode from "qrcode";
   * onQR: async (qr) => console.log(await QRCode.toString(qr, { type: "terminal" }))
   * ```
   */
  onQR?: (qr: string) => void | Promise<void>;

  /**
   * Phone number for pairing-code login (alternative to QR scanning).
   * Must be in E.164 format **without** the leading `+`.
   *
   * Example: `+1 (234) 567-8901` → `"12345678901"`
   *
   * When set, the adapter calls `sock.requestPairingCode()` as soon as
   * the socket begins connecting, and invokes `onPairingCode` with the result.
   */
  phoneNumber?: string;

  /**
   * Called with the 8-character pairing code when `phoneNumber` is set.
   * Display or forward this code so the user can enter it in WhatsApp.
   *
   * @example
   * ```typescript
   * onPairingCode: (code) => console.log("Enter this code in WhatsApp:", code)
   * ```
   */
  onPairingCode?: (code: string) => void;

  /**
   * Additional Baileys socket options passed directly to `makeWASocket`.
   * `auth` and `version` are managed by the adapter.
   */
  socketOptions?: Record<string, unknown>;

  /**
   * TTL (milliseconds) for stored poll metadata in the SDK's `StateAdapter`.
   * Defaults to 30 days. Pass `0` to keep entries until explicitly evicted.
   */
  pollTtlMs?: number;
}

/** Handler signature for poll vote subscriptions. */
export type BaileysPollVoteHandler = (
  vote: BaileysPollVote
) => void | Promise<void>;

/**
 * A poll the adapter is currently tracking — i.e. one previously sent via
 * {@link BaileysAdapter.sendPoll} whose decryption metadata is still stored
 * in the SDK's `StateAdapter`.
 *
 * Use {@link BaileysAdapter.listTrackedPolls} on startup to re-register
 * per-poll handlers (`onPollVote(pollId, handler)`) after a process restart.
 */
export interface BaileysTrackedPoll {
  /** Message ID of the original poll. Pass to `onPollVote(pollId, handler)`. */
  pollMessageId: string;
  /** Encoded thread ID where the poll lives. */
  threadId: string;
  /** Original poll question. */
  question: string;
  /** Original poll options (in send order). */
  options: string[];
  /** Arbitrary metadata supplied to {@link BaileysAdapter.sendPoll}. */
  metadata?: unknown;
}

/** Options for {@link BaileysAdapter.sendPoll}. */
export interface BaileysSendPollOptions {
  /**
   * Arbitrary, opaque metadata to associate with this poll. Persisted in the
   * SDK's `StateAdapter` alongside the poll's decryption state and round-tripped
   * unchanged to every {@link BaileysPollVote} on this poll. Useful for
   * app-specific context (e.g. "askedBy" user id, quiz id, correlation id).
   */
  metadata?: unknown;
}
