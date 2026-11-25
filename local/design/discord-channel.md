# A Discord channel for bots, with no Orca account

**Status:** design note, 2026-11-25. **v1 built on `nplez1/bot-discord`** — the protocol layer, store, inbound
and outbound paths, RPC and settings card are in `src/main/bots/discord-direct/`. **Live validation against
Discord has not been performed**: the account, gateway and REST are exercised by fakes and by the protocol
tables in this note's sources, not against a real bot token. Read § "What is not proven" before trusting it
for anyone's real bot.
**Why:** Slack, Linear and GitHub all route through Orca Cloud, so a host signed out of it cannot be talked
to at all. `imessage-channel.md` answered that for one channel with the owner's own Photon credentials. This
picks the second: Discord, because a bot connects **outbound** over its gateway WebSocket, so it needs no
public endpoint, no tunnel and no relay — the same reason the fork could ship Photon without a server of its
own.
**Placement:** fork patch (`local(bots)`), all new code. Upstream may later ship a cloud Discord connector;
everything here is self-contained under a `discord-direct` name so a sync collides in as few lines as
possible.

## The doctrine this follows

`talking-to-bots.md` splits identity into **authority** and **attribution**. Discord gets both the way that
note argues for:

- **Authority is the owner's.** The bot runs turns under the bot's permission mode, acting as whoever asked,
  exactly as it does when woken from any other channel. A Discord user cannot make it carry ambient
  authority it does not already have.
- **Attribution is the bot's.** Messages are authored by the Discord application the owner created, not by
  Orca and not by the owner's personal account. The owner's Discord account need not exist.

There is no Orca Cloud anywhere in the path: the token is the owner's, stored on the owner's machine, and
the connection leaves that machine.

## The shape

```
owner pastes a bot token  ──▶  sealed in userData/local-discord/discord-secrets.json
                                        │
                       outbound wss (gateway)  ◀── no listening port
                                        │
   Discord MESSAGE_CREATE  ──▶  inbox claim ──▶ bot turn ──▶ outbox ──▶ REST POST message
```

- **One Discord channel id is one bot chat.** A DM is its own chat. A mention in a text channel starts a
  thread and that thread is the chat. The model is Photon's thread map with channels instead of phone
  numbers.
- **Who can ask is Orca's list, not Discord's.** Discord has no per-bot allowlist: anyone in a server can
  mention the bot. `BotMemberSchema` with `source: 'discord'` is the only gate, matched by **user id**, never
  by display name.
- **The bot ignores itself, other bots and webhooks**, and `@everyone`/role mentions never trigger it. Every
  send carries `allowed_mentions: { parse: [] }`, so an answer cannot mass-ping a server.

## Why it is hand-rolled on `ws`

`ws` is already a dependency, already a packaged runtime root, and already used in main. `discord.js` would
add `@discordjs/ws`, `@discordjs/rest`, `undici` and optional native codecs — each another packaged root,
and a release has already broken once on a missing root. It also caches every guild in memory. The protocol
this needs is a state machine of about 350 lines: heartbeat with jitter and zombie detection, identify with
three non-privileged intents, resume with a sequence number, and a close-code table.

## Deliberate v1 scope

**In:** DMs from a member; messages in a thread the bot already started; one answer per turn, chunked at
Discord's content limit with code fences closed and reopened; `orca bot reply`; the owner's card to invite,
replace the token and disconnect.

**Out, each for a reason:**

- **Server-wide answers.** Off by default (`answerInServers`), because a bot in a server is public by
  construction and the fork's privacy default is the opposite.
- **The `MESSAGE_CONTENT` privileged intent.** It requires an approved application and its absence means
  Discord blanks message content the bot was not mentioned in. Requiring it would make setup a review queue
  instead of a paste, and `4014` would be the commonest first-run failure. The cost is real and stated in
  the card: **a follow-up in a thread has to mention the bot.**
- **Voice, slash commands, interactions.** All need either an HTTP endpoint (which this channel exists to
  avoid) or an interaction-token flow.
- **Streaming an answer by editing one message.** Edits are tightly rate-limited per channel and fight with
  chunking.
- **Inbound attachments.** Noted in the transcript as present-but-unread rather than silently dropped.

## Failure behaviour

| Case                    | Behaviour                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Token rejected (`4004`) | gateway stops, zero retries, card says so; the issued token must be reset in the portal            |
| `401` from REST         | same — never retried, because retrying is how an IP gets banned                                    |
| `403`                   | that send is parked, not retried                                                                   |
| `429`                   | wait `ceil(retry_after × 1000)`; a `global` 429 blocks every route for that token                  |
| Gateway zombie (no ACK) | close with 4000 and **resume**, never re-identify — the identify budget is 1000/day                |
| Mid-turn disconnect     | does not affect the turn, which runs in Orca; the answer waits in the outbox                       |
| Host asleep             | messages are not delivered; a message that starts a new conversation is lost, and the card says so |
| Bot deleted             | gateway stops, token and inbox removed; the Discord application is left alone, as the card says    |

## Security

- **No new listening port.** Every connection is outbound over TLS.
- **A stolen token** lets an attacker post as the bot and read mentions and DMs in every server it was
  invited to. It gives no path into Orca. Bounds: the invite asks for the minimum permissions (view, send,
  create thread, read history, attach files), and without the content intent Discord blanks other messages
  even in REST history. Resetting the token in the portal ends it immediately.
- **Never logged:** the token, the Authorization header, identify/resume payloads, `session_id`, raw frames,
  or message text. Every log line goes through a token-shaped redactor.
- **What a Discord user can do** is what any member of the who-can-ask list can do. The list and the channel
  settings are owner-only, so a prompt-injected turn cannot widen them.
- **The same token on two hosts answers twice.** Discord delivers every event to every session, and the
  token is host-local, so there is no protocol-level fix — the card names which computer answers.

## What is not proven

This is the honest part, and it is why this note exists rather than a paragraph in the ledger.

- No bot token was available, so **no live handshake, no real MESSAGE_CREATE, no real rate-limit response**
  was observed. The gateway state machine is tested against a scripted socket, the REST client against a fake
  `fetch`, and the protocol constants are transcribed from Discord's own documentation, not from a capture.
- The multipart upload framing is the documented field shape but was not exercised against Discord.
- Permission scopes and the invite URL were built from the documented permission bits.

So: the parts that can be checked locally are checked, and the parts that cannot are named. The first real
run should be a throwaway bot on a private server, doing four things — DM it; mention it in a channel and
watch the thread; reply; reset the token and watch the card say it is invalid.

## Sources

Discord's API documentation, vendored for this work rather than recalled: the gateway event reference,
gateway lifecycle, opcodes and status codes, rate limits, the message resource and the channel resource. The
protocol tables in `discord-contract.ts` cite the page each value came from.
