import { describe, expect, it } from 'vitest'
import { AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import { enabledAiVaultAgentsForSettings } from './ai-vault-enabled-agents'

describe('enabledAiVaultAgentsForSettings', () => {
  it('returns every vault agent when nothing is disabled', () => {
    expect(enabledAiVaultAgentsForSettings([])).toEqual([...AI_VAULT_AGENTS])
    expect(enabledAiVaultAgentsForSettings(undefined)).toEqual([...AI_VAULT_AGENTS])
    expect(enabledAiVaultAgentsForSettings(null)).toEqual([...AI_VAULT_AGENTS])
  })

  it('drops the agents the settings disable', () => {
    const enabled = enabledAiVaultAgentsForSettings(['codex', 'cursor'])

    expect(enabled).not.toContain('codex')
    expect(enabled).not.toContain('cursor')
    expect(enabled).toContain('claude')
    expect(enabled).toHaveLength(AI_VAULT_AGENTS.length - 2)
  })

  it('can disable a single agent', () => {
    expect(enabledAiVaultAgentsForSettings(['claude'])).not.toContain('claude')
  })

  it('ignores entries that are not vault agents', () => {
    const enabled = enabledAiVaultAgentsForSettings(['not-an-agent', 42, null, 'claude'])

    expect(enabled).not.toContain('claude')
    expect(enabled).toHaveLength(AI_VAULT_AGENTS.length - 1)
  })

  it('returns an empty list when every agent is disabled', () => {
    expect(enabledAiVaultAgentsForSettings([...AI_VAULT_AGENTS])).toEqual([])
  })
})
