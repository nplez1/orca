# Look around for pi

**Status:** built and shipped as a fork patch, 2026-11-22 (`local(bots)`, PR #451). This note is the
design as built; the code, the anchors and the churn reasoning are `LOCAL-PATCHES.md` § `local(bots)`.
**Why:** a bot's look-around run is the feature that makes a bot proactive rather than cron-driven, and
it ran only on `claude` and `codex` until this patch. pi is the agent this fork's owner actually uses, so
the one agent they cared about was the one that could not look around.
**Placement: a fork patch** (`local(bots)`), decided 2026-11-21. `LOCAL-PATCHES.md` is the record; the
`local(bots)` entry must name each upstream anchor below, because those are the lines a sync moves.

### Making a fork patch of this cheap

Three of the fork's own rules decide the shape, so they come first:

- **No fork comment in a file upstream owns** (`LOCAL-PATCHES.md` § Rules, enforced by
  `local/check-upstream-file-comments.mjs` against a total frozen at 5113 and allowed only to shrink).
  So every touch on an upstream file is a bare line, and every _reason_ lives in
  `LOCAL-PATCHES.md` and in the fork-owned module.
- **A fork hook names an exported function in a fork module, not a prose block.** Same rule, read from
  the other end: the upstream diff should say `...piReadOnlyGateArgs()` and nothing else.
- **Prefer the file upstream touches least.** Measured over the last 180 days of `upstream/main`:

  | File                                               | Upstream commits | Verdict                 |
  | -------------------------------------------------- | ---------------- | ----------------------- |
  | `src/shared/bots/bot-look-around.ts`               | 2                | safe — one word         |
  | `src/main/runtime/rpc/methods/bots-look-around.ts` | 1                | safe — one string       |
  | `src/main/bots/bot-look-around-runner.ts`          | 2                | safe — one expression   |
  | `src/main/pi/rpc/launch/rpc-launch.ts`             | 6                | take the wiring here    |
  | `src/main/pi/rpc/launch/rpc-launch-resolution.ts`  | 11               | **avoid: the hot file** |

That last row is why the gate is not wired in the resolution layer, where `backgroundWork` and
`botTools` are wired. It does not need to be: `buildPiRpcLaunch` already receives
the mode as `options.tools` (`'read'` for a look run), and the file it has to name is a static fork asset,
so the fork module can write it itself and hand back the arguments.

One constraint that decides where the write happens: **`buildPiRpcLaunch` is synchronous** (it returns
`ProviderProcessLaunch` directly), while the existing `writePiExtensionFile` is `async`. The fork module
therefore writes synchronously (a `writeFileSync` guarded by the same "already the right content"
compare) and returns `['--extension', path]`. An async helper here would not compile into that call site,
which is worth knowing before someone reaches for the existing one.

## The gate, and everything it silently controls

One constant decides it:

```ts
// src/shared/bots/bot-look-around.ts:9 — "Only these agents have a place where Orca can hold a run to reads."
export const LOOK_AROUND_AGENTS = ['claude', 'codex', 'pi'] as const
export function lookAroundSupported(agent: string): boolean // :11
```

Eleven call sites in nine files read `lookAroundSupported`, and adding `'pi'` flips all of them at once:

| Reader                                                                                                         | Effect                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `bot-look-around-state.ts:311`                                                                                 | the setting is honoured — `botLookAround(bot).on && lookAroundSupported(bot.agent)`                          |
| `bot-look-around-runner.ts:118, 163, 202`                                                                      | whether a slot is due, `Look now` is allowed, and a started look may continue                                |
| `bot-memory-tidy-up-runner.ts:106`, `bot-memory-tidy-up.ts:162`                                                | **Tidy-up rides along** — it reads the same constant, so pi gets overnight memory tidying in the same change |
| `bots-look-around.ts:75`                                                                                       | the CLI refusal, now `'This bot’s agent cannot look around.'` — a capability, not a list of names            |
| `BotLookAroundSection.tsx:89`, `BotTidyUpSection.tsx:54`, `BotSettingsRoot.tsx:368`, `bot-upcoming-rows.ts:26` | the renderer's two settings sections and the Up-next rows                                                    |

That coupling is worth stating explicitly, because tidy-up is the easier half and someone reviewing a
"look around for pi" patch will want to know why memory consolidation changed too.

## What pi already has

The launch side is **done and tested**; this is not a from-scratch agent integration.

```ts
// src/main/pi/rpc/launch/rpc-launch.ts
const PI_READ_TOOLS = ['read', 'grep', 'find', 'ls', 'bash'] as const     // :72
const PI_LIMITED_TOOLS_MINIMUM_VERSION = '1.0.4'                         // :89
export function piToolLimit(readOnly, launchVersion): PiToolLimit | null  // :92
//   'reply-only' → 'none'   ·  'look-around' → 'read'  ·  else null
...(options.tools === 'read'                                                  // :180
  ? ['--tools', PI_READ_TOOLS.join(','), '--no-mcp', ...piReadOnlyGateArgs()] : [])
...(options.tools === 'none' ? ['--no-tools', '--no-mcp'] : [])
```

- `PiToolLimit` is already computed from `basis.readOnly` in `rpc-launch-resolution.ts:210`, and
  `basis.readOnly` is set by the shared composition (`structured-agent-launch-composition.ts:190`), which
  is also what feeds `readOnlySession` (`bot-structured-session-wiring.ts:304`).
- `PI_TOOL_SELECTION_FLAGS` already refuses any other tool selection on a limited run, "which could widen
  it" — that guard must stay, and must grow if the read set grows.
- The unit test pins both mappings (`rpc-launch.test.ts:25`: `['read', ['--tools', 'read,grep,find,ls,bash', '--no-mcp', '--extension', <gate>]]`).
- **A reply-only run needs nothing more**: `--no-tools --no-mcp` is the whole of tidy-up's requirement,
  so tidy-up could ship on its own before look-around does.

## The gap that makes it useless today

`--tools read,grep,find,ls` offers no shell, and the look-around prompt's entire job is shell reads:

```
gh pr view|list|checks|diff · gh issue|run view|list · git log|show|diff|status|rev-parse|ls-files
orca bot connectors|list · orca slack find|read|check · orca linear issue|search · orca automations list
orca repo list · orca worktree ps
```

`src/main/bots/bot-look-around-prompt.ts:25`. So a pi look run would read files in its own home, find
nothing about the owner's work, and suggest nothing — a run that costs tokens and cannot succeed. The
feature must therefore bring a **policy-checked shell**, not just the setting flip.

The other two agents each carry that shell guard somewhere per-agent:

| Agent  | Where the guard lives                                             | Shape                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude | `src/main/claude/claude-structured-read-only-options.ts`          | SDK `PreToolUse` hook answering `allow`/`deny` from `lookAroundToolDecision()` (:18), plus `disallowedTools` (:44). Comment: "An SDK hook beats the user's allow rules and full access, and covers MCP tools." |
| Codex  | `src/main/codex/structured/prompts/codex-structured-read-only.ts` | every approval answered from the same allow-list instead of a person; `unwrapShell()` handles Codex wrapping commands as `/bin/zsh -lc '<command>'` (`bot-look-around-policy.ts:109`)                          |
| pi     | **nothing**                                                       | `--tools` selection only                                                                                                                                                                                       |

The policy itself is agent-agnostic already — `lookAroundCommandAllowed()` (`bot-look-around-policy.ts:118`)
allow-lists programs and subcommands, refuses widening arguments, keeps `gh` on github.com, and refuses
anything with shell syntax. Nothing about it is Claude-shaped. What is missing is a place to call it
from inside a pi run.

## Design

**pi's `tool_call` event can block**, and Orca already ships managed pi extensions: `backgroundWork` and
`botTools` are each a file passed as `--extension <file>` at launch (`rpc-launch.ts:183-184`), and the
status and titlebar extensions are installed into pi's agent dir instead. So the guard is a managed
extension, in the same two-layer shape as Claude:

1. **Layer 1 — the tool selection.** For a look run, pi gets
   `--tools read,grep,find,ls,bash --no-mcp`: a narrow set with the one dangerous tool included.
   `PI_TOOL_SELECTION_FLAGS` keeps a user from widening it.
2. **Layer 2 — the per-call gate.** A new managed extension, registered only for a read-only session,
   handling `tool_call`:

```ts
const BOUNDED_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

pi.on('tool_call', async (event) => {
  const toolName = event && typeof event.toolName === 'string' ? event.toolName : null
  if (toolName !== null && BOUNDED_TOOLS.has(toolName)) return undefined
  // bash is held to the policy; anything else - an extension's own tool, a subagent - is bounded by
  // neither layer, so it is refused.
  const command =
    toolName === 'bash' && event.input && typeof event.input.command === 'string'
      ? event.input.command
      : null
  return command !== null && allowed(command) ? undefined : { block: true, reason: REFUSAL }
})
```

Denying by default is the shape that shipped, and the reason: `--tools` bounds pi's own built-in tools,
but a look run still loads the user's extensions and packages, and nothing in the tree says `--tools`
also removes tools those register. It is the answer `lookAroundToolDecision()` already gives Claude for
an unknown tool.

`{ block: true, reason }` is pi's own contract — the `tool_call` event is documented as one that "Can
block", returning `{ block: true, reason?: string }` — and the refusal text is the existing
`LOOK_AROUND_REFUSAL` — "Looking around can only read.
Suggest this as a next step instead." — so a blocked pi run tells its owner the same thing a blocked
Claude run does. For a reply-only session the extension is not installed at all: layer 1 already means
no tools, and a tidy-up has nothing to gate.

**The honest limit of this.** For pi, `permissionMode: 'ask'` — which the shared composition sets for
every read-only session (`structured-agent-launch-composition.ts:231`) — carries **no weight**: pi's
structured chat is full access only (`rpc-launch.ts:113`, `throw new Error('Pi structured chat supports
full access only')`), and `fullAccess` is resolved independently of `readOnly`
(`rpc-launch-resolution.ts:231`). So unlike Claude, where the hook is backed by the CLI's own permission
engine, pi's guarantee is _two Orca-side guards inside the agent process_. The extension runs with the
agent's full OS permissions. That is the same class of guarantee Claude's hook gives in practice, and it
should be written down rather than implied.

## Two things that will bite if ignored

**1. pi older than 1.0.4.** `piToolLimit` throws `AgentCliInstallationError.tooOld('pi', …)`
(`rpc-launch.ts:101`). Until this patch that could not fire, because look-around never ran for pi. Now
an older install fails _every_ look; the failure is recorded against the run
(`LOOK_FAILURES`, `bot-look-around-runner.ts:46`), and **ten in a row turn look-around off**
(`bot-look-around-failures.ts:8`, `LOOK_FAILURES_TO_TURN_OFF`). The owner would see a feature that
switched itself off with "The last look couldn't start." and no hint that pi needed updating — because the
runner `console.warn`s the cause and then records the generic message.

The upstream fix is to make the setting's offer depend on the host's agent capabilities. The fork took
the cheap version: `bot-look-around-start-failure.ts` formats the installation problem it finds in the
error's cause chain with `agentCliTooOldWords`, so the run's record reads _Your Pi CLI on this computer is
1.0.3. Chats need 1.0.4 or newer_ instead of a shrug. The capability shape stays an upstream follow-up.
Tidy-up inherits the same trap (`piToolLimit` refuses `'reply-only'` at the same version) and still
records the generic line; that half is recorded in the ledger, not fixed.

**2. Copy that names agents.** `'Look around needs a Claude Code or Codex bot.'`
(`bots-look-around.ts:75`) is refused by a literal. With pi supported it is simply wrong, and it is one
string in a file upstream touched once in 180 days — taken: the line now reads `'This bot’s agent cannot
look around.'`, a capability question. (`bot-preamble.ts:63` only says look-around
exists, naming no agent, so it needs nothing.)

## Recommended shape, later: a capability, not a list

`LOOK_AROUND_AGENTS` is a list because only two agents had a read-only lane. A fork is the wrong place to
fix that shape: the eleven call sites would each need an upstream edit, which is precisely the divergence this
patch is trying to avoid. So the fork keeps the list, adds `'pi'`, and grows a `local(bots)` entry. If the
shape is ever worth fixing, it is worth fixing upstream — as a follow-up PR, not as a prerequisite here.

## Edit list

**Mandatory — the feature does not work without these three.**

| Change                                                       | File                                       | Lines           |
| ------------------------------------------------------------ | ------------------------------------------ | --------------- |
| `'pi'` in the gate                                           | `src/shared/bots/bot-look-around.ts:9`     | 1 word          |
| `'bash'` in the read set                                     | `src/main/pi/rpc/launch/rpc-launch.ts:72`  | 1 word          |
| Spread the gate into a limited run's args, beside `--no-mcp` | `src/main/pi/rpc/launch/rpc-launch.ts:180` | 1 line + import |

**Fork-owned — all the logic, the extension source and the rationale.**

| Piece                                                                  | Path                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Gate extension source + sync writer + `piReadOnlyGateArgs()`           | new `src/main/pi/fork-read-only-gate.ts`                          |
| Unit tests for the gate module, the per-path corpus and the policy pin | `src/main/pi/fork-read-only-gate.test.ts`                         |
| The recorded start failure, and its words                              | new `src/main/bots/bot-look-around-start-failure.ts` + `.test.ts` |
| The `local(bots)` record with anchors and churn                        | `LOCAL-PATCHES.md`                                                |

The extension's source is a template string, the same shape as `PI_BOT_TOOLS_EXTENSION_SOURCE`
(`src/main/pi/rpc/launch/rpc-launch-resolution.ts:48`), and it imports nothing — pi loads it in-process,
so it must carry its own copy of the decision rather than importing `lookAroundCommandAllowed`. That is a
duplication to keep honest, and a command corpus alone cannot do it: a corpus proves the two copies agree
on the commands it lists, never that upstream did not _tighten_ the policy after a security report. So the
fork test does both — one allowed case and one refused-argument case for every `READ_COMMANDS` path in
`bot-look-around-policy.ts`, plus a sha256 pin over that module's policy text that fails with "upstream
changed the look-around policy; re-mirror fork-read-only-gate.ts and update this hash".
**`src/main/bots/bot-look-around-policy.ts` is therefore a file the next sync must watch**, and the only
fork-side file that mirrors it is the template string in `fork-read-only-gate.ts`.

**Taken — both landed.**

| Why                                                                                                      | File                                                                                                |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The refusal names agents: `'Look around needs a Claude Code or Codex bot.'` became a capability question | `src/main/runtime/rpc/methods/bots-look-around.ts:75`                                               |
| A too-old pi says _why_ instead of "The last look couldn't start." ten times                             | `src/main/bots/bot-look-around-runner.ts:264`, with the words in `bot-look-around-start-failure.ts` |

**Nothing to change in the renderer.** Both settings sections already `return null` on
`lookAroundSupported(bot.agent)` (`BotLookAroundSection.tsx:89`, `BotTidyUpSection.tsx:54`), so the pi bot
simply grows the two sections when the constant changes — no copy names an agent there.

No file is drawn from a PR branch's ownership, and no fork-only path is added outside `src/main/pi/`.

## Verification

- Unit: `piToolLimit` maps `'look-around'` → `['--tools','read,grep,find,ls,bash','--no-mcp', gate]` and
  `'reply-only'` → `['--no-tools','--no-mcp']`; `PI_TOOL_SELECTION_FLAGS` still refuses `--tools` on a
  limited run.
- Unit: every `READ_COMMANDS` path is allowed and loses one refused argument in both copies; the shell
  prefix, `bash -lc` wrappers, repositories and URLs agree; `gh pr merge`, `git push`, shell syntax and an
  unparsable command are blocked; a tool neither layer bounded is blocked; and the policy text is pinned.
- Recorded against the real CLI (`pi` 1.6.0): with the generated gate loaded and
  `--tools read,grep,find,ls,bash`, `git log --oneline -1` runs and returns its output; `git push
  --dry-run origin main` and `git diff --output=… HEAD~1` are both refused with the gate's own words; and
  an `-e` path that does not exist stops the launch (exit 1), which is what the synchronous writer's
  atomic rename depends on.
- Not driven: a whole bot look run (`Look now` → one suggestion in Up next) against a real pi bot. The
  transcripts above are the CLI half of it.
- Gate: `pnpm run check:code-quality:changed`, `pnpm tc:node`, and
  `node local/check-upstream-file-comments.mjs` — the last one is the one that will fail first if a fork
  comment slips into an upstream file. Then the fork PR path (`local/open-pr.mjs`).

## Open questions

- ~~Does pi's `bash` tool event carry `{ command }` under those names?~~ **Answered** by the recorded run
  on `pi` 1.6.0: `tool_call` arrives as `{ toolName: 'bash', input: { command } }`, no shell wrapper, and
  the gate's allow and refuse paths both fire. A 1.0.4 host is still unverified.
- ~~Does `--tools read,grep,find,ls,bash` accept `bash` in the same comma list?~~ **Answered** for 1.6.0:
  the bash tool is callable under that selection, and the gate sees every call. Unverified on 1.0.4, which
  is the version the launch refuses below.
- pi has a `user_bash` event that can handle a command typed by a person. Nobody types in a look run, and
  the gate attaches to it anyway; its refusal shape is unit-tested but not recorded against the CLI.
- Should the extension also gate `read` to the bot's home folder? Claude's `READ_TOOLS` are allowed
  anywhere, so today's answer is no; but a look run only needs its own folder, and a path-scoped read is
  strictly better. Deferred so the first patch matches Claude's behaviour rather than exceeding it.
- A later extension can rewrite `input.command` after this gate allowed it: pi runs `tool_call` handlers
  in load order and does not re-validate. `Object.freeze(event.input)` would close it and break every bash
  call for a user whose own extension mutates bash, so it is a known limit owned by the user's own code.
- The too-old sentence says "Chats need 1.0.4 or newer" while pi chats run from 0.84.0 and only limited
  runs need 1.0.4. The copy is upstream's shared text, not the fork's to change here.
- Other agents (`grok`, `opencode`, `omp`, `cursor`, `copilot`) — the capability shape above is what makes
  each of those cheap later; do not hand-add them to the list.
