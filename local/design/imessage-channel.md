# iMessage via Photon: the chat channel

**Status:** design note, 2026-11-21. Nothing built. Companion to `talking-to-bots.md`.
**Why:** that note names the gap — no third-party conversational channel — and stops at "pick one". This one
picks it. The owner already talks to Hermes this way, so the channel is the one actually in use: it is on
every device, needs no new app, and no one has to be persuaded to install anything.
**Placement:** fork patch, all of it new code. There is no Photon or iMessage code anywhere in Orca today —
the import guide can only *name* an `imessage` channel it cannot bring over
(`skill-guides/orca-cli/references/bot-import.md:85` lists Telegram/WhatsApp/Discord as "not available here
yet"; iMessage is in the same hole).

## What Photon actually is (verified against Hermes' own integration)

This is the fact the whole design hangs on: **Photon is an outbound persistent connection, not a webhook.**

| Property | Detail |
|---|---|
| Inbound | `spectrum-ts` holds a long-lived **gRPC stream**; no webhook URL, no public endpoint, no signing secret. Works behind NAT. |
| Hermes' shape | a supervised **Node sidecar** over loopback (Hermes is Python, so the TS SDK needs a separate process) |
| Credentials | `PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET` for a Spectrum project |
| Account | a Photon account (app.photon.codes) plus a phone number — **not** an Orca account |
| The bot's number | Photon assigns a line; users text *that*, not the owner's number. Free tier: shared pool (different recipients may see different numbers, each conversation stable); Business: dedicated number |
| Chats | DMs and groups; groups opt-in via mention patterns |
| Access control | an allowed-users list, or pair-by-code, with allow-all explicitly off |

Two consequences matter here:

1. **It fits this fork's only hard constraint** — no public inbound endpoint. Photon is the same shape as
   the loopback designs already planned: an outbound connection, a local decision.
2. **The bot gets its own identity.** A Photon line is a number of its own, so texting the bot is a
   conversation with Scout, not with yourself. That is the thing GitHub could not give at work
   (`talking-to-bots.md` § GitHub identity), and it comes free here.

## Routing: which bot gets the message

Orca already has the shape for this, and Photon's line model turns out to make the choice for us. What decides
it is **which Photon project** a message belongs to, not which number it was sent to.

### What "shared" means, and what the key actually is

"Shared pool" does not mean the number is a broadcast address. It means the number is **not globally unique** —
afternoon traffic across thousands of tenants is why the old architecture "re-deriv[ed] event ownership on
every delivery". Resolution happens per message, and a message from a user of your account reaches **your**
bots, not anyone else's.

The routing key is a **pair, scoped to the account**: *(the pool number the message arrived on, the sender's
handle)*. The sender half cannot be skipped, because on the shared pool only **phone-number** senders route at
all — an Apple-ID **email** handle gets an automatic "can't route" reply. That pair is also why a number may
differ per recipient while staying stable within one conversation: the allocation is what makes the pair unique.

Two things follow, and both are what the UI needs:

- **The number is usable as the bot's identity for a given person.** Save it once and that thread keeps working.
- **The number is observable, not configured.** `imessage(space).phone` reports the number handling a
  conversation, so settings can show what Photon actually routed instead of a typed-in field.

What the number does *not* do on its own is distinguish bots. That is decided by how the binding is configured
in your Photon account, which leaves one question with one dashboard answer.

### A. One binding per bot — the default

A Photon project is a real endpoint: its own `projectId`/`projectSecret`, its own token discovery, its own
inbound stream. With one bot per project the message lands on exactly one stream, so nothing has to be
dispatched.

That is also exactly Orca's connector model, where `slackApps[]`, `linearWorkspaces[]`, `github` and
`google` are all **fields on the bot record**:

```text
bot.photon = { projectId: 'pho_prj_…' }   // secret in the secure store, keyed by bot id
```

**The deciding fact is settled by the provisioning API, not by a dashboard check.** A shared-line
*assignment* is created per **(project, sender handle)** and returns that project's number for that person
(`photon.projects.platforms.imessage.assignments.create({ path: { id }, body: { handle } })` →
`assignedPhoneNumber`), and "only messages from the assigned sender reach this shared-line connection". So one
bot = one project = one number, and two bots give the same person two numbers — which is the provider's own
model, not something Orca has to invent. See *Provisioning from Orca* below for the calls.

### B. One number, several bots — no longer a co-equal model

Now that a number is assigned per project rather than shared by hand, running several bots behind one number is
the shape that costs extra work: one assignment, one stream, and Orca dispatching inside it. It is still worth
specifying because it is what a *single* number forces, not because the provider nudges you towards it.

| Piece | Where it already is |
|---|---|
| Several bots in one conversation, each with its own session and transcript | `BotGroup` — `members`, `threads`, own hidden home folder (`bot-group-schema.ts`) |
| Who was addressed | `botGroupMentions()` — `@name` / `@everyone`, ignores code and quoted prose, reports `match: 'ambiguous'` rather than guessing (`bot-group-mentions.ts`) |
| What an unaddressed message does | `replyMode: { kind: 'bot', botId } \| { kind: 'all' } \| { kind: 'mentions' }` (`bot-group-schema.ts:8`) |

**This is a DM room, not an iMessage group chat.** Group creation is not merely unreported on Free/Pro, it is
unavailable — `space.create()` with several users throws `UnsupportedError`, and Group Messaging is a Business
feature. So Model B is "one conversation, several bots, `@name` decides", mapped by
`photonConversationId → groupId`.

Both models rest on the same observation, which is what makes the choice cheap to defer: **the number is the
conversation; Orca's job is deciding who answers inside it.**

### Where the boundary sits

| Thing | Level | Why |
|---|---|---|
| Photon **project** (id + secret) | bot | the endpoint that receives; one per bot by default |
| **Number** (the pool line) | conversation | the address a person texts; observed per conversation via `imessage(space).phone` |
| Photon **user list** (10 on Free) | account | metered upstream of Orca — see access control |
| Who may ask | bot | the existing Who-can-ask list, mirrored rather than duplicated |

Adding a second bot never means buying a second line, and never means a second number to hand out.

### What choosing looks like

The iMessage row is not a form: it is a **Connect** button once (account key, stored only if the user opts in),
then a **Create** button on each bot that makes the project, mints its key, assigns its number and reports the
number back in one step — retryable, because every call is idempotent. The row then shows the number this bot
last answered on, read from the SDK rather than typed in, with "save this contact" beside it. Where one number
serves several bots, the owner creates a room, picks its members and the reply mode — the group UI that already
exists. `orca bot connectors` lists it, so a bot can tell its owner what it is reachable on.

### Edge cases the model already covers

- A **paused bot** holds its mail rather than answering (`bot-paused-mail.ts`).
- An **unknown sender** files one access request; it never becomes an instruction — *on tiers where Orca sees
  the sender at all* (Photon's user list may refuse them first; that is one of the open questions).
- A **deleted bot** drops its project binding with it — the binding is fork-owned state beside the bot, not
  inside Photon.

## Provisioning from Orca

The whole setup is API-driven in **Beta (2.0)** — `https://api.photon.codes/v1`, client `@photon-ai/api` — which
is what turns "paste a project key" into "connect once, then create a bot". Four endpoints, each idempotent:

| Step | Call | Credential | Idempotency |
|---|---|---|---|
| Create the agent (a project) | `POST /v1/organizations/{organizationId}/projects` | **account service key** (`pho_ask_…`) — "Project API keys cannot create projects"; Service Identity keys and M2M tokens may also create | caller-chosen **slug is immutable** and can never be reused by an active *or deleted* project, so it is the natural key — and a one-way door |
| Mint that bot's key | create project API key | account key, at provisioning time | required `Idempotency-Key`; the secret is returned **only here and on idempotent replay** |
| Give it a number | `…imessage.assignments.create({ body: { handle } })` | project key with `platforms:write` | `Idempotency-Key` |
| Admit another person | same call, that person's handle | project key `platforms:write` | `Idempotency-Key` per handle |
| Delete the agent (explicit cleanup only) | `DELETE /v1/projects/{projectId}`, then `getProjectClosureStatus` | **account key** — "a project API key is not an accepted credential" | required `Idempotency-Key`; deletion is asynchronous |

Every request pins `Photon-Version` (the API contract date, served as `2026-07-01` when omitted) so a contract
bump cannot change behaviour under a shipped build.

Three facts that shape the code more than the happy path:

- **The account key can mint keys.** `POST /v1/account/service-keys` accepts "an account access token **or an
existing account service key"`, so provisioning is unattended after one manual key creation — the user pastes
one key once, and nothing later needs a dashboard session. Keys need an explicit expiry and cannot be read back.
- **The organization id is a second id.** Project creation is scoped to it, so Orca stores `{ organizationId,
accountKey }` for the host and `{ projectId, slug, key }` per bot.
- **Deletion burns the slug forever.** A slug "cannot be reserved or held by any active or deleted project",
  which makes delete-and-recreate impossible under the same name and turns the teardown default around: releasing
  the assignment is reversible, deleting the project is not.

That last row is the important simplification: **"who can message this bot" and "assign its number" are the same
endpoint.** The assignment list *is* the allowlist, so Orca's Who-can-ask stops being a second ACL to be kept in
sync and becomes a UI over the provider's own records — the earlier worry about running two ACLs dissolves.

**Slug discipline.** Create the project with a deterministic slug such as `orca-bot-scout` (3–63 lowercase
alphanumerics, single separators), so a retried provisioning finds the existing project instead of silently
creating a second one that consumes plan capacity and produces a second number. Bot names that do not fit get
normalised, and the chosen slug is stored beside the bot rather than re-derived.

**Two credentials, two blast radii.** The account service key can create projects and mint keys — it is the
dangerous one, needed only while provisioning. The per-bot project key holds one project's number and messages
and is revocable on its own. So:

- the account key is **opt-in to store** (a toggle, not a default), because the alternative to storing it is
  re-pasting it for each new bot;
- each bot stores only its own project key, in the same secure store and file discipline as its Slack tokens;
- losing a project key is *recoverable but not readable* — mint a replacement and revoke the old, which is the
  flow the UI has to offer instead of a "show key" affordance.

**Provisioning is a saga, because each step can half-succeed.** Project created but key mint failed; key minted
but the assignment failed on plan capacity; assignment succeeded but Orca died before persisting the number. Every
step is idempotent and the number comes back on replay, so the fix is a **reconciler** that reads state back
(`platforms:read`, `project:read`) and repairs the record — not a rollback, which would delete a resource that
cost the user capacity.

**Deleting a bot must not silently delete a Photon project.** It *can* — `DELETE /v1/projects/{id}` exists,
needs the account key, runs asynchronously (`getProjectClosureStatus`), and ends with a final invoice — but it is
the one irreversible step: the slug is burned for every future project, and the assignment that came with it
cannot be rebuilt under the same name. So the default stays **release the assignment and revoke the key**, with
project deletion offered as a separate, explicitly confirmed cleanup that says what it costs.

**What stays manual, stated honestly:** exactly one thing — creating the first account service key, because
Photon only mints it from a dashboard session or an existing one. After that, each bot is a row with a Create
button. That is the whole promise, and it is worth making the UI say it that plainly.

**Version decision, and it is now forced.** Provisioning exists in Beta (2.0); Stable's SDK has no project or
assignment API — only CLI commands (`photon spectrum users`, `photon spectrum lines`). Beta is labelled a preview
and lacks Stable's tapbacks, polls and message effects, none of which a bot reply needs. So: **one version,
Beta, for both provisioning and the message stream** — mixing a Beta provisioning client with a Stable streaming
client would mean two auth schemes (Bearer vs Basic) and two contracts for the same conversation.

## What the limits force

Two products document limits, and conflating them is how a design gets the wrong ceiling. Everything below is
attributed to the page it came from, because the two disagree.

**On Beta (what this design builds on):**

| Limit | What it counts | Consequence |
|---|---|---|
| **25 shared iMessage assignments per project** (Free; 100 Pro) | the sender-per-project assignments above; included in the plan | **per project**, so ten people across five bots is ten assignments *in each project* — not fifty against one pool. Bots do not compete for headcount |
| **No per-message iMessage usage fee** | "Photon does not charge per-message usage fees for iMessage, WhatsApp, or Telegram sends" | there is no message budget to ration. Batching stays, as hygiene rather than as a quota |
| **Group Messaging API: No** (Free and Pro) | group creation and the group-event stream | a multi-bot iMessage *group chat* needs Business; a DM room (Model B) does not |
| **Dedicated lines: 50 per project maximum** (Business) | $250/line/month, and auto-release on downgrade | irrelevant unless a stable, user-chosen number ever matters |

**On Stable (the SDK path this design deliberately does *not* use):** 5,000 messages per server per day
(rejected past the limit), 50 new conversations per line per day, and "up to 10 users". Those are the numbers
quoted earlier in this doc's history, and they describe the product we are not integrating: Stable meters users
and sends, Beta meters assignments per project and charges nothing per iMessage send.

What still bites during setup rather than in steady state:

- **A newly assigned number's inbound is not immediate.** The line is learned from credentials minted on a
  schedule, so "create the project, text it now" can silently receive nothing for one renewal window. The setup
  copy has to say so, and a restart is the fix.

**What follows, as rules:**

1. **One send per finished turn**, never one per agent event or progress tick — not because a quota demands it,
   but because twenty messages per turn is a worse experience than one, and long output belongs in one attachment.
2. **No host-wide message counter.** The 5,000/day budget that justified it is Stable's, not Beta's; adding that
   machinery now would encode a limit this path does not have. Revisit only if the integration moves to Stable.
3. **Orca never cold-starts a conversation.** Inbound opens every conversation; replies ride it.
4. **The tier is visible in the UI**, because no groups, and a per-project assignment count, are properties of the
   plan rather than of the channel.

Self-hosting remains the escape hatch, but the cap it escapes has changed: on Beta the binding limit is
assignments per project and the group API, not a user count.

## Architecture: no sidecar

Hermes needs a sidecar because Python cannot host the TS SDK. **Orca's main process is Node already**, so
the fork can hold the stream in-process: no second process, no loopback hop, no NDJSON protocol, no
supervision.

The one thing to verify before committing to that: whether the SDK pulls a native gRPC binding or
`@grpc/grpc-js`. `grpc-js` is pure JavaScript and packages into Electron cleanly; a native binding means
`electron-rebuild`, asar unpacking and three platforms of pain — and *then* the sidecar is the better
answer, using the Node runtime Orca already ships (`orcad`).

**Committing to Beta answers this too:** the Beta transport is Socket.IO over HTTP with cursors, not gRPC, and
the provisioning API is plain HTTPS. Both are pure-JS, so the in-process route stops being conditional — the
native-binding risk was a property of the Stable SDK, which this design no longer uses.

| Route | When it wins | Cost |
|---|---|---|
| **In-process** (chosen) | on a pure-JS client, and Beta is one | a new dependency in the app bundle |
| Sidecar | native gRPC (Stable's path), or a stream that crashes main | a process to supervise, a loopback protocol, and the same failure surface the webhook listener already has |

## Offline delivery: answered, and it is good news

The question that mattered was what happens to a message sent while Orca is closed. **Photon retains events
and replays them from a cursor**, so the answer is: it is delivered on reconnect, within retained history.
The Beta API documents this precisely (`docs.photon.codes/docs/beta/websocket/cursors.md`, *Cursors, replay,
and checkpointing*):

| Rule | What it means for the fork |
|---|---|
| `startSeq: 0` starts with **new** events only; a positive `startSeq` resumes **after** that cursor | a first-ever start deliberately skips history; a resume passes the last processed cursor as-is, never `+1` |
| Cursors are **opaque non-negative safe integers, and may contain gaps** | never do arithmetic on them; never assume the next one is `last + 1` |
| **Persist a cursor only after its handler succeeds**; on failure stop the stream and resume from the last successful checkpoint | advancing on receipt is a data-loss bug: a crash between receipt and a finished turn would skip the work permanently |
| Store them **per project and per consumer purpose** | an independent integration must not overwrite this one's progress |
| Replay is **limited to retained history**; it is "not an unlimited archive", and **not an exactly-once guarantee** | dedupe by message id is mandatory, and a long outage is a gap |

### The design that follows from it

Two stores, and the split is the whole point:

1. **Orca's inventory** — the message payload, written before any turn starts, keyed by message id. This is the
   crash guard and the dedupe index: a replay of a message you already have is a no-op.
2. **Photon's cursor** — advanced only once the message is durably in that inventory. The handler Photon
   means by "succeeds" is *"accepted into Orca's queue"*, not *"the agent finished answering"*.

That reading is what keeps both promises: Photon never replays work Orca already owns, and Orca never loses a
message it acked. A turn that takes four minutes therefore cannot hold the cursor, which is what makes
serial delivery per stream tolerable at all. Cursor state is per bot (its own project) and lives beside the
rest of the bot's state, in the same durable file discipline as the webhook ledger.

### What this buys over the other channels

This is the one inbound path in the whole set that **survives Orca being closed**: the webhook route loses
what arrives while nothing listens (`local-webhooks.md` § Durability), because there is nothing to receive
it. Photon holds the event until the cursor says Orca has it. The honest limit is the unpublished retention
window, not the mechanism — see the open questions.

**Version caveat, and it is the first decision:** that contract is documented on **Beta** (`/docs/beta/`),
while Hermes' integration runs on the **Stable** Surface/Spectrum SDK over gRPC. Photon's docs explicitly
say to use Stable unless a Beta target is chosen. So the fork picks one and pins it, and the replay guarantee
is a property of the one it picks — not a property of "Photon" in general.

## Flow

**Inbound.** A message on the bot's project becomes an ask, with the identity work `talking-to-bots.md`
specifies:

```text
stream message → dedupe by message id → BotRequestPerson { source: 'photon',
  userId: <the sender's handle>, name: <the contact name Photon gives>, role: 'owner' | 'member' | null }
  → resolve the thread to one of the bot's chats, or start one → startConversation / sendToChat
```

Reliability rules, borrowed from the webhook design because they are the same problem — and **answered by
Photon's own contract**, see *Offline delivery* below:

- **Two stores, not one.** A message id written to disk before the turn starts (so a crash mid-run replays
  instead of dropping), and a Photon **cursor** advanced only once that message is durably in Orca's store.
  The first is the crash guard, the second is the handoff checkpoint; conflating them loses work one way or
  the other.
- **Reconnect with backoff, then resubscribe.** A dropped stream is the normal case, not an incident. Socket.IO
  reconnects the socket but **the application must subscribe again with its saved cursor** — session recovery
  is disabled, so a reconnect that forgets to resubscribe hears nothing while looking healthy.
- **Fold, don't queue.** A second message in a thread while a turn is running folds into that run — the
  automation path already does this and caps the fold list (`MAX_RUN_EVENT_KEYS`).

**Outbound.** The bot's final message, or `bot reply`, goes back to the same thread via the Photon send
call. Thread ↔ chat mapping is the only new state: a Photon conversation id maps to a bot chat row, so a
follow-up message continues the same conversation rather than starting a new one every time.

## Access control: one list, edited through the API

There is no second ACL to keep in sync, because the assignment list **is** the allowlist — a sender is admitted by
creating an assignment for their handle, and "only messages from the assigned sender reach this shared-line
connection". So Orca's Who-can-ask (`BotMemberSchema`) becomes the **editor** of the provider's records rather
than a parallel copy:

- adding a member mints an assignment (and returns the number to hand them); removing one releases it — the same
  button, one call each way;
- an unknown handle cannot reach the stream at all, so the access-request flow (`bot-access-request.ts`) applies
  only to channels where the sender is visible pre-admission; the Photon answer is "add them, then they can
  text", and the UI should say so rather than promise a queue that never fills;
- `allow_all` is never offered;
- group chats require a mention by default — **and are Business-tier only**, since shared pools have no group API
  at all; on Free the equivalent is a DM room with `replyMode: 'mentions'`.

`source: 'photon'` is one more union member beside the `local` and `gmail` ones already planned — the same
shared-type edit, done once.

## Identity, concretely

- **Only assigned handles reach it.** A sender who is not in the assignment list never hits the stream. Phone
  handles are the common case; Beta's assignment body also takes `email`, so an Apple-ID email sender can be
  assigned — the third-party claim that shared pools reject email handles described the older path, not this one.
- **The number is the bot's identity, once saved.** Stable within a conversation, possibly different across
  recipients, and shown from the SDK's own `imessage(space).phone` rather than a typed-in field. Automatic
  contact cards are Business-only (`Contact Sharing: No` on Free), so on the target tier saving the thread once
  is the whole story.
- `source: 'photon'` plus the sender's phone handle means the bot knows *which* person is texting — the half of
  the identity requirement GitHub mode gave up.
- The honest ceiling to state in the UI: **25 shared iMessage assignments per project on Free** (100 on Pro),
  with no groups below Business — and the quota is per project, so several bots do not compete for one pool.

## Where it sits in the plan

`talking-to-bots.md`'s step 2 was "one real channel, Gmail first". **iMessage replaces it**:

| Step | Channel | Why it moves |
|---|---|---|
| 0 | `orca bot ask` | unchanged — the primitive |
| 1 | loopback `POST /ask` | unchanged — the substrate, and a cheap way to exercise the ask/reply plumbing before a channel exists |
| 2 | **iMessage via Photon** | outbound-only, a real separate identity, and the channel already in daily use |
| 3 | GitHub presence conventions | unchanged |
| later | Gmail, Telegram, Slack Socket Mode | only if a need appears; each is a worse fit for identity, endpoint or effort |

## Edit list

| Piece | Path | Kind |
|---|---|---|
| Photon client: stream, dedupe store, reconnect, send | new `src/main/bots/photon/*` | fork-owned |
| Provisioning: project, key, assignments, reconciler | new `src/main/bots/photon/provisioning.ts` | fork-owned |
| Stream → ask adapter, thread ↔ chat mapping | new, beside the existing `bot-automation-sessions` adapter | fork-owned |
| Reply → Photon send | new `fork-photon-results.ts`, one call site at run end | fork-owned + 1 hunk |
| Secure storage for account key and per-bot project keys | reuse `writeDurableSecureJsonFile` (`src/shared/secure-storage/secure-file`) | none |
| `photon` as an asker source | `src/shared/connectors/external-conversation-link.ts` | upstream, one union member |
| Connect / Create bot / Add member RPCs | one RPC method each, beside the existing bot connector RPCs | additive |
| Link/unlink surface (settings + RPC) | `src/renderer/src/components/settings/bots/*` | additive |
| Maybe: teach `bot list` to name the channel | `references/bots.md` | upstream, 1 line |

Note the size honestly: this is the largest single piece in the whole set of notes — a new third-party
integration with its own failure modes — and it is the one with no upstream precedent to copy inside Orca.

## Verification

- Unit: dedupe (same message id twice runs once), reconnect (stream drop mid-turn does not double-run),
  thread mapping (two messages in one conversation continue one chat; a new conversation starts another).
- Cursor discipline, the ones that would be silent bugs: a crash between inbox-write and turn start replays;
  a crash after the inbox-write but before the cursor advance replays harmlessly (dedupe absorbs it);
  advancing the cursor on *receipt* is caught by a test that asserts it does not happen; a cursor with gaps
  (`41 → 47`) resumes without assuming `+1`; a reconnect that forgets to resubscribe is caught by a
  liveness assertion rather than by silence.
- Unit: an unknown handle files one access request and never becomes an instruction; a known member's text
  arrives with the right `BotRequestPerson`.
- Unit: **provisioning is idempotent end to end** — the same slug returns the existing project instead of a
  second one; a replayed assignment with the same `Idempotency-Key` yields the same number; a replayed key mint
  returns the same secret rather than creating a second key.
- Unit: **each half-completed saga step resumes** — project created but key mint failed, key minted but capacity
  refused, assignment made but the record never persisted: the reconciler reads state back and finishes the
  record instead of rolling back.
- Unit: **deleting a bot does not delete the project by default**; releasing the assignment is an explicit action
  with its own confirmation, and project deletion warns that the slug can never be reused.
- Unit: **a closure stays open until it terminates** — `getProjectClosureStatus` is polled to a terminal state and
  a non-terminal result is reported as "still closing", never as success.
- Unit: outbound send failure leaves the turn's result recorded and retries, rather than vanishing.
- Unit: **the quota rules are enforced, not just documented** — one send per finished turn even when the agent
  emits many progress items; long output becomes one attachment, not N messages; and a send is never addressed to
  a conversation absent from the inbox, which keeps the bot out of the cold-start path entirely.
- Setup, not unit-testable and therefore stated in the UI: a freshly created project's inbound is dropped until
the line is picked up at token renewal, so the instructions end with "restart Orca, then text it".
- One live test against a real Photon line: text the bot, get one answer; then **quit Orca, text it again,
  reopen, and confirm the turn runs** — that is the replay property this channel is chosen for, and the only
  way to prove it. Restart mid-conversation and confirm the thread continues rather than restarting.
- Gate: `pnpm run check:code-quality:changed`, `pnpm tc:node`, `node local/check-upstream-file-comments.mjs`.

## Open questions

- **Beta or Stable?** Settled in favour of Beta for both provisioning and streaming, because provisioning does
  not exist on Stable and one version means one auth scheme. The cost, stated plainly: Beta is a preview, and its
  iMessage feature set is narrower (no tapbacks, polls or effects — none needed for a reply).
- **Does a released-then-readded sender get a new number**, and does releasing free the assignment slot
  immediately? Both decide what "remove a member" means in the UI: a slot back, or a new contact to re-save.
- **Does the 25-assignment Free quota count per project plan or per organization?** The plans page says per
  project, which makes several bots cheap; a per-organization reading would make the second bot expensive.
- **Does an account service key work for project creation unattended?** Yes per the reference — it may mint more
  service keys and Service Identity keys and M2M tokens may create projects. What is untested is whether a key
  minted that way carries the org scope project creation needs.
- **Does project closure ever terminate on its own?** `getProjectClosureStatus` implies a background process with
  no documented duration; treat "closing" as a state Orca shows rather than one it waits out.
- **How long is retained history?** The docs say replay is "limited to retained history" without a number.
- **Package weight and transport**: `@photon-ai/api` is generated from their OpenAPI, so check its tree for
  native deps before pinning — the Beta path should be pure JS, and a native surprise is the one thing that
  reopens the sidecar question.
- **Does Beta throttle sends without documenting it?** No per-message fee and no published quota is not the same as
  no limit; a burst of long turns is the one thing that would reveal it. Treat the per-turn cap as the guard until
  measured.
- **Is the dashboard's binding the whole story?** Ownership resolves per message at Photon's proxy, from the
  pair *(number, sender handle)*. The dashboard is the only place that binding is visible, so the setup copy has
  to match what it actually shows — one check on a real account, not an inference from either doc.
- **Does self-hosting lift the assignment quota and the group API?** On Beta the caps are assignments per project
  and (below Business) groups, which is what self-hosting would have to change to be worth it.
- **Attachment and length limits**: images and long logs are the common case for an agent, and Photon's
  message limits decide whether a result goes inline or as a file.
- **Group chats**: mention-gated answering is a start; two bots in one thread is undefined — and on Free it is
  unreachable, since group creation throws `UnsupportedError`.
- **Free-tier number stability**: the sending number may differ per recipient while staying fixed within a
  conversation. That is expected, not a defect — a saved contact keeps working because the pair does — but the
  UI must say it, or a team comparing notes will think the bot changed number.
