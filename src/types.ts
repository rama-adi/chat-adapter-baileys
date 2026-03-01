import type { Logger } from "chat";
import type { AuthenticationState, WAVersion } from "baileys";

/** Decoded thread ID components for WhatsApp (Baileys) */
export interface BaileysThreadId {
  /** WhatsApp JID, e.g. "15551234567@s.whatsapp.net" or "123456789@g.us" */
  jid: string;
}

/** Configuration for the Baileys adapter */
export interface BaileysAdapterConfig {
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
}
