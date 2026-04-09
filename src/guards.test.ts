import { describe, expect, it } from "vitest";
import { BaileysAdapter } from "./adapter.js";
import { isBaileysAdapter, requireBaileysAdapter } from "./guards.js";

describe("Baileys adapter guards", () => {
  const adapter = new BaileysAdapter({
    auth: {
      state: { creds: {} as never, keys: {} as never },
      saveCreds: async () => {},
    },
  });

  it("isBaileysAdapter returns true for BaileysAdapter instances", () => {
    expect(isBaileysAdapter(adapter)).toBe(true);
  });

  it("isBaileysAdapter returns false for non-Baileys adapters", () => {
    expect(isBaileysAdapter({ name: "slack" })).toBe(false);
  });

  it("requireBaileysAdapter accepts a thread-like object with an adapter", () => {
    expect(requireBaileysAdapter({ adapter })).toBe(adapter);
  });

  it("requireBaileysAdapter accepts the adapter directly", () => {
    expect(requireBaileysAdapter(adapter)).toBe(adapter);
  });

  it("requireBaileysAdapter throws for non-Baileys contexts", () => {
    expect(() =>
      requireBaileysAdapter({ adapter: { name: "slack" } })
    ).toThrow(/Baileys adapter/i);
  });
});
