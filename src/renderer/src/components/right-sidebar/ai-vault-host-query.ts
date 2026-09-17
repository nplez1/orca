import { useEffect, useState } from 'react'
import { aiVaultHostListQuery } from '../../../../shared/ai-vault-session-filters'

/**
 * How long typing settles before the search leaves for the host.
 *
 * The panel keeps filtering the rows it already has while this runs, so the wait
 * costs nothing the user can see: it is the difference between one host request
 * per keystroke and one per word.
 */
export const AI_VAULT_HOST_QUERY_DEBOUNCE_MS = 250

/**
 * The filter the host should apply, or `''` when the client must apply it itself.
 *
 * Settling is skipped in one direction: clearing the box has to bring the whole
 * list back at once rather than a debounce later. An operator query (`repo:`,
 * `path:`) or an oversized one never leaves this machine, because a host cannot
 * key either — see `aiVaultHostListQuery`.
 */
export function useAiVaultHostQuery(query: string): string {
  const [hostQuery, setHostQuery] = useState(() => aiVaultHostListQuery(query))

  useEffect(() => {
    const next = aiVaultHostListQuery(query)
    if (next === hostQuery) {
      return
    }
    if (next === '') {
      setHostQuery('')
      return
    }
    const timer = setTimeout(() => setHostQuery(next), AI_VAULT_HOST_QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, hostQuery])

  return hostQuery
}
