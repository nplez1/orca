# Command automations — the required Orca changes

Fork-local plan. The feature lands as PRs against the fork's `main`; this file never goes upstream.

## Why

Replacing the Hermes agent with an Orca bot needs one thing Orca cannot do: a scheduled job that runs a
**command** with no agent, no session and no model turn — today's equivalent of Hermes'
`cron/jobs.json` entry with `no_agent: true` and `script: agent_driver.py`. The fork's three live Hermes
jobs (`auto-issues` every 5m, `orca-discovery-launch`, `agent-watchdog`) are all deterministic scripts;
porting them as prompts would cost ~288 model turns a day and put a tuned reconcile policy into prose.

Second gap, corrected after reading the page: there is none. Enable/disable already exists —
`toggleAutomation` (`authoring/automation-management-actions.ts:42`) is wired to a row action and to the
detail header (`details/AutomationsDetailPane.tsx:171`); what was missing was a named CLI verb
(`update --enabled=false` was the way) and its documentation. Both now exist. "Pause all" would still be
new, and is optional.

## What already exists (reuse, do not rebuild)

| Piece | Where | Reused as |
| --- | --- | --- |
| Shell execution, local + SSH, timeout, tree-kill, tail truncation | `src/main/automations/dispatch/precheck-runner.ts` (`runAutomationPrecheck:279`) | the command executor |
| Run output display incl. stdout/stderr fallback | `src/shared/automations/history/automation-run-content.ts:11` | run detail, unchanged |
| Schedule/cron/rrule, `enabled` gating, missed-run policy | `automation-due-runs.ts:26`, `scheduling/` | nothing to add |
| Run claiming, folding identical refusals, retention | `run-history/` | nothing to add |
| Bot-folder cwd resolution, bot paused → skip | `src/main/automations/bot-run-target.ts:52` | cwd rule for a bot-targeted command |
| Store-level disable | `automation-schedule-operations.ts:93` (`disableAutomations`) | "pause all" |

## Locked decisions

1. **The action is a union on the automation, absent = agent.** `action?: { kind: 'agent' } | { kind:
   'command'; script: AutomationScript }`. Every stored record lacks `action`, so it parses as agent.
2. **`agentId` becomes `TuiAgent | null`** — null only when `action.kind === 'command'`. One field, no
   duplicate launch identity.
3. **cwd is the resolved target's cwd**, exactly as a precheck and an agent run get it: a repo
   automation runs in its workspace, a bot automation in the bot's folder. No separate `cwd` field in
   v1.
4. **Shell mode is explicit and defaults to `login`** (`$SHELL -lc '<command>'`). The fork's PATH pins
   live in `~/.zshenv`/`~/.zprofile` (node 24.22.1 via fnm, bash 5.3); a plain `sh -c` cannot see them
   and the "works in my terminal, fails in the automation" trap is the top support risk. Prechecks keep
   their existing plain behaviour — changing them would alter every saved automation.
5. **`report` is `silent | on-output | always`, default `on-output`.** Print and it is delivered; print
   nothing and the run is silent. That is Hermes' `deliver: origin` + "silent unless changed" and the
   script-side twin of `BOT_QUIET_MARKER` (`NO_REPLY`, `src/shared/bot-quiet-result.ts:4`).
6. **No new run status.** A non-zero exit is `dispatch_failed` with the stderr tail in `error`; a tick
   skipped because the previous command is still running is `skipped_unavailable` with
   `errorCode: 'overlap'` (folded by the existing refusal folding). Shapes older clients already parse.
7. **`sessionKind` gains `'script'`**, behind `automations.command.v1`. A host that has not got it strips
   the action and, having no `agentId`, refuses to run — the same posture `bot` and `extraAgentArgs`
   document.

## Data model

```ts
export type AutomationScript = {
  command: string
  timeoutSeconds: number // required; 60..3600, default 600
  shell: 'login' | 'plain' // default 'login'
  report: 'silent' | 'on-output' | 'always' // default 'on-output'
}
export type AutomationAction = { kind: 'agent' } | { kind: 'command'; script: AutomationScript }
```

Rejected for v1: env overrides (the command can `export`), a per-automation concurrency knob (the tick
guard is enough until a slow script proves otherwise), a bare "run this file" mode (one shell string is
enough and matches precheck).

## Slicing, corrected once the code was read

`agentId` becoming nullable is not a record-only change: the renderer's draft models, agent pickers and
save paths all take a `TuiAgent`, so every file that shows or edits an automation must move with the
type. The record change therefore cannot land alone, and the CLI's `--script` flag is useless before it.
The five content sections below stay as the specification; the delivery boundaries are these:

| Order | What lands | State |
| --- | --- | --- |
| 1 | Executor extraction: `command-runner.ts`, precheck delegates to it | landed, `be362fcbbec` |
| 2 | Enable/disable from the CLI, with spec, help and skill guide | landed, `d643551074c` |
| 3 | ~~The page's enable/disable switch~~ — already present; only "Pause all" would be new | not needed |
| 4 | Script automations: record + RPC contract + renderer + CLI in one PR | needs the unit gate |
| 5 | Dispatch a command run, and settle report/delivery | after 4 |

Step 3 is separate from 4 on purpose: a switch is a page change, and a switch that waits on a nullable
`agentId` is a switch nobody gets for a week.

## The changes, in order

### PR 1 — executor extraction (pure refactor, no behaviour change)

- `src/main/automations/dispatch/command-runner.ts`: the local spawn + SSH channel halves of
  `precheck-runner.ts`, with the public shape `runHostCommand({ command, cwd, timeoutSeconds, shell,
  target }) => AutomationCommandResult` where `AutomationCommandResult` is today's
  `AutomationPrecheckResult` renamed (shared type, one definition).
- `precheck-runner.ts` keeps `runAutomationPrecheck` and `failedPrecheckResult`, delegating with
  `shell: 'plain'`. `killLocalPrecheckProcessTree` keeps its name (call sites in WSL/host code stay).
- Tests: local exit-0/exit-non-zero/timeout/stderr, SSH not-connected refusal. These are a process
  boundary with tree-kill and truncation, so they earn a test.

### PR 2 — the record: schema, persistence, capability

- `automation-definition.ts`: `action`, `AutomationScript`, nullable `agentId`; same on
  `AutomationCreateInput` / `AutomationUpdateInput`.
- `automation-definition-operations.ts:113` + `automation-definition-update.ts`: normalize `action`
  (absent → `{kind:'agent'}`; `agentId` null iff command) so a stored record round-trips byte-identically.
- One normalization pass in `automation-context-migration.ts`'s pattern, so a record written by a newer
  host and read by an older one degrades to "no action, no agent → refuse to run" instead of a crash.
- `automation-runtime-capabilities.ts`: `automations.command.v1` in both capability lists.
- `src/main/plugins/workers/host-api/plugin-automation-projection.ts`: strip `action` exactly as
  `precheck` is stripped — a plugin may never set a command. Consent copy gets the same treatment as
  "a precheck command" (`plugin-confirmation-copy.ts`).
- Test: a round-trip of an agent record and a command record through the store, and the plugin
  projection dropping `action`.

### PR 3 — dispatch

- `automation-dispatch-request.ts`: after the claim and any precheck, branch on
  `action.kind === 'command'` → run the command in the resolved cwd, then
  `runs.updateRun({ status: 'completed' | 'dispatch_failed', outputSnapshot, ...capture })`. No launcher,
  no session, no workspace creation even when `workspaceMode === 'new_per_run'` (a command has no
  session to put in one; the mode is not offered in the editor for a command).
- Overlap guard: a tick whose previous run of the same automation is `pending`/`dispatching` records the
  folded overlap refusal instead of starting a second command.
- Delivery: `report: 'on-output'` posts the captured output into the automation's chat target (bot chat
  or run detail) only when non-empty; `'always'` posts a one-line summary. **Settle here, by reading
  `bot-automation-launch.ts`: whether that post is a message the bot replies to, or mail that wakes it.
  If it is only a message, the driver's blocking cases call `orca bot ask --bot <name>` itself
  (`src/cli/bots/fork-bot-ask.ts`, mail path, blocks for the answer) and `report` stays
  visibility-only.**
- Test: command exit 0 and exit non-zero through `requestAutomationDispatch`, asserting the run record's
  status, output and error.

### PR 4 — CLI

- `--script <command>` on `automations create|update` as the discriminator alongside `--agent`;
  `--script-timeout`, `--script-shell login|plain`, `--report silent|on-output|always`.
- `automations enable|disable <id>` as a thin wrapper over the existing update (today it needs
  `update --enabled=false`; a named verb is what a person types).
- `automations run <id>` already exists for manual runs — a command automation's manual run is the same
  path, so `--json` output shows the captured output rather than a session handle.

### PR 5 — the page

- Editor: an action picker ("Runs: a script / an agent") above the destination; script mode swaps the
  agent/prompt/setup sections for command (monospace), timeout, shell, report. Cron panel unchanged.
- List: `script` badge instead of the agent icon; the enable/disable switch on the row and in the detail
  header (external OpenClaw rows already have pause/resume — `AutomationListExternalRow.tsx:208` — so
  this is matching an existing idiom, not inventing one).
- Runs: no session link; exit code, duration and the output panel the precheck already renders.
- "Pause all" in the page header over `disableAutomations`, with a confirm naming the count.

## Acceptance

- A bot-targeted command automation on `--every 5m` runs `python3 …/agent_driver.py` in the bot's folder,
  records exit code and output, stays silent when the script prints nothing, and can be switched off from
  the page in one click.
- No stored agent automation changes shape; `automations list` on an older host shows them unchanged.
- A plugin cannot create or edit a command automation.
- `pnpm check:changed` clean on each PR; the unit-gate rule applies to PR 2 (`src/shared/**` is a global
  input — run `orca-queue node local/gate-unit.mjs` before opening it).

## Out of scope

- Running a command as a different user, or with a curated env.
- Script output streaming while it runs (the run shows output when it ends).
- Replacing the bot-automation path: a command automation never starts an agent.
- The Hermes migration itself — that starts only after PR 5 lands.
