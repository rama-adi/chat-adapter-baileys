# Changelog

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
