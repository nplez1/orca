# A GitHub App as a bot's GitHub identity

Orca bots act on GitHub through `gh`. Signed in as a person, `gh` acts as that person: a bot's PR
comment, review and issue reply are authored by whoever is signed in. A **GitHub App** is a second
identity Orca can put in front of a bot's GitHub commands, so those actions are authored by
`<slug>[bot]` instead. This note records what the App is, why it is optional, what it needs, and what
it does not cover yet.

Code: `src/shared/github/app/github-app-identity.ts` (pure helpers),
`src/main/github/app/` (JWT, API calls, sealed credentials, token cache, identity epoch, connection
lifecycle), `src/main/bots/bot-gh-app-identity.ts` (the token a bot's `gh` launches with),
`src/main/runtime/rpc/methods/source-control/github/github-app-methods.ts` (the RPC),
`src/renderer/src/components/bots/github/GitHubApp*` (Settings › Bots).

## Why it is optional

Every GitHub action Orca takes today goes through the signed-in `gh` account, and that stays the
default. With no App connected, nothing changes: `botGithubAppLaunch()` returns an empty env and a
bot's `gh` behaves exactly as before.

Connecting an App changes one thing — who a bot's GitHub actions are authored by. It does not change
who Orca acts as for the rest of the UI, and it does not replace `gh` sign-in, which Orca still needs
for everything it does as you.

## What the App needs

| Permission                        | Why                                               |
| --------------------------------- | ------------------------------------------------- |
| **Pull requests: Read and write** | Open pull requests, comment on them, review them. |
| **Issues: Read and write**        | Comment on issues.                                |
| **Checks: Read**                  | See whether its own pull request is green.        |
| **Actions: Read**                 | Read a failed run's logs.                         |
| **Metadata: Read**                | Added by GitHub to every App; not a choice.       |

**Contents: Read and write** and **Workflows: Read and write** are _not_ needed for what ships: a
bot's `git push` still runs as the user's git login (see Limits). Request them only if pushes as the
App are wanted later.

Nothing else is asked for: no webhook (nothing has to reach Orca) and no event subscriptions.

## Setup, in the order Settings walks it

1. **Create the App** at `https://github.com/settings/apps/new` — or, for an organization's
   repositories, at `https://github.com/organizations/<org>/settings/apps/new`. An App created under a
   personal account with **Only on this account** cannot be installed on an organization; GitHub's form
   offers only **Only on this account** and **Any account**. Webhook inactive, no event subscriptions,
   and exactly the permissions above.
2. **Install it** on the repositories the bots work in. `All repositories` is fine; Orca records which
   repositories the installation covers, so it never has to guess. An org-owned App is at
   `https://github.com/organizations/<org>/settings/apps`, not at `https://github.com/settings/apps`.
3. **Add it to Orca**: the App ID (from the App's own settings page — a different number from the
   installation id in the installation URL) and the private key, pasted or read from the downloaded
   `.pem`.

`github.app.connect` verifies before it stores anything: `GET /app` proves the id and the key belong
together (a mismatch is GitHub's 401, an unknown App its 404), `GET /app/installations` lists where it
may act, and each `selected` installation's repositories are filled in from
`GET /installation/repositories` with a token minted for it. Both lists follow GitHub's `Link` header,
so an App installed in more than a hundred places is not cut off at the first page. An App GitHub has
not installed is refused, because a bot with nowhere to act would fail at launch instead of at setup.
Only then is the file written, and every cached installation token is dropped so a re-key cannot keep
acting with the old one.

`github.app.refresh` re-reads the same thing and rewrites what is stored, so a repository added to an
installation — or a whole second installation — needs no second paste. The identity does not change,
so running sessions keep the token they launched with.

The key is sealed by the OS keyring (`secret-store`) and the file is written 0600 and atomically. A
host with no keyring refuses to store one rather than write the key in the clear, and a stored key that
is not a `sealed:` envelope is refused rather than trusted.

## How identity is resolved

A bot's `gh` launch env carries `GH_TOKEN` (and `GH_PROMPT_DISABLED=1`) for one installation —
`BOT_GH_APP_TOKEN_ENV` in `src/main/bots/bot-gh-app-identity.ts`. Nothing about the key or the token
reaches a command's argv, and for Codex the token goes into the environment of the commands it runs
rather than the CLI's own, which Codex snapshots to disk.

The installation is the one covering the repository the launch sits in when Orca already knows it
(`githubAppCoversRepo`), else the first; Settings names the one in use rather than implying every
installation is active. Installation tokens last an hour; `installationToken()` mints on demand, caches
per installation, refreshes ten minutes early, and shares one mint between concurrent callers. A
connected App that cannot produce a token fails the bot's launch rather than falling back to the
ambient `gh` sign-in: a bot that quietly comments as you is worse than one that refuses to start.

Because a token is minted once per launch and a bot's chat lives for hours, a session starts again when
the identity it launched under no longer holds: `appIdentityEpoch()` is bumped by connect and
disconnect, and a launch records the epoch and its installation. Either a changed epoch or a token
inside the refresh margin makes the session relaunch with a fresh token, so an hour-old token cannot
401 silently.

Disconnecting revokes the installation tokens Orca minted (`DELETE /installation/token`, best effort)
before forgetting them, and it supersedes a connect still in flight, so the last action the user took
is the one that stands.

## Limits — not done here

- **Git push as the App.** The push path still runs as the user's git login. Making pushes act as the
  App needs the installation token in git's credential helper, not just in `gh`'s env; whether
  `GH_TOKEN` already helps depends on whether `gh` is that helper, which is unverified.
- **github.com only.** The App's token is a github.com token. On a GitHub Enterprise host a bot's `gh`
  keeps acting as the signed-in account, and Settings says so.
- **App accounts inside `Repo.ghAccount`.** The per-repo account picker
  (`RepositoryGitHubAccountSection`) still chooses among keyring `gh` logins. An App is a host-wide
  identity, not a per-repo binding, and the two are not yet reconciled.
- **The token expiry is only shown once known.** A status read never mints a token, so Settings shows
  an expiry only after a bot has acted. Minting on a settings read would cost a network call and could
  fail in a way that looks like a broken connection.
