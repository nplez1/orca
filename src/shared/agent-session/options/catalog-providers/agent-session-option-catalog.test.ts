import { describe, expect, it } from 'vitest'
import {
  getAgentSessionOptionCatalog,
  getAgentSessionOptionLaunchCatalog
} from '../agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from '../launch/agent-session-option-launch'
import { checkAgentLaunchModelPreferences } from '../../../agent-launch/choices/agent-launch-model-preferences'
import {
  resolveNativeChatSessionOptionDefaults,
  updateNativeChatSessionOptionDefaults
} from '../../../native-chat/input/session-options/native-chat-session-option-defaults'

describe('agent session option catalog', () => {
  it('parses Claude list_models discovery into catalog models with options', () => {
    const stdout = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'orca-model-discovery',
        response: {
          models: [
            {
              value: 'default',
              displayName: 'Default (recommended)',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true
            },
            {
              value: 'opus[1m]',
              displayName: 'Opus (1M context)',
              description: 'Opus 5 with 1M context',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true
            },
            {
              value: 'sonnet',
              displayName: 'Sonnet',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high']
            },
            { value: 'haiku', displayName: 'Haiku' }
          ]
        }
      }
    })
    const parsed = getAgentSessionOptionCatalog('claude')!.listModels!.parse(stdout)
    expect(parsed.map(({ id }) => id)).toEqual(['opus[1m]', 'sonnet', 'haiku'])
    expect(parsed[0]).toMatchObject({
      label: 'Opus (1M context)',
      description: 'Opus 5 with 1M context'
    })
    expect(parsed[0].options.map(({ id }) => id)).toEqual(['effort', 'fastMode'])
    const opusEffort = parsed[0].options[0]
    expect(opusEffort.kind).toMatchObject({ defaultValue: 'high' })
    expect(
      opusEffort.kind.type === 'select' ? opusEffort.kind.choices.map((c) => c.value) : []
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    const sonnetEffort = parsed[1].options[0]
    expect(
      sonnetEffort.kind.type === 'select' ? sonnetEffort.kind.choices.map((c) => c.value) : []
    ).toEqual(['low', 'medium', 'high'])
    expect(parsed[2].options).toEqual([])
  })

  it('resolves only stored values without leaking values across models', () => {
    let persisted = updateNativeChatSessionOptionDefaults({
      persisted: undefined,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'model',
      value: 'opus'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'opus',
      optionId: 'effort',
      value: 'xhigh'
    })
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: 'sonnet',
      optionId: 'model',
      value: 'sonnet'
    })

    expect(resolveNativeChatSessionOptionDefaults(persisted, 'claude')).toEqual({
      model: 'sonnet'
    })
    expect(persisted.claude?.valuesByModel?.opus).toEqual({ effort: 'xhigh' })
  })
})

describe('pi launch catalog', () => {
  it('launches Pi on a chosen model and thinking level', () => {
    const preferences = { model: 'deepseek/deepseek-flash', effort: 'xhigh' }

    expect(getAgentSessionOptionLaunchCatalog('pi')).toBeDefined()
    expect(checkAgentLaunchModelPreferences({ agent: 'pi', ...preferences })).toEqual({
      preferences
    })
    expect(resolveAgentSessionOptionLaunch('pi', preferences, [], false).args).toEqual([
      '--model',
      'deepseek/deepseek-flash',
      '--thinking',
      'xhigh'
    ])
  })

  it('refuses a Pi model without a provider, which Pi chats cannot apply', () => {
    for (const model of ['sonnet', '/sonnet', 'anthropic/']) {
      expect(checkAgentLaunchModelPreferences({ agent: 'pi', model })).toMatchObject({
        refusal: { code: 'invalid_argument' }
      })
    }
  })

  it('refuses a Pi thinking level Pi does not accept', () => {
    expect(
      checkAgentLaunchModelPreferences({
        agent: 'pi',
        model: 'deepseek/deepseek-flash',
        effort: 'turbo'
      })
    ).toMatchObject({ refusal: { code: 'invalid_argument' } })
  })
})
