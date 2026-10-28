# Ephemeral host lifetime

A per-workspace environment recipe can put its machine on a clock. The provider sells a fixed lease,
and when the lease runs out the machine is gone whatever Orca still believes about it. This page is
the contract for that clock: what a recipe publishes, how Orca asks for more time, and the only
conditions under which Orca stops accounting for a host it can no longer reach.

Two rules shape everything below.

- **The provider owns the deadline.** Orca records one absolute timestamp and counts down to it. It
  never derives a deadline from a duration, and it never extends a lease by itself.
- **Loss of contact is not evidence of absence.** A host that cannot be reached because the laptop
  is off-network is indistinguishable, from this side, from one the provider deallocated. Orca
  therefore never treats reachability as evidence about the machine, and never reclaims on it alone.

Nothing here is provider-specific. Every provider verb stays inside the recipe's own scripts, which
run on the desktop from the repository root; Orca consumes only the one JSON object they print on
stdout.

## The lifetime metadata

Four keys inside a recipe result's `userData` are well known to Orca
(`EPHEMERAL_VM_LIFETIME_USER_DATA_KEYS`, `src/shared/ephemeral-vm-lifetime.ts:10`):

```json
{
  "schemaVersion": 1,
  "connection": { "...": "..." },
  "userData": {
    "provider": "team-machines",
    "resourceId": "vm-9f2c",
    "releaseAt": "2026-10-13T03:26:41Z",
    "lifetimeSeconds": 21600
  }
}
```

| Key               | Accepts                                                | Meaning                                                                           |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `releaseAt`       | RFC 3339 timestamp **with an offset**: `Z` or `±HH:MM` | The provider's absolute deadline. The sole source of the countdown.               |
| `lifetimeSeconds` | Positive whole seconds                                 | Context only. Never substitutes for the deadline.                                 |
| `provider`        | Non-empty string or finite number, opaque to Orca      | Names the provider in the UI.                                                     |
| `resourceId`      | Non-empty string or finite number, opaque to Orca      | The provider handle a lifecycle script reads back out of `recipeResult.userData`. |

- **`releaseAt` drives the countdown alone.** `readEphemeralVmLifetime`
  (`src/shared/ephemeral-vm-lifetime.ts:157`) parses it with `z.iso.datetime({ offset: true })`
  (`:129`) and stores `Date.parse(releaseAt)` alongside it; every remaining-time calculation is that
  value minus now (`getEphemeralVmRemainingMs`, `:188`). Nothing reads the duration for arithmetic.
- **`lifetimeSeconds` is deliberately not the deadline.** A provider may report the original lease
  length or what is left of it, and the two disagree the moment a lease is extended. A reader that
  counted down from it would count to the wrong instant; a reader that compared it to the elapsed
  time would do worse.
- **`provider` and `resourceId` are opaque.** Orca stringifies them, shows `provider`, and passes
  them back untouched. It has no table of provider ids and never interprets a resource handle.

### Declaring a lifetime is opt-in — and then it is mandatory

`releaseAt` is what decides whether a result carries a lifetime at all
(`src/shared/ephemeral-vm-lifetime.ts:157`). `userData` without that key is not a lifetime, even when
it sets `provider` for unrelated reasons, so a recipe written before this contract behaves exactly as
it always did. That is the whole of the backward compatibility.

Once `releaseAt` is present, its siblings are validated with it, and a malformed one is **reported as
a warning on the host rather than failing the recipe result**: `readEphemeralVmLifetime`
(`src/shared/ephemeral-vm-lifetime.ts:157`) reports the error, and
`getEphemeralVmRecipeResultWarnings` (`src/shared/ephemeral-vm-recipe-diagnostics.ts`) turns it into a
`recipe.result.lifetime.unreadable` warning that reaches the user through the provisioning flow and
through `orca vm recipe doctor --provision`. Why not a hard failure: at that point `create` has
already run, so refusing the result would throw away the only record of a machine the provider is
already billing for. The host provisions, shows no countdown, and is never reclaimed
automatically — a bad deadline reads as _no_ deadline to every reader, so it can never cause a
reclaim. **An `extend` or `resume` that would lose a deadline the host already had is refused
outright**, because there the record survives and the action is retryable. The message for the common
case is `userData.releaseAt must be an RFC 3339 timestamp with an offset, such as
2026-10-13T03:26:41Z.`

A useful distinction when debugging: the _type_ error (`userData.releaseAt must be an RFC 3339
timestamp…`, or `userData.provider must be a non-empty string or a finite number.`) is a bug in the
script, while a result that carries no `releaseAt` at all is a recipe that never opted in. They look
different on purpose.

Unknown `userData` keys are unaffected. The lifetime schema reads the four keys it knows and ignores
the rest, so `userData` remains the recipe's own free-form record for provider state.

## Durations, and what a recipe may offer

`extendDurations` is the list of lease lengths a recipe is willing to be asked for, and Orca offers
exactly those — never a lifetime a provider would refuse to sell.

```yaml
environmentRecipes:
  - id: ephemeral-host
    name: Ephemeral host
    create: ./scripts/orca-vm/create.sh
    extend: ./scripts/orca-vm/extend.sh
    extendDurations: [1h, 4h, 24h]
    destroy: ./scripts/orca-vm/destroy.sh
```

Each entry is `<integer><unit>` with `s`, `m`, `h`, or `d`, case-insensitive, at most six digits
(`DURATION_PATTERN`, `src/shared/ephemeral-vm-lifetime.ts:32`). The bounds are in
`EPHEMERAL_VM_LIFETIME_DURATION_LIMITS` (`:25`): **at least 60 seconds, at most 30 days, at most 8
entries.** Each entry is canonicalized to the largest unit that divides it exactly and duplicates
after canonicalization are dropped, so `24h` is stored and offered as `1d` (`90m` stays `90m`, since
an hour does not divide it). The floor exists because an extension shorter than the script itself
takes to run is always a typo; the ceiling because past a month a provider's own TTL is not
meaningfully different from "no deadline", and Orca would render a countdown nobody can act on.

| As written in `orca.yaml`                     | Outcome                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `extendDurations` without `extend`            | The whole recipe is rejected with a diagnostic — choices Orca can never offer are a misconfiguration (`src/shared/orca-yaml.ts:226`).     |
| `extend` without `extendDurations`            | Parses. The doctor warns (`recipe.extend_durations`, `src/shared/ephemeral-vm-recipe-doctor.ts:77`) that no Extend action can be offered. |
| A duration outside the bounds, or a ninth one | The recipe is rejected with an `extendDurations` diagnostic.                                                                              |

At the call site the requested lifetime is canonicalized and checked against that same list before
the script runs (`resolveRequestedEphemeralVmExtendDuration`,
`src/main/ephemeral-vm-runtime-extend.ts`), and the workspace's **Extend lifetime** menu is built from
that same list (`src/renderer/src/components/sidebar/EphemeralVmExtendLifetimeMenu.tsx`). A lifetime
outside the declared set means the request did not come from Orca's own UI; asking the provider for it
would fail deep inside the script instead of at the boundary, where it can be reported honestly.

## The `extend` hook

`extend` is invoked exactly like `suspend`, `resume`, and `destroy`: one JSON line on **stdin**, and
`ORCA_VM_MODE=extend` in the environment (`buildRecipeEnv`, `src/shared/ephemeral-vm-recipe-process.ts:233`).

```json
{
  "schemaVersion": 1,
  "mode": "extend",
  "recipeId": "ephemeral-host",
  "instanceId": "orca-…",
  "projectId": "…",
  "workspaceId": "…",
  "workspaceName": "feature-x",
  "recipeResult": { "...": "the result create printed, as persisted" },
  "lifetime": "4h"
}
```

Built by `buildEphemeralVmRecipeExtendPayload`
(`src/shared/ephemeral-vm-recipe-lifecycle-payload.ts:48`). It is the cleanup payload plus `lifetime`,
which is the canonical spelling of the requested duration and is the only field this mode adds.
`instanceId`, `projectId`, `workspaceId`, and `workspaceName` are present only when the runtime has
them.

### What it must print

The same recipe-result shape `create` printed, on stdout, with the lifetime metadata updated
(`runEphemeralVmRecipeExtend`, `src/shared/ephemeral-vm-recipe-extend-runner.ts:48`, which reuses
`parseEphemeralVmRecipeResult` and the same checkout-mode check as every other mode).

An extension has no "nothing to do" outcome. A recipe that does not declare `extend`, a non-zero
exit, or a stdout that is not one valid recipe result is an error the user can see and retry — the
hook never reports success while the deadline stays where it was. There is one guard specific to
this mode: a result that _drops_ the deadline the runtime already had is refused
(`src/main/ephemeral-vm-runtime-extend.ts:101`), because a paid-for lease with no countdown and no
reconciliation is worse than a visible, retryable failure.

What Orca does with the returned result:

- **An unchanged `connection` keeps the host attached**, live terminals and all. This is the point of
  extending before a deadline rather than reconnecting after one, and it is why the hook must pass
  the result's other fields through rather than building a minimal one.
- **A changed `connection` re-attaches the host.** Orca detaches the old target and attaches the new
  one (`reattachEphemeralVmRuntime`, `src/main/ephemeral-vm-runtime-extend.ts`); in SSH mode it
  disconnects first, because the target registry would otherwise keep serving the old machine under
  the new lease. In Orca-server mode the new pairing code replaces the environment's.
- **A failure changes nothing on the record.** Nothing about the lease moved, so persisting the
  failure would only make the host look broken until the user retried.

### The hook is snapshotted at creation

A recipe that declares `extend` has the hook and its `extendDurations` recorded against the runtime
when the host is created — the same treatment the other lifecycle commands get. Editing or deleting
that `orca.yaml` entry afterwards does not change what an existing host's Extend action runs. Both
travel as top-level fields on the runtime record itself (`src/shared/ephemeral-vm-runtimes.ts:62`,
`:65`), **not** inside the strict `recipe` snapshot: a field an older build cannot parse would make
the whole runtime store unreadable to it, while the record's own object is not strict and that build
simply drops the fields it does not know. Dropping them is safe but lossy: if an older build writes
the store after such a field appears, the `extend` hook, its `extendDurations` and the `reclaimedAt`
marker are gone, so that host's lease can no longer be extended from Orca until it is re-created.

## Expiry

Past `releaseAt` the provider is entitled to have destroyed the machine, whether or not Orca can see
it.

**The reconnect ladder is left alone, and that is deliberate.** An earlier revision suppressed it
past the deadline and reported `Ephemeral host lease expired at <ISO>` without making a single
attempt. That was removed: the ladder is already bounded — nine attempts, about a hundred seconds —
so it stops on its own, while suppressing it _manufactured_ the very `reconnection-failed` verdict
the reclaim decision reads as evidence the machine is gone. An out-of-band extension followed by a
brief network blip would have reclaimed a demonstrably alive host. Nothing is gained by shortening
a bounded ladder, and the reclaim now rests only on a verdict Orca actually earned. Relays past
their lease are therefore retried for at most that ~100-second window and then stop.

Past the deadline the host's lease is also simply presented as expired: it is derived, not stored —
`expired` is `now >= releaseAtMs` (`isEphemeralVmLifetimeExpired`,
`src/shared/ephemeral-vm-lifetime.ts:192`, read by `resolveEphemeralVmRuntimeLease`,
`src/renderer/src/hooks/useEphemeralVmRuntimes.ts:134`), so every surface reading it agrees about the
instant it flips.

### Reclaim needs a passed deadline _and_ a gone machine

`decideEphemeralVmRuntimeReclaim` (`src/shared/ephemeral-vm-runtime-reclaim.ts:64`) is the whole
decision. It returns `reclaim: true` only when all three hold:

1. the runtime is not already reclaimed or released — no `reclaimedAt`, not `cleaned`, not
   `cleanup_pending`, and not `cleanupStatus: 'succeeded'`, since deciding again would race the
   attempt already running;
2. now is past `releaseAt` **plus `EPHEMERAL_VM_RECLAIM_GRACE_MS` — 15 minutes**
   (`src/shared/ephemeral-vm-runtime-reclaim.ts:12`); and
3. Orca holds evidence that the host is not coming back — material the caller supplies as
   `connectionExhausted`, never a timeout inferred locally.

Anything else is a named decline, and each is a distinct, reportable reason:

| `reason`               | Meaning                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `no-provider-deadline` | The recipe published no `releaseAt`, so there is nothing to count down or reclaim on. |
| `already-reclaimed`    | Already reclaimed (`reclaimedAt` set), or already releasing or released.              |
| `within-lease`         | Still inside the lease, or inside the grace that follows it.                          |
| `host-may-return`      | Past the deadline, but Orca holds no evidence the machine is gone.                    |

**Why a grace period.** A provider that enforces its TTL lazily can leave a host reachable for a
while past the stated deadline, while one that has already deallocated it leaves the address dead.
Waiting costs nothing, and it stops Orca reclaiming a lease that was extended out of band or
reinstated by a provider retry.

**Why `host-may-return` is the default whenever contact is lost.** The rule is not "unreachable, so
gone"; it never can be. A host that cannot be reached because this machine is off-network, behind a
dropped VPN, or simply asleep looks exactly like one that was deallocated — and it may still be
perfectly alive, with the user's work and running agents on it. Only a terminal verdict from Orca's
own connection — a bounded set of attempts that all failed, spelled out below — is evidence about
the host; and even then the deadline has to have passed first. The provider's own TTL remains the
hard safety net for the case Orca cannot observe at all: Orca exits, or loses connectivity for good,
and the provider destroys the machine on schedule with no help from Orca.

**Neither transport checks whether this machine had a network.** Be precise about what "earned"
means: nine failed attempts and a failed status probe are evidence that Orca could not reach the
host, not that the host is gone. A laptop that is off-network for longer than the grace, past a
deadline, is therefore the one case where a live host loses its rows — which is exactly the residual
risk stated below, and why the provider's TTL, not this rule, is the safety net.

**The evidence behind `connectionExhausted` is transport-specific, and this is where the two
transports stop being symmetric** (`isEphemeralVmConnectionExhausted`,
`src/main/ephemeral-vm-runtime-reclaim.ts:50`):

- **SSH:** the reconnect ladder is bounded, so `reconnection-failed` is the terminal verdict and the
  only thing that counts. A lost transport by itself is not evidence.
- **Orca server:** the shared-control reconnect scheduler deliberately caps nothing — a roaming
  outage there is unbounded — so no retry-exhaustion verdict exists, and the strongest evidence
  available is a probe that actually failed: `verification === 'unavailable'`, or the host's own
  verdict that the pairing is over (`isRuntimeHostContactRevoked`,
  `src/shared/runtime-host-status.ts:61` — it retired us, or reports `verification === 'blocked'`).
  A probe that never settled (`verification === 'checking'`) is not a failure and does not reclaim.
- Anything else, including a missing snapshot, reads as not exhausted.

**The residual risk is real.** A machine that is merely offline past its deadline loses its rows even
though it may still be alive. Nothing on the machine is lost, because reclamation is Orca's own
bookkeeping and destroys nothing — but the cost is not zero either: recovering means re-creating the
workspace and, for a host Orca has forgotten, adding the SSH target back from the recipe result by
hand. Nothing in the UI re-attaches a reclaimed runtime for you.

**The decision runs in a sweep, not on an event** (`EphemeralVmRuntimeReclaimer`,
`src/main/ephemeral-vm-runtime-reclaim.ts`). Nothing tells Orca the moment a provider's TTL lapses,
and the host is unreachable by then, so the deadline is only knowable from the record. The sweep
runs once at startup and then every 60 seconds; it is single-flight, so two passes cannot overlap; a
runtime that cannot be read does not stop the others; and it stays armed when nothing is pending,
because "no lease has lapsed yet" is not the absence of future work. Each runtime is reclaimed under a
per-runtime lock that re-reads the record — so a lease extended while the sweep was working through
earlier runtimes is not reclaimed from a stale copy.

**`destroy` is not part of reclamation.** The recipe's `destroy` stays an explicit action: the
**Cleanup** button on the host's row in Settings → Cloud VM runtimes, and the teardown that runs
when a workspace is deleted (`cleanupEphemeralVmRuntimesForDeleted`,
`src/renderer/src/lib/ephemeral-vm-runtime-cleanup.ts:26`). A failed destroy is still recorded on
the runtime record — `status: 'cleanup_failed'`, `cleanupStatus: 'failed'`, and `cleanupLastError`
(`src/main/ephemeral-vm-runtime-service.ts:188`) — but no reclaim-decline condition reads it, so it
neither blocks nor triggers a reclaim. Settings is where to release the provider resource early, by
hand.

### Reclaiming is bookkeeping on Orca's side

A reclaim re-reads the runtime under its lock, records `reclaimedAt` and the reclaimed host's own
identity strings in `reclaimedHostIds`, releases the host's runtime-environment registrations and its
SSH target, and announces the reclaim so the renderer can forget the workspace rows. That is Orca
forgetting a host it can no longer use, and it never runs the recipe's `destroy`. The evidence a
background sweep can gather is
not strong enough to justify deleting a machine that may still be alive with unpushed work on it, and
the provider's own TTL is the safety net. A release that fails is logged and not retried, so a
registration can outlive the reclaim — the host is still gone from Orca's list, but the leftover
registration has to be removed by hand — and if that removal fails, the helper that reports the
failure records `cleanup_failed` on a host the user never asked to clean up, which is why the
Settings row's reclaimed note takes precedence over that status. `reclaimedAt` is what marks a
runtime as reclaimed — the
status vocabulary cannot say "released", because nothing released the machine — and the record keeps

**A reclaimed runtime is never a cleanup target.** The reclaim clears `connectionMode` and
`runtimeEnvironmentId` as well as the SSH target, and the renderer's workspace-removal path skips any
runtime with `reclaimedAt` set (`cleanupEphemeralVmRuntimesForDeleted`,
`src/renderer/src/lib/ephemeral-vm-runtime-cleanup.ts`). Both matter: forgetting a reclaimed
workspace must not re-enter cleanup and run the recipe's `destroy` on a machine the user may still be
using, which is exactly what a leftover `runtimeEnvironmentId` used to do.
whatever `cleanupStatus` it already had, so the Settings row still reports the last cleanup attempt
(or that none has run).

**These are remote machines.** Their files, git state, and branches live on the host, so removing
Orca's records does not and must not delete anything on that disk. A reclaimed workspace is not a
deleted workspace: if the provider's grace or a manual recovery brings the machine back, the work is
still there, and it is the provider's lease — not Orca's bookkeeping — that decides whether that can
happen.

The renderer is told about a reclaim through `EphemeralVmRuntimeReclaimed`
(`src/shared/ephemeral-vm-runtime-reclaim.ts:37`) rather than made to re-read disk: it carries
`runtimeId`, `repoId`, `workspaceId`, `workspaceName`, `releaseAt`, and the reclaimed host's **own
execution-host identities** as `hostIds`, because dropping the host registrations is not enough — the
workspace rows are the renderer's to forget, and only it knows how. The same identities are persisted
on the record as `reclaimedHostIds` at reclaim time, because that event is a one-shot broadcast: one
that fires while no window is open reaches nobody, and releasing the registrations has already
cleared the ids they are derived from. The renderer reconciles those on start and whenever the
runtime records are refreshed.

The identities are what the
renderer matches on (`resolveReclaimedEphemeralVmWorkspaceHostId`,
`src/renderer/src/hooks/ipc-events/ephemeral-vm-reclaim-ipc-bridge.ts:42`), never a bare workspace
id: one workspace id can exist on several hosts at once — two VMs from the same recipe with a fixed
`projectRoot` produce the same id — so an id alone would let the renderer forget a live sibling's
row. Only a row that belongs to an identity on this event is forgotten.

## A worked provider example

An `extend` hook has one job, and the interesting part of it is step 2: ask the provider what the
deadline is _now_ rather than computing it locally. A local sum drifts from the enforced deadline —
account-level TTL caps, provider rounding, and a lease that was already extended out of band all
break it — and Orca would then count down to an instant nobody guarantees.

```bash
#!/usr/bin/env bash
set -euo pipefail

# stdout is the contract: exactly one JSON object, the same shape create printed.
# Progress and errors go to stderr, or they corrupt the result.
log() { printf '%s\n' "$*" >&2; }

payload="$(cat)"
resource_id="$(printf '%s' "$payload" | jq -r '.recipeResult.userData.resourceId // empty')"
lifetime="$(printf '%s' "$payload" | jq -r '.lifetime // empty')"
if [ -z "$resource_id" ] || [ -z "$lifetime" ]; then
  log "no resourceId/lifetime in the extend payload: $payload"
  exit 1
fi

# 1. Ask the provider for more time. It takes the resource handle and the requested lifetime, which
#    is one of the spellings orca.yaml's extendDurations declares — nothing else is ever sent here.
provider extend "$resource_id" --for "$lifetime" >&2

# 2. Re-read the resource and take the provider's own deadline.
resource="$(provider show "$resource_id" --json)"
release_at="$(printf '%s' "$resource" | jq -r '.expiresAt // empty')"
remaining="$(printf '%s' "$resource" | jq -r '.remainingSeconds // empty')"
if [ -z "$release_at" ]; then
  log "provider reported no expiresAt — refusing to report an extension that moved no deadline"
  exit 1
fi

# 3. Re-emit the persisted result with the deadline moved, passing every other field through
#    untouched. An unchanged `connection` is what keeps the host attached with its live terminals;
#    a result that dropped it, or dropped `userData`, would be an error Orca shows the user.
result="$(printf '%s' "$payload" | jq -c --arg release "$release_at" \
  '.recipeResult | .userData.releaseAt = $release')"
if [ -n "$remaining" ]; then
  result="$(printf '%s' "$result" | jq -c --argjson seconds "$remaining" \
    '.userData.lifetimeSeconds = $seconds')"
fi
printf '%s\n' "$result"
```

Three notes worth carrying into a real hook:

- **`releaseAt` must come back with an offset.** `Z` and `+02:00` both pass. A local time with no
  offset is unusable, so format from the provider's own UTC value rather than from localtime. Only
  the _extension_ is refused for it: the host keeps the deadline it already had, and the refusal is
  retryable. (At create time an unreadable deadline is a warning rather than a failure, for the
  reason above.)
- **`lifetimeSeconds` is optional, and stale is worse than absent.** Set it from the provider's
  answer when there is one, and leave it out when there is not; it is never the countdown.
- **The hook shares its shape with `suspend`, `resume`, and `destroy`.** `ORCA_VM_MODE=extend` is
  set, so a provider with one shared lifecycle script can dispatch on it rather than on a separate
  file.

### Exercising the hook without a live lease

A provider author can run the hook from the command line, against a recipe result saved to a file,
with no desktop app and no live host:

```text
orca vm recipe extend <recipe-id> --recipe-result ./result.json --lifetime 4h --json
```

The lifetime must be one the recipe itself declares in `extendDurations`. The command prints the
updated result — check that `releaseAt` actually moved — and it only reports what the hook produced;
updating the persisted runtime is what extending a live lease from the app does.
