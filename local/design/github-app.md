# A GitHub App as a bot's GitHub identity

Orca bots act on GitHub through `gh`. Signed in as a person, `gh` acts as that person: a bot's PR
comment, review and issue reply are authored by whoever is signed in. A **GitHub App** is a second
identity Orca can put in front of a bot's GitHub commands, so those actions are authored by
`<slug>[bot]` instead. This note records what the App is, why it is optional, what it needs, and what
it does not cover yet.

Code: `src/shared/github/app/github-app-identity.ts` (pure helpers),
`src/main/github/app/` (JWT, API calls, sealed credentials, token cache, connection lifecycle),
`src/main/bots/bot-gh-app-identity.ts` (the token a bot's `gh` launches with),
`src/main/runtime/rpc/methods/source-control/github/github-app-methods.ts` (the RPC),
`src/renderer/src/components/bots/github/GitHubApp*` (Settings › Bots).

## Why it is optional

Every GitHub action Orca takes today goes through the signed-in `gh` account, and that stays the
default. With no App connected, nothing changes: `botGithubAppEnv()` returns an empty env and a bot's
`gh` behaves exactly as before.

Connecting an App changes one thing — who a bot's GitHub actions are authored by. It does not change
who Orca acts as for the rest of the UI, and it does not replace `gh` sign-in, which Orca still needs
for everything it does as you.

## What the App needs

| Permission                        | Why                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| **Contents: Read and write**      | Push branches.                                                                        |
| **Pull requests: Read and write** | Open pull requests, comment on them, review them.                                     |
| **Issues: Read and write**        | Comment on issues.                                                                    |
| **Workflows: Read and write**     | Push branches that change `.github/workflows/**`; without it GitHub refuses the push. |
| **Checks: Read**                  | See whether its own pull request is green.                                            |
| **Actions: Read**                 | Read a failed run's logs.                                                             |
| **Metadata: Read**                | Added by GitHub to every App; not a choice.                                           |

Nothing else is asked for, and nothing else is needed: no webhook (nothing has to reach Orca), no
event subscriptions, and no read access to the wider account. "Where can this App be installed?"
is the user's call — **Only on this account** covers their own repositories, the organization option
covers an org's.

## Setup, in the order Settings walks it

1. **Create the App** at `https://github.com/settings/apps/new`, with the webhook inactive, no event
   subscriptions, and exactly the permissions above.
2. **Install it** on the repositories the bots work in. `All repositories` is fine; Orca records which
   repositories the installation covers, so it never has to guess.
3. **Add it to Orca**: the App ID (from the App's settings page — a different number from the
   installation id in the installation URL) and the private key, pasted or read from the downloaded
   `.pem`.

`github.app.connect` verifies before it stores anything: `GET /app` proves the id and the key belong
together (a mismatch is GitHub's 401, an unknown App its 404), `GET /app/installations` lists where it
may act, and each `selected` installation's repositories are filled in from
`GET /installation/repositories` with a token minted for it. An App GitHub has not installed is
refused, because a bot with nowhere to act would fail at launch instead of at setup. Only then is the
file written, and every cached installation token is dropped so a re-key cannot keep acting with the
old one.

The key is sealed by the OS keyring (`secret-store`) and the file is written 0600 and atomically. A
host with no keyring refuses to store one rather than write the key in the clear.

## How identity is resolved

A bot's `gh` launch env carries `GH_TOKEN` (and `GH_PROMPT_DISABLED=1`) for the App's first
installation — `BOT_GH_APP_TOKEN_ENV` in `src/main/bots/bot-gh-app-identity.ts`. Nothing about the key
or the token reaches a command's argv. Installation tokens last an hour; `installationToken()` mints on
demand, caches per installation, refreshes ten minutes early, and shares one mint between concurrent
callers. A connected App that cannot produce a token fails the bot's launch rather than falling back to
the ambient `gh` sign-in: a bot that quietly comments as you is worse than one that refuses to start.

## Limits — not done here

- **Git push as the App.** `Contents: Read and write` is requested because the App needs it to push,
  but the push path itself still runs as the user's git login. Making pushes act as the App needs the
  installation token in git's credential helper, not just in `gh`'s env.
- **App accounts inside `Repo.ghAccount`.** The per-repo account picker
  (`RepositoryGitHubAccountSection`) still chooses among keyring `gh` logins. An App is a host-wide
  identity, not a per-repo binding, and the two are not yet reconciled.
- **Multiple installations are listed, not chosen.** A bot acts as the first installation. Picking one
  per bot or per repo is the next step if it is ever needed.
- **The token expiry is only shown once known.** A status read never mints a token, so Settings shows
  an expiry only after a bot has acted. Minting on a settings read would cost a network call and could
  fail in a way that looks like a broken connection.
