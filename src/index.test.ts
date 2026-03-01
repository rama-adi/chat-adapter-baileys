import { describe, expect, it } from "vitest";
import {
  BaileysAdapter,
  BaileysFormatConverter,
  createBaileysAdapter,
} from "./index.js";

describe("index exports", () => {
  it("exports adapter class and factory", () => {
    const adapter = createBaileysAdapter({
      auth: {
        state: { creds: {} as never, keys: {} as never },
        saveCreds: async () => {},
      },
    });

    expect(adapter).toBeInstanceOf(BaileysAdapter);
    expect(BaileysFormatConverter).toBeTypeOf("function");
  });
});
