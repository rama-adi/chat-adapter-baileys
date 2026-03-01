# chat-adapter-baileys

WhatsApp (Baileys) adapter for the [Chat SDK](https://www.npmjs.com/package/chat).

This package lets you run Chat SDK bots on WhatsApp via Baileys.

## Install

```bash
pnpm add chat-adapter-baileys baileys chat
```

## Quick Start

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { useMultiFileAuthState } from "baileys";
import { createBaileysAdapter } from "chat-adapter-baileys";

const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

const whatsapp = createBaileysAdapter({
  auth: { state, saveCreds },
  userName: "my-bot",
  onQR: async (qr) => {
    const QRCode = await import("qrcode");
    console.log(await QRCode.toString(qr, { type: "terminal" }));
  },
});

const bot = new Chat({
  userName: "my-bot",
  adapters: { whatsapp },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.post(`Hello ${message.author.userName}`);
});

await whatsapp.connect();
```

## Multi-Account Support

Yes. Use one adapter instance per WhatsApp account, each with:

- separate Baileys auth state
- unique `adapterName`

```ts
const waMain = createBaileysAdapter({
  adapterName: "baileys-main",
  auth: mainAuth,
});

const waSales = createBaileysAdapter({
  adapterName: "baileys-sales",
  auth: salesAuth,
});

const bot = new Chat({
  userName: "my-bot",
  adapters: {
    whatsappMain: waMain,
    whatsappSales: waSales,
  },
  state: createMemoryState(),
});
```

`adapterName` is used for adapter identity and thread ID prefixing, preventing cross-account collisions in one Chat instance.

## Adapter Config

```ts
createBaileysAdapter({
  adapterName: "baileys", // default
  auth: { state, saveCreds }, // required
  userName: "baileys-bot",
  version: [2, 3000, 1015901307],
  onQR: async (qr) => {},
  phoneNumber: "12345678901", // E.164 without '+'
  onPairingCode: (code) => {},
  socketOptions: {},
});
```

## Behavior Notes

- Transport is WebSocket-based (`connect()`), not HTTP webhook-based.
- `handleWebhook()` always returns HTTP `501`.
- `fetchMessages()` / `fetchChannelMessages()` return empty arrays unless you build your own message store.
- Cards are sent as fallback plain text.
- Incoming media attachments include lazy `fetchData()`.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Docs

- [Quickstart](./docs/quickstart.md)
- [Runnable Example](./docs/example.ts)

## License

MIT
