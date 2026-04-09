import { describe, expect, it } from "vitest";
import {
  BaileysAdapter,
  BaileysFormatConverter,
  createBaileysAdapter,
  isBaileysAdapter,
  requireBaileysAdapter,
} from "./index.js";

describe("index exports", () => {
  it("exports adapter class, factory, and guard helpers", () => {
    const adapter = createBaileysAdapter({
      auth: {
        state: { creds: {} as never, keys: {} as never },
        saveCreds: async () => {},
      },
    });

    expect(adapter).toBeInstanceOf(BaileysAdapter);
    expect(BaileysFormatConverter).toBeTypeOf("function");
    expect(isBaileysAdapter(adapter)).toBe(true);
    expect(requireBaileysAdapter({ adapter })).toBe(adapter);
  });
});
