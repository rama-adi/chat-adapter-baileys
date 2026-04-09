import { ValidationError } from "@chat-adapter/shared";
import { BaileysAdapter } from "./adapter.js";

/**
 * Type guard for narrowing a Chat SDK adapter to {@link BaileysAdapter}.
 *
 * @example
 * ```typescript
 * const adapter = thread.adapter;
 * if (isBaileysAdapter(adapter)) {
 *   await adapter.reply(message, "Got it!");
 * }
 * ```
 */
export function isBaileysAdapter(
  adapter: unknown
): adapter is BaileysAdapter {
  return adapter instanceof BaileysAdapter;
}

/**
 * Require that a Chat SDK context belongs to a {@link BaileysAdapter}.
 *
 * Accepts either an adapter directly or any object with an `adapter` property,
 * such as `Thread` and `Channel`.
 *
 * @example
 * ```typescript
 * const wa = requireBaileysAdapter(thread);
 * await wa.markRead(thread.threadId, [message.id]);
 * ```
 */
export function requireBaileysAdapter(
  value: unknown
): BaileysAdapter {
  const adapter = extractAdapter(value);
  if (isBaileysAdapter(adapter)) {
    return adapter;
  }

  throw new ValidationError(
    "baileys",
    "This context does not belong to a Baileys adapter."
  );
}

function extractAdapter(value: unknown): unknown {
  if (value && typeof value === "object" && "adapter" in value) {
    return (value as { adapter: unknown }).adapter;
  }
  return value;
}
