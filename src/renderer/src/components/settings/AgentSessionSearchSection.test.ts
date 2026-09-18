import { isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AiVaultSearchSettings } from '../../../../shared/ai-vault-search-settings'
import { AgentSessionSearchSection } from './AgentSessionSearchSection'
import { getAgentsPaneSearchEntries } from './agents-search'
import { matchesSettingsSearch } from './settings-search'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null) {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  if (typeof node !== 'object' || !isValidElement<Record<string, unknown>>(node)) {
    return
  }
  cb(node)
  if (node.props.children) {
    visit(node.props.children, cb)
  }
  if (node.props.control) {
    visit(node.props.control, cb)
  }
}

/** A rendered element's handler, as this harness invokes it by name. */
type HandlerLike = (...args: unknown[]) => unknown

function isHandlerLike(value: unknown): value is HandlerLike {
  return typeof value === 'function'
}

/** Invokes a rendered element's handler by name without reaching for a cast on untyped props. */
function callHandler(control: ReactElementLike, prop: string, args: unknown[]): void {
  const handler: unknown = control.props[prop]
  if (!isHandlerLike(handler)) {
    throw new Error(`${prop} handler not found`)
  }
  handler(...args)
}

function findContentSwitch(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (typeof entry.props.checked === 'boolean' && typeof entry.props.onChange === 'function') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('content switch not found')
  }
  return found
}

function findRetentionSelect(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (typeof entry.props.onValueChange === 'function') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('retention select not found')
  }
  return found
}

function renderSection(settings: GlobalSettings, updateSettings = vi.fn()): unknown {
  return AgentSessionSearchSection({ settings, updateSettings })
}

function legacyEnabledProfile(historyDays?: number | null): GlobalSettings {
  const settings = getDefaultSettings('/tmp')
  const legacy: Record<string, unknown> = { enabled: true }
  if (historyDays !== undefined) {
    legacy.historyDays = historyDays
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pre-rename profiles persisted `enabled` where the type now requires `contentEnabled`.
  settings.aiVaultSearch = legacy as unknown as AiVaultSearchSettings
  return settings
}

describe('AgentSessionSearchSection', () => {
  it('discloses what the content tier stores and what search covers without it', () => {
    const element = renderSection(getDefaultSettings('/tmp'))
    let description = ''
    visit(element, (entry) => {
      if (typeof entry.props.checked === 'boolean' && typeof entry.props.description === 'string') {
        description = entry.props.description
      }
    })

    expect(description).toContain('session titles')
    expect(description).toContain('working directories')
    expect(description).toContain('branches')
    expect(description).toContain('message text')
    expect(description).toContain('not conversation contents')
  })

  it('writes the content toggle into aiVaultSearch', () => {
    const updateSettings = vi.fn()
    const element = renderSection(getDefaultSettings('/tmp'), updateSettings)
    const control = findContentSwitch(element)

    expect(control.props.checked).toBe(false)
    callHandler(control, 'onChange', [])

    expect(updateSettings).toHaveBeenCalledWith({
      aiVaultSearch: { contentEnabled: true, historyDays: null }
    })
  })

  it('writes the retention window into aiVaultSearch', () => {
    const updateSettings = vi.fn()
    const element = renderSection(
      {
        ...getDefaultSettings('/tmp'),
        aiVaultSearch: { contentEnabled: true, historyDays: 30 }
      },
      updateSettings
    )
    const select = findRetentionSelect(element)

    expect(select.props.value).toBe('30')
    callHandler(select, 'onValueChange', ['90'])

    expect(updateSettings).toHaveBeenCalledWith({
      aiVaultSearch: { contentEnabled: true, historyDays: 90 }
    })
  })

  it('maps the all-history option back to null', () => {
    const updateSettings = vi.fn()
    const element = renderSection(
      {
        ...getDefaultSettings('/tmp'),
        aiVaultSearch: { contentEnabled: true, historyDays: 365 }
      },
      updateSettings
    )
    const select = findRetentionSelect(element)

    callHandler(select, 'onValueChange', ['all'])

    expect(updateSettings).toHaveBeenCalledWith({
      aiVaultSearch: { contentEnabled: true, historyDays: null }
    })
  })

  it('keeps a retention window written outside the presets selectable', () => {
    const element = renderSection({
      ...getDefaultSettings('/tmp'),
      aiVaultSearch: { contentEnabled: true, historyDays: 7 }
    })

    expect(findRetentionSelect(element).props.value).toBe('7')
  })

  it('reads a legacy { enabled: true } profile as content-enabled', () => {
    const element = renderSection(legacyEnabledProfile(30))

    expect(findContentSwitch(element).props.checked).toBe(true)
    expect(findRetentionSelect(element).props.value).toBe('30')
  })

  it('turns the legacy flag off without dropping the stored window', () => {
    const updateSettings = vi.fn()
    const element = renderSection(legacyEnabledProfile(30), updateSettings)
    callHandler(findContentSwitch(element), 'onChange', [])

    expect(updateSettings).toHaveBeenCalledWith({
      aiVaultSearch: { contentEnabled: false, historyDays: 30 }
    })
  })

  it('keeps session history search metadata discoverable through the Agents pane', () => {
    for (const term of ['session', 'history', 'transcript', 'conversation']) {
      expect(matchesSettingsSearch(term, getAgentsPaneSearchEntries())).toBe(true)
    }
  })
})
