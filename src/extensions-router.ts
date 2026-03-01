import { ValidationError } from "@chat-adapter/shared";
import type { Message, RawMessage } from "chat";
import type { WAMessage } from "baileys";
import type { BaileysAdapter } from "./adapter.js";
import type { BaileysGroupParticipant } from "./types.js";

/**
 * Creates a router that forwards extension calls to the correct adapter
 * instance based on the thread ID prefix, removing the need to track which
 * adapter owns which conversation in multi-account setups.
 *
 * For single-account setups, call extension methods directly on the adapter.
 *
 * @example
 * ```typescript
 * const wa = createBaileysExtensions(waMain, waSales);
 *
 * bot.onSubscribedMessage(async (thread, message) => {
 *   await wa.reply(message, "Got it!"); // routes to the right account automatically
 * });
 * ```
 */
export function createBaileysExtensions(...adapters: BaileysAdapter[]) {
  const byName = new Map(adapters.map((a) => [a.name, a]));

  function resolve(threadId: string): BaileysAdapter {
    const name = threadId.split(":")[0];
    const adapter = byName.get(name);
    if (!adapter) {
      throw new ValidationError(
        "baileys",
        `createBaileysExtensions: no adapter registered for "${name}". ` +
          `Registered: ${[...byName.keys()].join(", ")}`
      );
    }
    return adapter;
  }

  return {
    async reply(message: Message<WAMessage>, text: string): Promise<RawMessage<WAMessage>> {
      return resolve(message.threadId).reply(message, text);
    },

    async markRead(threadId: string, messageIds: string[]): Promise<void> {
      return resolve(threadId).markRead(threadId, messageIds);
    },

    /** Sets presence on all registered adapters. */
    async setPresence(presence: "available" | "unavailable"): Promise<void> {
      await Promise.all(adapters.map((a) => a.setPresence(presence)));
    },

    async sendLocation(
      threadId: string,
      latitude: number,
      longitude: number,
      options?: { name?: string; address?: string }
    ): Promise<RawMessage<WAMessage>> {
      return resolve(threadId).sendLocation(threadId, latitude, longitude, options);
    },

    async sendPoll(
      threadId: string,
      question: string,
      options: string[],
      selectableCount?: number
    ): Promise<RawMessage<WAMessage>> {
      return resolve(threadId).sendPoll(threadId, question, options, selectableCount);
    },

    async fetchGroupParticipants(threadId: string): Promise<BaileysGroupParticipant[]> {
      return resolve(threadId).fetchGroupParticipants(threadId);
    },
  };
}
