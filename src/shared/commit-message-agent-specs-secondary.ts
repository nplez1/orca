import type { TuiAgent } from './tui-agent'
import type {
  CommitMessageAgentSpec,
  CommitMessageModel,
  ThinkingLevel
} from './commit-message-agent-spec'

type SecondaryAgentSpecDeps = {
  BASIC_THINKING_LEVELS: ThinkingLevel[]
  parseCursorModels: (stdout: string) => CommitMessageModel[]
  parseAntigravityModels: (stdout: string) => CommitMessageModel[]
  parseLineModels: (stdout: string) => CommitMessageModel[]
  /** Copilot's probe and the catalog a machine without the binary falls back to. */
  copilotCatalog: {
    modelDiscovery: NonNullable<CommitMessageAgentSpec['modelDiscovery']>
    fallbackModels: CommitMessageModel[]
  }
}

export function buildSecondaryCommitMessageAgentSpecs({
  BASIC_THINKING_LEVELS,
  parseCursorModels,
  parseAntigravityModels,
  parseLineModels,
  copilotCatalog
}: SecondaryAgentSpecDeps): Partial<Record<TuiAgent, CommitMessageAgentSpec>> {
  return {
    amp: {
      id: 'amp',
      label: 'Amp',
      binary: 'amp',
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        '--execute',
        '--no-notifications',
        '--no-ide',
        '--no-jetbrains',
        '--mode',
        model,
        ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
      ],
      // Amp selects the model with `--mode`, not `--model`.
      singletonOptions: [['--mode']],
      modelSource: 'static',
      models: [
        { id: 'smart', label: 'Smart' },
        { id: 'rush', label: 'Rush' },
        {
          id: 'large',
          label: 'Large',
          thinkingLevels: BASIC_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'deep',
          label: 'Deep',
          thinkingLevels: BASIC_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        }
      ],
      defaultModelId: 'smart'
    },
    cursor: {
      id: 'cursor',
      label: 'Cursor',
      binary: 'cursor-agent',
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model }) => [
        '--print',
        '--mode',
        'ask',
        '--trust',
        '--output-format',
        'text',
        '--model',
        model,
        prompt
      ],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'cursor-agent', args: ['--list-models'], parse: parseCursorModels },
      models: [{ id: 'auto', label: 'Auto' }],
      defaultModelId: 'auto'
    },
    kimi: {
      id: 'kimi',
      label: 'Kimi',
      binary: 'kimi',
      // Why: kimi-code accepts the generation prompt only via --prompt/-p (Claude's
      // --print is rejected). Deliver on argv so --prompt receives the text (#11669).
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model, thinkingLevel }) => [
        '--prompt',
        prompt,
        '--quiet',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(thinkingLevel === 'on'
          ? ['--thinking']
          : thinkingLevel === 'off'
            ? ['--no-thinking']
            : [])
      ],
      modelSource: 'static',
      models: [
        { id: 'default', label: 'Config default' },
        {
          // Why: Kimi resolves its managed model by provider/model; bare model
          // names are rejected by the CLI with "LLM not set".
          id: 'kimi-code/kimi-for-coding',
          label: 'Kimi K2.6',
          thinkingLevels: [
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off' }
          ],
          defaultThinkingLevel: 'on'
        }
      ],
      defaultModelId: 'default'
    },
    muse: {
      id: 'muse',
      label: 'Muse',
      binary: 'muse',
      // Muse's `exec` subcommand accepts a positional prompt. Keep Source
      // Control AI one-shot and workspace-read-only, matching the other text
      // generators rather than launching the interactive TUI.
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model, thinkingLevel }) => [
        'exec',
        '--no-session-log',
        '--approval-mode',
        'never',
        '--disable-sandbox',
        '--disable-shell',
        '--disable-write',
        '--disable-web-tools',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(thinkingLevel ? ['--reasoning-effort', thinkingLevel] : []),
        '--',
        prompt
      ],
      singletonOptions: [['--model'], ['--reasoning-effort']],
      modelSource: 'static',
      models: [{ id: 'default', label: 'Config default' }],
      defaultModelId: 'default'
    },
    dsh: {
      id: 'dsh',
      label: 'DeepSeek Harness',
      binary: 'dsh',
      // Why: `dsh --profile headless` runs one fresh persisted session, prints the final
      // answer and exits — the documented one-shot entry mode. The interactive `dsh-tui`
      // profile is deliberately not used here; Source Control AI stays one-shot.
      // Why stdin and not argv: the prompt carries the whole diff. On argv it would sit in
      // the process table for every user on the box, and it would eventually hit the argv
      // limit. `-` is DSH's explicit stdin marker; measured against 0.1.5-rc.1, omitting the
      // positional entirely is rejected ("a task is required") even when stdin is a pipe.
      promptDelivery: 'stdin',
      buildArgs: () => ['--profile', 'headless', '-'],
      // Why: the launcher owns `--profile`; a second one would boot a different profile.
      singletonOptions: [['--profile']],
      modelSource: 'static',
      // Why: the headless app parses no `--model`. The model comes from the profile's
      // `llm-deepseek` row, so the only honest choice here is the configured default.
      models: [{ id: 'default', label: 'Config default' }],
      defaultModelId: 'default'
    },
    copilot: {
      id: 'copilot',
      label: 'GitHub Copilot',
      binary: 'copilot',
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model, thinkingLevel }) => [
        '--prompt',
        prompt,
        '--silent',
        '--stream',
        'off',
        '--no-custom-instructions',
        '--model',
        model,
        ...(thinkingLevel ? ['--reasoning-effort', thinkingLevel] : [])
      ],
      modelSource: 'dynamic',
      // Why: the CLI has no `models` subcommand, but `help config` documents the
      // `model` setting's accepted ids — the CLI's own catalog, so it keeps up
      // with models released after this file was written. (The interactive picker
      // is policy-filtered per account/org; this is the catalog behind it.)
      modelDiscovery: copilotCatalog.modelDiscovery,
      // Used verbatim only when the probe cannot run — no `copilot` on PATH — and
      // kept out of the cache, so a later probe replaces it.
      models: copilotCatalog.fallbackModels,
      defaultModelId: 'gpt-5.4'
    },
    antigravity: {
      id: 'antigravity',
      label: 'Antigravity',
      binary: 'agy',
      // agy's --print takes the prompt as its value (#19539, #14059). Deliver on argv
      // using `--print=<value>` so a leading-dash prompt binds to the flag instead of
      // being parsed as its own option, and --sandbox/--model stay separate options.
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model, thinkingLevel }) => [
        `--print=${prompt}`,
        '--sandbox',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
      ],
      singletonOptions: [['--model'], ['--effort']],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'agy', args: ['models'], parse: parseAntigravityModels },
      models: [{ id: 'default', label: 'Config default' }],
      defaultModelId: 'default'
    },
    jcode: {
      id: 'jcode',
      label: 'Jcode',
      binary: 'jcode',
      // Why: `jcode run` takes the message as a positional argv argument and has no
      // stdin prompt mode, so Source Control AI prompts ride argv (fine for branch
      // naming and small diffs, argv-capped on Windows).
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model }) => [
        // Why: these are jcode global options, so they must precede the subcommand;
        // clap rejects them after `run`.
        '--no-update',
        '--quiet',
        '--no-selfdev',
        // Why: the prompt here IS a staged patch, i.e. attacker-influenced text, and
        // jcode would otherwise expose shell/read/write/MCP to it. `none` resolves to
        // an empty allowed-tool set in jcode's config (tools.rs `base_allowed_tools`),
        // which drops `mcp` too since MCP is exposed as a tool. Matches the read-only
        // posture the other generators already take (claude plan, codex read-only).
        '--tool-profile',
        'none',
        ...(model && model !== 'default' ? ['--model', model] : []),
        'run',
        '--json',
        prompt
      ],
      singletonOptions: [['--model']],
      modelSource: 'dynamic',
      // Why: `jcode model list` prints one bare model id per line, which is exactly
      // what parseLineModels reads. Discovering beats a hardcoded list because
      // jcode's catalog spans every provider the user has authenticated.
      modelDiscovery: {
        binary: 'jcode',
        args: ['--no-update', '--quiet', 'model', 'list'],
        parse: parseLineModels
      },
      // Why: `default` is not a jcode model id — it is the sentinel that omits
      // --model so jcode uses the model from its own config.toml, rather than Orca
      // pinning a provider the user may not be logged in to.
      models: [{ id: 'default', label: 'Config default' }],
      defaultModelId: 'default'
    }
  }
}
