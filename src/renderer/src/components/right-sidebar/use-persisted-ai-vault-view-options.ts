import { useCallback, useMemo, useRef, useState } from 'react'
import type { AiVaultAgent, AiVaultGroup, AiVaultSort } from '../../../../shared/ai-vault-types'
import {
  createDefaultAiVaultViewOptions,
  readAiVaultViewOptions,
  writeAiVaultViewOptions,
  type AiVaultViewOptions
} from './ai-vault-view-options-persistence'
import { enabledAiVaultAgentsForSettings } from './ai-vault-enabled-agents'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

type AiVaultViewOptionsUpdate = (current: AiVaultViewOptions) => AiVaultViewOptions

export function usePersistedAiVaultViewOptions(disabledTuiAgents?: Iterable<unknown> | null): {
  /** Agents that are both available (enabled in Settings) and selected in this view. */
  agents: AiVaultAgent[]
  /** Agents enabled in Settings → Agents; the rows the filter menu can offer. */
  availableAgents: AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
  sessionLimit: AiVaultSessionLimit
  setSort: (sort: AiVaultSort) => void
  setGroup: (group: AiVaultGroup) => void
  setHideEmptySessions: (hide: boolean) => void
  setSessionLimit: (limit: AiVaultSessionLimit) => void
  setAgentEnabled: (agent: AiVaultAgent, enabled: boolean) => void
  setAllAgentsEnabled: (enabled: boolean) => void
  resetViewOptions: () => void
} {
  const [options, setOptions] = useState<AiVaultViewOptions>(() => readAiVaultViewOptions())
  // Why: menu actions may batch before a render, so every persistence write must build on
  // the immediately preceding action instead of the last rendered options.
  const optionsRef = useRef(options)
  // Why: a globally disabled agent is not offered, so it must not be part of the scan either.
  const availableAgents = useMemo(
    () => enabledAiVaultAgentsForSettings(disabledTuiAgents),
    [disabledTuiAgents]
  )
  const availableAgentSet = useMemo(() => new Set(availableAgents), [availableAgents])

  const updateOptions = useCallback((update: AiVaultViewOptionsUpdate) => {
    const current = optionsRef.current
    const candidate = update(current)
    if (candidate === current) {
      return
    }
    // Why: setters map valid state to valid state, so persist the candidate directly.
    // Re-normalizing here would re-allocate disabledAgents on every sort/group change and
    // needlessly recompute the session filter; writeAiVaultViewOptions still normalizes what it stores.
    optionsRef.current = candidate
    setOptions(candidate)
    writeAiVaultViewOptions(candidate)
  }, [])

  const setSort = useCallback(
    (sort: AiVaultSort) =>
      updateOptions((current) => (current.sort === sort ? current : { ...current, sort })),
    [updateOptions]
  )
  const setGroup = useCallback(
    (group: AiVaultGroup) =>
      updateOptions((current) => (current.group === group ? current : { ...current, group })),
    [updateOptions]
  )
  const setHideEmptySessions = useCallback(
    (hideEmptySessions: boolean) =>
      updateOptions((current) =>
        current.hideEmptySessions === hideEmptySessions
          ? current
          : { ...current, hideEmptySessions }
      ),
    [updateOptions]
  )
  const setSessionLimit = useCallback(
    (sessionLimit: AiVaultSessionLimit) =>
      updateOptions((current) =>
        current.sessionLimit === sessionLimit ? current : { ...current, sessionLimit }
      ),
    [updateOptions]
  )
  const setAgentEnabled = useCallback(
    (agent: AiVaultAgent, enabled: boolean) => {
      updateOptions((current) => {
        const isDisabled = current.disabledAgents.includes(agent)
        if (enabled === !isDisabled) {
          return current
        }
        // Why: allow zero enabled agents so Clear + re-check one agent is a two-step filter.
        const disabledAgents = enabled
          ? current.disabledAgents.filter((entry) => entry !== agent)
          : [...current.disabledAgents, agent]
        return { ...current, disabledAgents }
      })
    },
    [updateOptions]
  )
  // Why: bulk actions span only what the menu shows. A disabled agent's stale entry is kept,
  // so switching it back on in Settings restores the checkbox the user left it at.
  const setAllAgentsEnabled = useCallback(
    (enabled: boolean) => {
      updateOptions((current) => {
        const disabledAgents = enabled
          ? current.disabledAgents.filter((agent) => !availableAgentSet.has(agent))
          : [...new Set([...current.disabledAgents, ...availableAgents])]
        if (
          disabledAgents.length === current.disabledAgents.length &&
          disabledAgents.every((agent) => current.disabledAgents.includes(agent))
        ) {
          return current
        }
        return { ...current, disabledAgents }
      })
    },
    [availableAgentSet, availableAgents, updateOptions]
  )
  const resetViewOptions = useCallback(
    () => updateOptions(() => createDefaultAiVaultViewOptions()),
    [updateOptions]
  )

  const agents = useMemo(() => {
    const disabled = new Set(options.disabledAgents)
    return availableAgents.filter((agent) => !disabled.has(agent))
  }, [availableAgents, options.disabledAgents])
  return {
    agents,
    availableAgents,
    sort: options.sort,
    group: options.group,
    hideEmptySessions: options.hideEmptySessions,
    sessionLimit: options.sessionLimit,
    setSort,
    setGroup,
    setHideEmptySessions,
    setSessionLimit,
    setAgentEnabled,
    setAllAgentsEnabled,
    resetViewOptions
  }
}
