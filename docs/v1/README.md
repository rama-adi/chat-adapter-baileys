# chat-adapter-baileys v1 Documentation (Archived)

This is the documentation for `chat-adapter-baileys` v1.x. These docs are archived and no longer updated. For new projects, use [v2](../v2/README.md).

## Quick Links

- [Quickstart](./quickstart.md) — Install, configure, and run your first WhatsApp bot
- [Concepts](./concepts.md) — How Chat SDK concepts map to WhatsApp
- [Events and Lifecycle](./events-and-lifecycle.md) — Connection flow, auth, and reconnection
- [Thread IDs and Multi-Account](./thread-ids-and-multi-account.md) — Thread IDs and multiple accounts
- [Formatting and Media](./formatting-and-media.md) — Text formatting and file handling
- [Extensions](./extensions.md) — WhatsApp-specific features
- [Runnable Example](./example.ts) — Full working code

## v1 vs v2: Key Differences

| Feature | v1 | v2 |
|---------|-----|-----|
| **Extension Router** | `createBaileysExtensions()` for multi-account routing | Removed — use `requireBaileysAdapter(thread)` instead |
| **Dependency Versions** | `chat` `^4.0.0`, `@chat-adapter/*` `^4.0.0` | `chat` `^4.24.0`, `@chat-adapter/*` `^4.24.0` |
| **Reply Method** | `wa.reply(message, text)` | Same, but validates `message.threadId` and auto-marks read |
| **markRead** | `markRead(threadId, messageIds)` | Requires `participant` param for group messages |
| **Validation** | Loose input handling | Stricter validation (coordinates, poll options, etc.) |
| **Reactions** | Basic support | Full Chat SDK reaction event support |

## Should You Upgrade to v2?

**Stay on v1 if:**
- Your bot is working well and you don't need new features
- You rely on the `createBaileysExtensions()` router pattern
- You don't want to update dependency versions

**Upgrade to v2 if:**
- You're starting a new project
- You want cleaner multi-account patterns without a separate router
- You need better reaction handling
- You want stricter validation to catch bugs early

## Migration Guide

If you decide to upgrade, see the [v1 to v2 Migration Guide](../migration/v1-to-v2.md) for:
- Step-by-step upgrade instructions
- Code examples (v1 → v2 side-by-side)
- Breaking changes explained
- Migration checklist

## Status

v1 is in maintenance mode. Critical bug fixes may be backported, but new features will only be added to v2.
