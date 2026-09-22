// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from './ai-vault-session-limit'
import { VaultViewMenu } from './AiVaultPanelControls'
import { agentLabel } from './ai-vault-session-filters'

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null
}))

// Why: Radix portals and focus-trap the content, which happy-dom cannot drive; the
// menu's own projection is what this test is about, not Radix's behaviour.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    ),
    DropdownMenuCheckboxItem: ({
      children,
      checked
    }: {
      children?: ReactNode
      checked?: boolean
    }) => (
      <label>
        <input type="checkbox" readOnly checked={checked} />
        {children}
      </label>
    ),
    DropdownMenuRadioGroup: Pass,
    DropdownMenuRadioItem: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuSubContent: Pass
  }
})

afterEach(cleanup)

const ENABLED = AI_VAULT_AGENTS.filter((agent) => agent !== 'codex' && agent !== 'cursor')

function renderMenu(
  overrides: {
    agents?: AiVaultAgent[]
    availableAgents?: AiVaultAgent[]
  } = {}
) {
  return render(
    <VaultViewMenu
      agents={overrides.agents ?? [...ENABLED]}
      availableAgents={overrides.availableAgents ?? [...ENABLED]}
      sort={'updated' satisfies AiVaultSort}
      group={'project' satisfies AiVaultGroup}
      hideEmptySessions={false}
      sessionLimit={DEFAULT_AI_VAULT_SESSION_LIMIT}
      adjustmentCount={0}
      onAgentEnabledChange={vi.fn()}
      onAllAgentsEnabledChange={vi.fn()}
      onSortChange={vi.fn()}
      onGroupChange={vi.fn()}
      onHideEmptySessionsChange={vi.fn()}
      onSessionLimitChange={vi.fn()}
      onReset={vi.fn()}
    />
  )
}

describe('VaultViewMenu agents', () => {
  it('offers only the agents enabled in Settings', () => {
    renderMenu()

    for (const agent of ENABLED) {
      expect(screen.getByRole('checkbox', { name: agentLabel(agent) })).toBeTruthy()
    }
    expect(screen.queryByRole('checkbox', { name: agentLabel('codex') })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: agentLabel('cursor') })).toBeNull()
  })

  it('shows every offered agent as checked when none is unchecked', () => {
    renderMenu()

    for (const agent of ENABLED) {
      expect(screen.getByRole('checkbox', { name: agentLabel(agent) })).toBeChecked()
    }
  })

  it('treats the enabled universe as the whole selection', () => {
    renderMenu()

    // Every enabled agent is selected, so "Select all" has nothing left to do.
    expect(screen.getByRole('button', { name: 'Select all' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Clear' }).hasAttribute('disabled')).toBe(false)
  })

  it('leaves Select all available once the view drops an enabled agent', () => {
    renderMenu({ agents: ENABLED.filter((agent) => agent !== 'claude') })

    expect(screen.getByRole('button', { name: 'Select all' }).hasAttribute('disabled')).toBe(false)
  })

  it('disables both bulk actions when Settings has every agent turned off', () => {
    renderMenu({ agents: [], availableAgents: [] })

    expect(screen.getByRole('button', { name: 'Select all' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Clear' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('checkbox', { name: agentLabel('claude') })).toBeNull()
  })
})
