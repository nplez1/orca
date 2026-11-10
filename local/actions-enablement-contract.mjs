// What this fork has decided may be enabled, as data.
//
// Why its own module: `local/check-actions-enablement.mjs` judges against these tables and had grown
// past the 600-line `max-lines` budget. This is also the half a person edits — the live list, the pinned
// triggers, the crons, the runner exceptions — so it is the half worth reading on its own. Nothing here
// is logic; every entry carries the reason it exists.

// Must stay enabled: the release build, the daily v* tag mirror, the nightly full unit suite, the
// cheap PR lane, the daily health check that watches the rest, and the lanes enabled on
// 2026-10-31 after the cost premise was measured to be zero (LOCAL-PATCHES.md § local(ci)).
export const REQUIRED = [
  '.github/workflows/fork-release.yml',
  '.github/workflows/fork-upstream-tags.yml',
  // Why the unit lane is required and not merely allowed: `AGENTS.md` moved the full unit suite off
  // the PR boundary and onto this nightly lane, so with it disabled nothing verifies `main`
  // between merges — a cross-cutting break sits on the release line until someone runs the release
  // gate by hand. Treating "disabled" as drift is the whole point: this is the backstop, and a
  // backstop nobody notices is off is not one. See LOCAL-PATCHES.md § local(ci) before changing it.
  '.github/workflows/fork-main-tests.yml',
  // Why: the cheap PR lane `LOCAL-PATCHES.md` § local(ci) decided on. A lane a ruleset can require is
  // worthless disabled, and nothing else would say so.
  '.github/workflows/fork-pr-gates.yml',
  // Why: this is the check that watches the health checks. An unwatched watchdog is exactly the
  // failure `LOCAL-PATCHES.md` § local(ci) records, so a disabled one is drift, not a preference.
  '.github/workflows/fork-ci-health.yml',
  // Why: the only lane that runs repo-wide oxlint, max-lines, localization catalogs and `pnpm tc` on
  // the release line. It was off from 2026-10-08 to 2026-10-31 and nothing reported that, which is the
  // gap this entry closes.
  '.github/workflows/fork-main-gates.yml',
  // Why: supply-chain audit, path-gated to lockfile/Cargo/patches changes, so it costs nothing on an
  // ordinary PR and covers the one class of change a unit lane cannot see.
  '.github/workflows/dependency-security.yml',
  // Why: mobile parity is first-class in `AGENTS.md` and no PR lane here covered it. Its `push: [main]`
  // leg is path-gated, and `main` is this fork's own line since the 2026-11-09 rename — so that leg now
  // re-tests the release line where it used to re-test the upstream mirror.
  '.github/workflows/mobile.yml',
  // Why: the headless/remote server path is first-class too. Its `fast_runners` input defaults to true
  // for dispatch and call, so a manual dispatch lands on `blacksmith-*` labels this fork lacks; PR and
  // schedule events pass no input and stay on hosted runners.
  '.github/workflows/node-server-tests.yml',
  // Why: auto-update correctness, ~7 min of macOS across six observed PR runs.
  '.github/workflows/macos-updater-tests.yml',
  // Why: perf regression contract on PRs and nightly, 21 of 24 observed runs green.
  '.github/workflows/performance-contracts.yml'
]

// Inert without a manual dispatch or a caller — active is fine, and so is disabled. Their pinned
// triggers below are the same claim, spelled out.
export const ALLOWED_INERT = [
  '.github/workflows/zcode-account-contract.yml',
  '.github/workflows/unit-module-cache-benchmark.yml',
  '.github/workflows/windows-native-preparation-benchmark.yml',
  '.github/workflows/ci-cache-warmup-platform-jobs.yml',
  '.github/workflows/qualified-orcad-template.yml',
  '.github/workflows/layout-owner-e2e.yml',
  '.github/workflows/dev-channel-win-publish.yml'
]

/**
 * The exact `on:` keys every enabled file is allowed to have, as data rather than as a rule, because a
 * rule cannot tell "this lane grew a schedule" from "this lane always had one". A sync that edits a
 * trigger fails here instead of quietly adding work; a deliberate change updates this table in the
 * same commit, which is what makes the change visible in review.
 *
 * An enabled file with no entry is reported too: pinning is the guard, not an optional extra.
 */
export const EXPECTED_TRIGGERS = {
  '.github/workflows/fork-release.yml': ['workflow_dispatch'],
  '.github/workflows/fork-upstream-tags.yml': ['schedule', 'workflow_dispatch'],
  '.github/workflows/fork-main-tests.yml': ['schedule', 'workflow_dispatch'],
  '.github/workflows/fork-pr-gates.yml': ['pull_request', 'workflow_dispatch'],
  '.github/workflows/fork-ci-health.yml': ['schedule', 'workflow_dispatch'],
  '.github/workflows/fork-main-gates.yml': ['schedule', 'workflow_dispatch', 'push'],
  '.github/workflows/dependency-security.yml': [
    'pull_request',
    'workflow_call',
    'workflow_dispatch'
  ],
  '.github/workflows/mobile.yml': ['pull_request', 'push'],
  '.github/workflows/node-server-tests.yml': ['pull_request', 'workflow_dispatch', 'workflow_call'],
  '.github/workflows/macos-updater-tests.yml': ['pull_request', 'workflow_dispatch'],
  '.github/workflows/performance-contracts.yml': ['workflow_dispatch', 'pull_request'],
  '.github/workflows/zcode-account-contract.yml': ['workflow_dispatch'],
  '.github/workflows/unit-module-cache-benchmark.yml': ['workflow_dispatch'],
  '.github/workflows/windows-native-preparation-benchmark.yml': ['workflow_dispatch'],
  '.github/workflows/ci-cache-warmup-platform-jobs.yml': ['workflow_call'],
  '.github/workflows/qualified-orcad-template.yml': ['workflow_call'],
  '.github/workflows/layout-owner-e2e.yml': ['workflow_dispatch'],
  '.github/workflows/dev-channel-win-publish.yml': ['workflow_call']
}

/**
 * The only files allowed to carry a `schedule:` trigger, each with the reason it needs a clock.
 *
 * Why this is separate from `EXPECTED_TRIGGERS`: that table pins which triggers an enabled lane has, so
 * it can only catch a trigger being added to a file someone already thought about. It recorded
 * `schedule` as expected for `node-server-tests.yml` and `performance-contracts.yml` — both upstream
 * files nobody on this fork wrote, both firing upstream's cron daily — and pinning the status quo is not
 * the same as approving it.
 *
 * On 2026-11-06 GitHub disabled Actions on this repository for exactly that: "Workflows inherited from
 * the upstream repository often run on schedules or events that aren't needed on a fork." Nothing in
 * this file objected, because the objectionable crons were pinned as expected. A list that has to name
 * the reason, rather than one that records what is already there, is the difference.
 *
 * An entry here is a claim that this fork needs the lane to run on a clock. An enabled file with a
 * `schedule:` and no entry is reported and is never auto-disabled: the fix is to delete the cron from
 * the file, not to switch the whole lane off.
 */
export const FORK_SCHEDULES = {
  '.github/workflows/fork-main-tests.yml':
    'the nightly unit backstop — nothing else tests main between merges',
  '.github/workflows/fork-main-gates.yml':
    'repo-wide oxlint, max-lines, localization catalogs and `pnpm tc` on the release line',
  '.github/workflows/fork-ci-health.yml':
    'watches the other lanes; a watchdog with no clock is not one',
  '.github/workflows/fork-upstream-tags.yml':
    "mirrors upstream's release tags, which the fork's release line is cut from"
}

/**
 * Files that do name a runner this fork does not provision, each with the exact labels it may name and
 * the reason. Per label rather than per file: a new `blacksmith-*` in one of these files still fails,
 * which is what stops the exception from covering a job added later.
 *
 * Two of these are reached only through `workflow_call`, and a called workflow runs whether or not it
 * is enabled — so `unit-tests.yml`, which two active lanes call, belongs here even though its own state
 * is disabled.
 */
export const ACCEPTED_RUNNER_LABELS = {
  '.github/workflows/node-server-tests.yml': {
    labels: [
      'blacksmith-2vcpu-ubuntu-2404',
      'blacksmith-4vcpu-ubuntu-2404',
      'blacksmith-6vcpu-macos-15',
      'blacksmith-8vcpu-ubuntu-2204',
      'blacksmith-8vcpu-ubuntu-2404',
      'blacksmith-8vcpu-ubuntu-2404-arm'
    ],
    reason:
      'behind `fast_runners`, true only for dispatch and call; PR and schedule events pass no input'
  },
  '.github/workflows/ci-cache-warmup-platform-jobs.yml': {
    labels: [
      'blacksmith-4vcpu-ubuntu-2404',
      'blacksmith-4vcpu-ubuntu-2404-arm',
      'blacksmith-8vcpu-ubuntu-2404'
    ],
    reason: 'reachable only through workflow_call, and both of its callers are disabled'
  },
  '.github/workflows/unit-tests.yml': {
    labels: ['blacksmith-4vcpu-ubuntu-2404'],
    reason:
      'the `runner` input default; fork-main-tests and fork-release both pass ubuntu-24.04-arm'
  },
  '.github/workflows/e2e.yml': {
    labels: ['blacksmith-4vcpu-ubuntu-2404', 'blacksmith-8vcpu-ubuntu-2404'],
    reason:
      'each `runs-on` is gated on `inputs.fast_runners`, which defaults false; reached only from dispatch-only lanes'
  }
}
