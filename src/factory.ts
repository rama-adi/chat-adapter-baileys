import { BaileysAdapter } from "./adapter.js";
import type { BaileysAdapterConfig } from "./types.js";

/**
 * Create a WhatsApp (Baileys) adapter for Chat SDK.
 *
 * Auth is the caller's responsibility — obtain it with `useMultiFileAuthState`
 * or any compatible Baileys auth store, typically in a separate setup script.
 *
 * @example
 * ```typescript
 * import { useMultiFileAuthState } from "baileys";
 * import { createBaileysAdapter } from "chat-adapter-baileys";
 * import { Chat } from "chat";
 *
 * const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
 *
 * const adapter = createBaileysAdapter({
 *   auth: { state, saveCreds },
 * });
 *
 * const bot = new Chat({
 *   userName: "mybot",
 *   adapters: { whatsapp: adapter },
 *   state: myStateAdapter,
 * });
 *
 * bot.onNewMention(async (thread, message) => {
 *   await thread.post(`Hello, ${message.author.fullName}!`);
 * });
 *
 * await bot.initialize();
 * await adapter.connect();
 * ```
 */
export function createBaileysAdapter(
  config: BaileysAdapterConfig
): BaileysAdapter {
  return new BaileysAdapter(config);
}
