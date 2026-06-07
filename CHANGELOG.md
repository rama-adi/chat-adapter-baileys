# Changelog

## 2.1.0-beta.4 - 2026-06-07

### Fixed

- Split Baileys' paired-account `fromMe` flag from Chat SDK's bot-authored `author.isMe` semantics.
- Preserve WhatsApp/Baileys `fromMe` as `message.metadata.fromMe` while only marking adapter-sent message echoes as `author.isMe` / `author.isBot`.
- Track generated Baileys message IDs before sending so adapter-sent echoes are recognized reliably and Chat SDK can continue filtering self messages centrally.
- Apply the same adapter-authored identity handling to reaction and poll-vote authors.

### Documentation

- Updated the v2 Concepts guide to document the `fromMe` / `author.isMe` distinction.
- Clarified examples that `message.author.isMe` filters messages posted by this adapter, not every message sent from the paired phone.

##  2.1.0-beta.3 - 2026-06-02
Mitigates the Baileys spoofing vulnerability reported in #5 by raising the Baileys dependency floor to >=7.0.0-rc13 <8.

This pulls patched Baileys versions transitively while still allowing compatible newer Baileys 7 versions to be resolved by downstream installs.



## 2.1.0-beta.2 - 2026-04-22

### Added

- Added named-argument overloads for `markRead`, `sendLocation`, and `sendPoll`.
- Added exported argument types:
  - `BaileysMarkReadArgs`
  - `BaileysSendLocationArgs`
  - `BaileysSendPollArgs`
- Added compatibility tests covering both object-style and positional extension calls.

### Deprecated

- Deprecated positional arguments for `markRead(threadId, messageIds, participant?)`.
- Deprecated positional arguments for `sendLocation(threadId, latitude, longitude, options?)`.
- Deprecated positional arguments for `sendPoll(threadId, question, options, selectableCount?, sendOptions?)`.
- Marked the positional overloads with `@deprecated` in the TypeScript surface.
- Documented that positional extension arguments will be removed in the next major version.

### Documentation

- Updated the v2 extension docs to recommend labeled object arguments throughout.
- Updated migration guidance to show the object form for v2 usage while preserving v1 examples as historical context.
- Updated v2 error-handling examples and the README support table to reflect the object-style API.

### Notes

- Existing positional calls still work in `2.1.0-beta.2` for backwards compatibility.
- `reply(...)`, `setPresence(...)`, and other unchanged adapter methods keep their current signatures.
