import { describe, expect, it } from "vitest";
import { BaileysAdapter } from "./adapter.js";
import { createBaileysAdapter } from "./factory.js";

describe("createBaileysAdapter", () => {
  it("creates a BaileysAdapter instance", () => {
    const adapter = createBaileysAdapter({
      auth: {
        state: { creds: {} as never, keys: {} as never },
        saveCreds: async () => {},
      },
    });

    expect(adapter).toBeInstanceOf(BaileysAdapter);
    expect(adapter.name).toBe("baileys");
  });
});
