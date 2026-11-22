# Talking to a bot without Orca Cloud — and whose identity it wears

**Status:** design note, 2026-11-21, revised for identity. Nothing built.
**Why:** the fork now has a plan for work arriving (`local-webhooks.md`) and for a bot looking around
unaided (`look-around-pi.md`). Neither lets a person *ask* a bot anything. And in every design so far the
bot wears the owner's identity — which is right on GitHub, where no second account or app is available at
work, and wrong everywhere else.
**Placement:** fork patch (`local(bots)` / `local(cli)`), no public endpoint and no account.

## The doctrine being corrected

`skill-guides/orca-cli/references/bots.md:3` states it plainly:

> Doing work is done as your owner, with the service's own tool: `gh` for GitHub, `ORCA linear` for
> Linear. Talking back where you were woken is done as you, with `ORCA bot reply` … **Slack is the
> exception: everything there is you, the bot.**

So attribution is already per-surface and already inconsistent, and where the bot cannot be itself the
guide falls back to *text*: "end what you write with \"asked by <name> via <you>\"" (`bots.md:55`). A
sentence in a comment is not an identity; it is a disclaimer a reader has to trust.

## Identity is two axes, not one

The current design conflates them, which is why "act as the owner" sounds like one decision:

| Axis | Question | Today | Should be |
|---|---|---|---|
| **Authority** | whose credentials, permissions and money does the work use? | the owner | **the owner** — unchanged. A bot must not carry ambient authority it can leak in a turn. |
| **Attribution** | who does it look like, who is addressed, and where does a reply go? | owner on GitHub, Linear and mail; the bot in Slack and in the app | **the bot everywhere it can be**, and the asker named as a person |

Keeping authority with the owner is not a compromise: it is what makes an unattended run safe. A bot
presenting as itself is a separate question, and on most surfaces it costs nothing.

### What each surface presents today

| Surface | Presents as | Evidence |
|---|---|---|
| App chat (Home, side chats, Items) | **the bot** | local native chat; name, avatar, `SOUL.md` |
| Slack | **the bot** | `BotSlackAppSchema` — "The bot's own Slack app" (`src/shared/bot-types.ts:86`); cloud-only |
| Linear | the owner | "through Orca's one shared Linear app" (`bot-types.ts:89`) |
| GitHub | the owner | "Orca's one shared GitHub app", and `gh` as you (`bot-types.ts:97`) |
| Gmail / Calendar / Drive / Docs | the owner | local Google, acts as you |
| Local ask (this design) | **nobody** — the earlier draft carried no asker identity at all | — |

The local surfaces are the easiest to fix and the most important, because they are the ones the fork is
about to invent from scratch: get identity wrong there and it is wrong by construction.

## Who is asking: a person, not a role

The machinery already exists and is almost right. `BotRequestPerson`
(`src/shared/bots/bot-acts-for.ts:8-19`) carries `source`, `userId`, `name`, `workspaceId`, `role` and
`placeKind`, and `sameActsFor`/`actsForOwner` reason over it.

The gap is that **the owner arrives as a bare `{ kind: 'owner' }`** with no identity at all
(`OWNER_ACTS_FOR`, `:21`). A bot can therefore tell "the owner" from "a teammate" but cannot tell *which*
person is talking when the owner is the one talking, and has nothing to address a reply to.

So a local surface must mint the owner as a person:

```ts
{ kind: 'person', source: 'local', userId: <this host's owner id>, name: 'Alex', role: 'owner' }
```

Two costs to record. `ConnectorSource` is a cloud-sourced union (`external-conversation-link.ts`), so a
`local` source is a shared-type edit — cheap, but it is one. And the bot's preamble has to learn to read
it: today the preamble says "your owner"; it should say who, when the surface knows.

## GitHub identity: an app where one exists, the owner's everywhere else

A second GitHub account and a GitHub App are both unavailable **at work** — an account has to be
org-provisioned and approved, an app install is an admin decision with a security review. That is still true,
and it is why owner-identity is now the *fallback* rather than the design.

It is not the design because a GitHub App already run for `agent:auto` has a bot user of its own, opens and
merges pull requests as itself, and — the property that matters most here — carries **per-installation
permissions**. This doc previously recorded permission separation as genuinely lost. In app mode it is not,
so the record changes:

| | **App mode** (a repo whose app installation you can reach) | **Owner mode** (work repos, no app) |
|---|---|---|
| Who authors the write | the app's bot user, a distinct visible identity | you |
| Actor filtering ("don't wake on your own output") | exact: `sender.type` / the app's slug | the body marker, a convention that can be spoofed |
| Permission separation | real: `issues: write` + `pull_requests: write` without `contents: write` cannot push; merging can be withheld while commenting stays allowed | none — merging and commenting share `Pull requests: Read/Write` |
| Secret exposure to the model | nil for the app key: the host mints a one-hour installation token per run | the `gh` OAuth session holds no secret in env |
| What controls a merge | installation permissions plus branch protection | staging and review convention only |

The fork supports both and picks per repo, by whether an app installation is reachable. Most of this doc
describes **owner mode**, because it is the harder case and the one that needs designing; app mode is mostly
configuration.

### Both at once: the mode belongs to the repo, not the bot

The requirement is not "pick a mode" but "run one bot in both, on different repos": app at home, owner at
work. That rules out a global setting and even a per-bot one, so the mode is resolved **per dispatch, per
repo**, and three things follow from it:

- the bot record stays identity-agnostic — the same Scout runs as the app on a personal repo and as you on a
  work repo, and nothing about it is duplicated;
- `github.identity: 'auto' | 'app' | 'owner'` sits on the project (default `'auto'`), because "an
  installation exists" is not the same fact as "you may use it here" — an org can install an app and still
  require bots to act as people, so the override is the point, not the fallback;
- the resolved identity is **recorded on the run**, not re-derived at read time, so a run row can say what
  actually happened even after an installation is removed.

The rest of the pipeline is identical across modes: same `prompt`, same `precheck`, same worktree per run, same
`resultsTo` and history. Only three things differ, and they are the whole difference:

| | App mode | Owner mode |
|---|---|---|
| The token in the run's env | installation token minted per run | the owner's existing `gh` session |
| Attribution | the app's own bot user | visible line + invisible marker, below |
| What stops a merge | permission or branch protection | **nothing technical** — see below |

### Clear signals in owner mode, and the one thing to be honest about

"Clear signals that the work came from a particular bot" needs two different audiences satisfied, and the
marker only satisfies one. So every bot-authored GitHub body carries both:

| Signal | Seen by | Example |
|---|---|---|
| First line of the body | people reading the PR or comment | `🤖 **Scout** · Orca bot · acting for @nathanp` |
| `Co-authored-by:` trailer | GitHub's own commit and PR rendering | `Co-authored-by: Scout (Orca bot) <bot+scout@…>` |
| `<!-- orca-bot:scout -->` | event rules only, invisible to readers | — |

The first line is new and it is the one that matters to a human: the HTML marker is invisible in a rendered
comment, so a reader at work would otherwise see only you. Appending both comes from the same code path (the
`gh` shim), so a model cannot ship one without the other.

**Branch names are deliberately not a signal.** Many work repositories require every branch — including an
agent's — to sit under the person's username, so a bot-specific prefix is not available where it would matter
most. It is also unnecessary: Orca's `branchPrefix` setting already defaults to `'git-username'`
(`src/shared/settings/default-global-settings.ts:53`), producing `nathanp/…` for bot-created branches with no
convention to enforce, and identification does not read the name at all — `isBotWorkPullRequest` looks the head
branch up in the branches its own workers and bot-home worktrees hold. A repo needing a different shape sets
`branchPrefixCustom`; nothing about attribution depends on it.

**The honest asymmetry:** in app mode merge is a permission; in owner mode it is a promise. The same
`Pull requests: Read/Write` that lets the bot comment lets it merge, so an owner-mode automation that can open
a PR can also merge it, and a prompt-injected turn can do so. The mitigation is procedural and should be
stated rather than implied: owner-mode automations open **draft** PRs and leave **pending** reviews, and never
merge — a person submits the verdict. The run row says which mode ran, so this is checkable after the fact
instead of assumed.

### App mode, concretely

- **Mint per run, never store.** Sign a short-lived app JWT with the app's private key, exchange it for an
  installation token for that repo, put it in the run's launch env as `GH_TOKEN`, and let it expire. The
  private key lives in the secure store; the token never touches disk.
- **Permissions are the control.** `issues: write` (label, comment), `contents: write` (push a branch),
  `pull_requests: write` (open, review, merge), `checks: read`. Withholding `contents: write` blocks pushes;
  GitHub's "require approvals" branch protection blocks a self-merge unless the app is in the bypass list —
  so "the bot cannot merge however it is prompted" becomes an actual guarantee rather than a convention.
- **No marker shim needed.** The app's own comments carry `user.type: "Bot"` and the app's slug, so a rule can
  skip bot-authored deliveries exactly. The shim below remains the owner-mode answer.
- **One loop to guard anyway:** if an automation's own actions apply the label it triggers on, its own
  delivery re-fires it. Filtering `sender.type=Bot` in the listener is the cheap general guard, and it is the
  app-mode equivalent of the marker.

## Owner mode: the bot acts as you

**On a repo with no app, the bot acts as the owner on GitHub. Full stop.** What is left to design is not
*whose* identity appears; it is (a) the bot being itself everywhere it legitimately can, which is every local
surface, and (b) making the owner's voice on GitHub recognisably the bot's, which is what today's discretionary
one-liner fails at.

`service-account` and `machine-user` are recorded in *Deferred* as one line of launcher work
(`GH_TOKEN` + `GH_CONFIG_DIR`) to revisit only if an org ever provisions an account. They are not built.

### What makes owner-identity tolerable

GitHub renders authorship from data the bot already writes, so attribution does not need a second identity:

| Mechanism | What it buys | Cost |
|---|---|---|
| `Co-authored-by: Scout <…>` trailer | GitHub renders the co-author's name and avatar on the commit and the PR's commits tab | needs an email; the sanctioned mechanism, and safe under DCO/CLA rules |
| Commit author (`git -c user.name="Scout (Orca bot)"`) | the commit shows the bot's name as an unlinked author; pushes still authenticate as you | breaks where the org requires signed commits or a CLA the bot can't sign |
| Orca's own work ledger, no naming convention | `isBotWorkPullRequest` matches a PR's head branch against the branch a live bot worker's workspace or a bot-home worktree actually holds (`src/main/runtime/orca-runtime-bots.ts:229`) — so identification works under any naming scheme, including a repo that requires `nathanp/…` | none; once the worker is gone, the body marker is what remains |
| An HTML marker in every bot-written body, `<!-- orca-bot:scout -->` | machine-readable after the fact, invisible to readers, greppable by event rules | a convention, not a control |
| Draft PRs (`gh pr create --draft`) and **pending reviews** | the bot stages work; you submit it | caveats below |
| A structured trailer line instead of the current sentence | "asked by <name> via <bot>" becomes the same fixed form every time, so it is checkable and filterable, not discretionary | none — it is already the mandated text, just unstructured |

Pending reviews are the useful one: a review created without an `event` stays pending, visible only to the
authenticated user until they submit it and pick the verdict in the UI. That is a genuine "prepare, don't
act" control that exists under one identity. Two caveats — a [known GitHub
bug](https://github.com/orgs/community/discussions/213044) leaves the pending review's *body* out of the
"Finish your review" dialog (inline comments survive), so the summary belongs in the first inline comment;
and creating the review needs `pull_requests: write`, the same permission as merging.

### What owner mode loses

**No permission-level separation.** A fine-grained PAT cannot separate "comment on a PR" from "merge it" —
both need `Pull requests: Read/Write`; `Contents: Read/Write` alone returns 403 on merge. So scopes buy
least privilege on *contents* (read-only, no pushes) and *issues*, and nothing on reviews. "The bot cannot
merge however it is prompted" is only true if it also cannot comment on PRs. On one identity, the merge
control is staging and review convention, not permissions, and the UI should say so rather than imply a
guarantee.

Worth keeping as an optional hardening under the same identity, not as a mode: if the org allows PATs, the
bot's `gh` can take a contents-read-only one. It sits in the bot's environment, so a prompt-injected turn
can print it — least privilege, readable secret — whereas today's `gh` OAuth session keeps the token in
the keychain and exposes no secret to the model at all, only the ability to run `gh`: no leaked secret,
full rights. Pick per repo.

### The substitute for cloud actor filtering, in owner mode

The cloud version solves "don't wake on your own output" with `from=me` and `on=mine`. With one identity
there is no actor to compare, so the marker does that job instead.

```bash
# a rule that hears a human comment but not the bot's own
orca automations create --bot Scout --on 'webhook.call where=action=created' --precheck '…' \
  --prompt '…'      # and skip when the body carries <!-- orca-bot:
```

That is a convention, and anyone who can comment can spoof it. **Decided: accepted, because it fails in the
safe direction.** A forged marker makes a rule *ignore* a comment that a person really did write — the bot
misses work, it does not do wrong work. Nothing escalates: the marker never grants an action, it only
withholds one. The larger cost of this mode stays the one already named — with one login the bot cannot
tell your comment from a teammate's.

**The risk that does matter is omission, not spoofing.** A bot write that *forgets* the marker makes a rule
wake on the bot's own output, and that is a feedback loop. So the marker is not something the model is
told to remember: it is appended by code the bot cannot skip.

| Where | How |
|---|---|
| Any `gh` comment or review body | a fork-owned `gh` shim first on the bot's `PATH` in its launch env: it appends the marker to `--body`, and for `--body-file` writes a marked copy and substitutes the path, passing every other invocation through untouched |
| Pull requests | already structural — the head-branch convention `own-pr-trigger-guard.ts` reads today |
| `orca bot reply` and the local surfaces | the fork's own reply path appends it, since it owns the write |

A shim is the same trick this machine already uses for `pnpm`, and it moves the guarantee from "the model
complies" to "the write cannot happen without it". Its cost is a launch-env entry and a passthrough that
must stay faithful for every other `gh` verb — worth it, because the loop it prevents is the one that
would burn tokens in silence.

If the shim ever proves leaky (a body path it does not understand), the stronger fallback is to stop
looking at bodies at all: the fork records the ids of the comments it created and a rule skips those. Not
built, because it needs a write ledger consulted at match time and the shim removes the common case.

## What already works signed out

The gap is narrower than "no integrations":

| Surface | State |
|---|---|
| Desktop: Home Chat, side chats (`--chat new`), Items asks/replies | works |
| Phone: bot chat over a paired host | works (pairing, not cloud) |
| Agent → bot: `orca orchestration send --to bot:<name> --type question` | works — local RPC, no cloud reference in `message-send-handler.ts` |
| Owner's own mail/calendar/Drive/Docs | works — local Google |
| GitHub as the owner: `gh pr comment`, `gh issue comment` | works — your own `gh` auth |

What does not work is any third-party conversational channel — and, in consequence, the two things that
make one useful: `orca bot reply` refuses anywhere that is not a cloud thread
(`not_a_cloud_conversation`, `src/cli/bots/bot-reply.ts:36`), and results routing is cloud-shaped too
(`bot-run-results.ts:106`: "Orca Cloud isn't connected, so the result wasn't posted."). The repo admits
the hole from another direction: its import guide tells someone coming from Hermes that "Telegram,
WhatsApp, Discord" **stay behind** — "Not available here yet." (`references/bot-import.md:85`).

## The decisive property for a channel

No public inbound endpoint, so a channel is only cheap if it connects **outbound** or needs no third party:

| Candidate | Reaches the fork how | Identity it gives the bot | Reusable code |
|---|---|---|---|
| **iMessage via Photon** | **outbound gRPC stream — no public endpoint, no signing secret** | **the bot's own line: a genuinely separate sender** | none — no Photon or iMessage code exists in Orca today |
| Loopback HTTP `ask` | no third party | whatever the payload asserts — so make it a person record | the listener `local-webhooks.md` already builds |
| Gmail | outbound poll | **the owner's address** — attribution only via a display name or a `+bot` alias | `gmail.new_email` trigger, `orca gmail draft\|send` |
| GitHub @mentions | outbound poll of `gh` | the owner, unless option A ships first | replies already work via `gh pr comment` |
| Telegram | outbound long-poll | **a genuinely separate bot identity**, by construction | none |
| Slack (Socket Mode) | outbound websocket | **the bot's own user**, exactly as today's cloud app does | none — Socket Mode appears nowhere in this repo |
| Discord | outbound gateway | a separate bot identity | none |

Note how the identity requirement reorders the earlier ranking: Photon's iMessage line and Telegram and Slack
each give the bot a *separate* sender by construction, mail structurally cannot, and the loopback surface is
a design choice because it has no identity unless the fork supplies one. Photon wins on being the channel
already in daily use, on every device, needing no new app.

## The plan, smallest first

**Step 0 — `orca bot ask`, now with an asker.** The mail path is the primitive and nothing user-facing
names it (`orca bot list` even prints the address). A thin CLI over the same RPC, delivering into the
bot's Home Chat, makes it discoverable — and it records the asker as a `BotRequestPerson` for the local
owner, so the bot knows who it is talking to and can address them. No listener, no channel, no account.

**Step 1 — `POST /ask` on the loopback listener.** Same port, token, endpoint file and rate cap as
`local-webhooks.md`, one more route, and a required `from` identity in the payload. The **token
authenticates the surface; the payload names the person** — conflating them is how a shared endpoint turns
into an unowned authority. An asker who is not the owner is an access request (the existing
`bot-access-request` flow), not an instruction.

**Step 2 — one real channel: iMessage via Photon** (`imessage-channel.md`). It beats the alternatives on
the two things that decided this note: it is outbound-only (a gRPC stream, no public endpoint, no signing
secret) and it gives the bot **its own line**, so a reader sees a distinct sender — the one identity this
fork can get without an org provision. It needs a Photon account, which is not an Orca account, and which
the owner already has. Gmail, Telegram and Slack Socket Mode drop to "only if a need appears".

**Step 3 — the bot's GitHub presence, not its GitHub identity.** No launcher work: the bot acts as the
owner, and this step is only the conventions above (marker, trailer, branch, staged reviews) plus
`own-pr-trigger-guard.ts` learning the marker as a second signal. It folds into the conversation patch
rather than shipping on its own.

## Reply routing

Both answer paths are cloud-shaped today; the pieces to reuse:

| Need | Existing piece |
|---|---|
| Capture the bot's final message for a run | `automation-run-message-capture.ts` |
| Decide where a result goes | `bot-run-results.ts` — a fork-owned variant, since its `cloudOff` branch is the hole |
| A result line the agent never receives itself | `bot-automation-result-note.ts` |
| Chat rows for a conversation that isn't Home Chat | `bot-chat-tree.ts`; `BotChatOrigin` is `home \| slack \| linear \| github \| automation \| side` |

**The chat-origin decision:** a local conversation wants a seventh origin (`local`) so the sidebar can say
where it came from, but that is an upstream type used by icons, labels and the phone. Cheap fork route:
land on `side` for v1 with the surface in the chat title, and extend the union only if the title proves
insufficient. A trade-off, not an oversight.

## Edit list

| Change | File | Kind |
|---|---|---|
| `bot ask` spec + handler, carrying the asker | `src/cli/specs/bot.ts`, new `src/cli/bots/bot-ask.ts` | 1 line upstream, rest new |
| Teach the command, or the drift test fails | `bot-preamble.ts` start-here rule, `references/bots.md` | upstream, 1 line each |
| A `local` (and `gmail`) asker source | `src/shared/connectors/external-conversation-link.ts` | upstream, one union member |
| Owner recorded as a person on local asks | `src/shared/bots/bot-acts-for.ts` (`OWNER_ACTS_FOR` stays for cloud turns) | upstream, additive |
| `POST /ask` + ask→chat adapter | fork listener module; thin adapter over `bot-automation-sessions.ts` (`startConversation` `:74`, `sendToChat` `:110`) | fork-owned |
| Reply → surface | new `src/main/bots/fork-local-results.ts`, one call site at run end | fork-owned + 1 hunk |
| Marker appended by the bot's own write path, not by instruction | new `src/main/bots/fork-gh-shim.ts`, one `PATH` entry in the bot's launch env | fork-owned + 1 line |
| The marker as a second own-work signal | `src/main/connector-cloud/own-pr-trigger-guard.ts` | upstream, 1 condition |
| Commit attribution appended the same way (`git commit --trailer "Co-authored-by: …"`) | the same fork shim family | fork-owned, optional |

`src/cli/specs/bot-command-drift.test.ts` is the trap: every command the preamble or the guides *teach*
must parse, so a new command must be taught in both places or the suite is red.

## Verification

- Unit: a local ask records a `BotRequestPerson` for the owner with a `local` source, and `actsForOwner`
  still returns true for it.
- Unit: a non-owner ask becomes an access request and never an instruction; the bot's reply goes to that
  person and nothing else.
- Unit: `bot ask` refuses an unknown bot and an ambiguous name; it delivers to a named chat only when that
  chat takes mail.
- Unit: `POST /ask` rejects a wrong token, an unknown hook id, an over-cap caller, and a payload with no
  `from`.
- Convention: every bot-written GitHub body the fork produces carries `<!-- orca-bot:<name> -->`, and
  `own-pr-trigger-guard.ts` treats it as own work alongside the head-branch check.
- Shim: `gh pr comment -b "…"`, `gh issue comment --body-file <f>`, and `gh pr review` all post with the
  marker appended; `gh pr view`, `gh api`, and a failing `gh` invocation pass through byte-identical.
- Step 3: one pending review against a scratch PR shows as unsubmitted to a second account, and its
  inline comments carry the summary the body would have.
- Gate: `pnpm run check:code-quality:changed`, `pnpm tc:node`, `node local/check-upstream-file-comments.mjs`.

## Deferred, deliberately

- **A separate GitHub identity for owner-mode repos.** `service-account` and `machine-user` are the same
  launcher work (`GH_TOKEN` + `GH_CONFIG_DIR` per bot, so `gh` uses another login with no daemon and no
  server). Neither is built, because neither is available at work. Not the same thing as **app mode**, which
  is supported and costs only JWT signing plus one install — and which pays for itself on the repos where an
  installation already exists.

## Open questions

- **May an app-mode automation merge its own pull request?** The permission exists and a home pipeline may
  already rely on it. The safer default is "open, comment, request review, never merge", with `contents: write`
  withheld from the installation that runs automations and granted only to a second one that merges on an
  explicit `agent:merge` label.
- Should the bot's *own* actions carry `role: 'bot'` rather than `'member'`, so a rule can distinguish the
  bot's work from a teammate's?
- The marker is spoofable by anyone who can comment. **Decided: accepted** — it fails toward ignoring a
  real comment, never toward acting on a false one. The open half is only whether the id-ledger fallback
  is ever worth building.
- One token for every local surface, or one per surface so revoking a channel revokes one secret?
- Multi-bot routing on one endpoint: a `bot` field, or a per-bot path so a leaked token reaches one bot?
- For mail: `+bot` alias with a display name (cheap, weak) or a separate mailbox the bot can send from
  (stronger attribution, one more account — and the same question as GitHub's: is a second account
  available at all)?
- Should `bot ask` wait for an answer (`--wait`)? A wait needs a mailbox the CLI can read, and
  `orchestration check` is agent-shaped and would leak into a human surface.
