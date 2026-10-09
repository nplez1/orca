import type { CommitMessageAgentSpec, CommitMessageModel } from './commit-message-agent-spec'
import { OPENAI_THINKING_LEVELS } from './commit-message-model-parsers'
import { labelFromModelId } from './model-id-label'

// Why: the Copilot CLI has no `models` subcommand, but `help config` documents the
// `model` setting's accepted ids — the CLI's own catalog, so the list keeps up with
// models released after this file was written. Its interactive picker is
// policy-filtered per account/org; this is the catalog behind it.
const COPILOT_MODEL_LIST_ARGS = ['help', 'config']

const COPILOT_AUTO_MODEL_ID = 'auto'

/**
 * Parses `copilot help config`: the `model` setting's heading, then its accepted
 * ids as quoted bullets, ended by the next documented setting.
 *
 * A format change parses to nothing, which falls back to `COPILOT_FALLBACK_MODELS`
 * and is never cached, so the next probe tries again.
 */
export function parseCopilotModels(stdout: string): CommitMessageModel[] {
  const ids: string[] = []
  let inModelSetting = false
  for (const rawLine of stdout.split(/\r\n|\r|\n/)) {
    if (/^\s*`model`\s*:/.test(rawLine)) {
      inModelSetting = true
      continue
    }
    if (!inModelSetting) {
      continue
    }
    // The next documented setting ends this one's value list.
    if (/^\s*`[^`]+`\s*:/.test(rawLine)) {
      break
    }
    const quoted = /^\s+-\s+"([^"]+)"\s*$/.exec(rawLine)
    const id = quoted?.[1]?.trim()
    if (id) {
      ids.push(id)
    }
  }
  return copilotModelsFromIds(ids)
}

/**
 * Copilot publishes no display names, so a label is derived from the id like every
 * other probed model. Every model but `auto` takes a reasoning effort:
 * `--reasoning-effort` is a CLI-level flag, so the picker offers the documented
 * subset for each one rather than guessing per model.
 */
function copilotModelsFromIds(ids: readonly string[]): CommitMessageModel[] {
  // Why: `--model` documents `auto` as "let Copilot pick", but the setting's value
  // list omits it, so the CLI's own routing choice is added back ahead of the ids.
  const withAuto =
    ids.length > 0 && !ids.includes(COPILOT_AUTO_MODEL_ID) ? [COPILOT_AUTO_MODEL_ID, ...ids] : ids
  const seen = new Set<string>()
  return withAuto
    .filter((id) => {
      if (!id || seen.has(id)) {
        return false
      }
      seen.add(id)
      return true
    })
    .map((id) =>
      id === COPILOT_AUTO_MODEL_ID
        ? { id, label: 'Auto' }
        : {
            id,
            label: labelFromModelId(id),
            thinkingLevels: OPENAI_THINKING_LEVELS,
            defaultThinkingLevel: 'low'
          }
    )
}

/** Probe descriptor for the copilot spec; owns the argv it spawns. */
export const COPILOT_MODEL_DISCOVERY: NonNullable<CommitMessageAgentSpec['modelDiscovery']> = {
  binary: 'copilot',
  args: COPILOT_MODEL_LIST_ARGS,
  parse: parseCopilotModels
}

/**
 * What a machine with no `copilot` binary falls back to, frozen at the catalog the
 * CLI shipped when this list was last read. The live catalog comes from the probe,
 * so this only has to be a usable starting point — never authoritative.
 */
export const COPILOT_FALLBACK_MODELS: CommitMessageModel[] = copilotModelsFromIds([
  'claude-sonnet-5.5',
  'claude-sonnet-5',
  'claude-fable-5.1',
  'claude-fable-5',
  'claude-opus-5.5',
  'claude-opus-5',
  'claude-opus-4.8',
  'claude-opus-4.8-fast',
  'claude-sonnet-4.6',
  'claude-haiku-5.5',
  'claude-haiku-4.5',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5-mini',
  'mai-code-1.1-flash',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'kimi-k3'
])
