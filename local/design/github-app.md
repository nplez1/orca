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
| **Contents: Read and write**      | Push commits and branches.                        |
| **Checks: Read**                  | See whether its own pull request is green.        |
| **Actions: Read**                 | Read a failed run's logs.                         |
| **Metadata: Read**                | Added by GitHub to every App; not a choice.       |

**Workflows: Read and write** is deliberately _not_ requested. A push that touches
`.github/workflows/**` needs it, so GitHub rejects such a push with `refusing to allow a GitHub App to
create or update workflow`. That is stated in Settings rather than discovered: grant it on GitHub if
the bots push workflows. Settings warns when the installation's `Contents` is not `write`, which the
installation's own permissions answer; when GitHub answers no permissions at all, Settings says so
instead of guessing.

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

## git push, and the App inside `Repo.ghAccount`

A project can be bound to the App, and then **git pushes as it** too. The binding is the same
`GhAccountBinding` with `kind: 'app'`: absent `kind` still means a `gh` login, so every project saved
before this existed keeps its meaning, and the picker offers the connected App as one more row beside
the keyring logins it already shows.

A push cannot carry a token in its environment: an installation token lives an hour and a worktree can
outlive it, so an injected one would start failing silently. Instead the push is told how to _ask_ for
one, through git's own credential protocol:

- `orca git-credential get --repo <folder>` reads git's `key=value` request and answers
  `username=`/`password=` with a token minted at that moment through the runtime RPC. Nothing is
  written down, and no token reaches argv or the environment. It answers only a request that names
  `https`, `host=github.com`, and a repository; anything else gets no answer at all, so git fails there
  instead of falling back to your own login.
- The child git runs with `GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` carrying
  `credential.helper=` (emptied, so a configured helper cannot answer first), then
  `credential.helper=!orca git-credential --repo <folder>`, `credential.https://github.com.useHttpPath`
  (so git's request carries the repository, which the helper needs to refuse another one), and
  `url.https://github.com/.insteadOf` for every SSH spelling of github.com — `git@github.com:`,
  `git@ssh.github.com:`, `ssh://git@github.com/`, `ssh://git@github.com:22/`,
  `ssh://git@ssh.github.com/` and `ssh://git@ssh.github.com:443/` — so an SSH remote is fetched and
  pushed over HTTPS for this binding only, and a user binding's SSH login is untouched.
- Orca's own push reads the URL git will actually use back out (`git remote get-url --push`) and refuses
  when it is not `https://github.com/…`. A rewrite cannot be trusted on its own: a user's
  `url.git@github.com:.pushInsteadOf=https://github.com/` is applied to the original URL and the result
  is _not_ rewritten again, so that rule wins over the App's `insteadOf` and the push would go over SSH
  as you. Refusing names the remote and the URL, and says what to change.
- A bot session's launch env needs the credential, not just Orca's own pushes. It gets the same
  directives as a generated config file plus `GIT_CONFIG_GLOBAL`, because agent CLIs scrub
  key/token-shaped environment names from what their commands see and `GIT_CONFIG_KEY_n` would then
  leave git a count with no keys (#26594).

The token is minted for the installation covering the repository's owner, so one App installed on two
organisations works. An installation token acts on _every_ repository the installation covers, so the
helper is scoped by repository rather than by host: the runtime resolves the project's own remote keys
and refuses a request for any other repository, which is what stops a bot session's config — it applies
to every repository that session touches — from pushing or cloning something else as the App. A project
with no github.com remote is refused too, because no owner means no installation to mint for. No App
connected, or no installation covering that owner, **fails** the push and the `gh` call with
`gh_bound_account_unavailable` and a message naming the host or the owner: falling back to the user's
login would author the commit as someone else.

## Limits — not done here

- **github.com only.** The App's token is a github.com token. On a GitHub Enterprise host a bot's `gh`
  keeps acting as the signed-in account, Settings offers no App binding, and a binding that named a GHES
  host fails closed rather than pretending.
- **The token expiry is only shown once known.** A status read never mints a token, so Settings shows
  an expiry only after a bot has acted. Minting on a settings read would cost a network call and could
  fail in a way that looks like a broken connection.
- **A push that touches workflows.** `Workflows: Read and write` is not requested, so GitHub rejects it;
  Settings and this note say so instead of it being a surprise at push time.
- **A bot session's whole `git` is scoped to the bound project, not to the project's remote.** The
  config file it launches with rewrites every github.com SSH remote and names the helper for the bound
  project, and the helper answers only that project's own repositories — so a second repository pushed
  or cloned from inside that session is refused rather than acted on as the bound App, loudly, naming
  the project. A bot launch whose folder is one of the project's worktrees counts as that project, not
  only a launch inside the checkout: Orca keeps worktrees outside the main one, so both are matched.
  Scoping by `includeIf gitdir:` was rejected instead: a linked worktree's gitdir lives under the main
  checkout's `.git/worktrees`, so the pattern that matches the checkout does not match the worktree a bot
  actually works in. The list is the project's own remote keys as last read, so a fork push target Orca
  materializes afterwards is refused until the project's remotes are re-read — the same refusal, not a
  silent push as you.
- **A bot's terminal cannot be verified ahead of time.** Orca's own pushes check the URL git will use,
  but a `git push` typed in a bot's session is the session's git, and Orca is not in that loop. Two
  things therefore still reach GitHub as the person signed in there: an SSH host alias in
  `~/.ssh/config` (a remote spelled `gh-work:owner/repo`), which no `insteadOf` can enumerate, and a
  user-level `pushInsteadOf` for the same URL. Settings says the App pushes for the project, not that a
  hand-typed push in a session is verified.
- **WSL is refused, not half-supported.** Orca's helper is a command on this host and a distro's git
  cannot run it, so an App-bound project whose git runs inside a distro fails with a message naming the
  distro instead of pushing as that distro's own GitHub login. `gh` in a bot session is unaffected —
  its token crosses into WSL through `WSLENV` — but a push is not.
- **The generated config file replaces the session's global config.** `GIT_CONFIG_GLOBAL` points at a
  file Orca writes, and that file re-includes the user's own global configs by path so their settings
  survive. What does not survive: a write to the global config during the session (a tool that edits
  `~/.gitconfig` edits the generated file, and the next launch overwrites it), a repo-level helper that
  expected to receive git's `store` operation (the helper Orca names answers `store` by keeping
  nothing), and the files themselves, which are never cleaned up after a bot is deleted.
- **The credential RPC is `workspace`-scoped, not `accounts-admin`.** It mints no new authority — the
  project's own binding names the identity, and the repository has to be one of that project's own — but
  a paired client holding workspace permission can ask for a token for that project's repository. An
  installation token cannot be narrowed to one repository on GitHub's side, so the only scope is the
  repository check, not the token.
- **`erase` keeps nothing, so it cannot revoke.** git calls `erase` after a request it gave up on, and
  there is no per-request token to drop: the token lives in the installation cache until its hour is up
  or the App is disconnected, which is what revokes it.
