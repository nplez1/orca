import type React from 'react'

export type LineageToggleHandler = (event: React.MouseEvent<HTMLElement>) => void

const GROUP_KEY_SEPARATOR = '\u0000'

// Cache one handler per lineage group so callback identity cannot defeat WorktreeCard memoization.
export const createLineageToggleHandlerCache = (
  toggleGroups: (groupKeys: readonly string[]) => void
): ((groupKeys: readonly string[]) => LineageToggleHandler) => {
  const handlersByGroupKey = new Map<string, LineageToggleHandler>()
  return (groupKeys) => {
    const cacheKey = groupKeys.join(GROUP_KEY_SEPARATOR)
    const cached = handlersByGroupKey.get(cacheKey)
    if (cached) {
      return cached
    }
    const handler: LineageToggleHandler = (event) => {
      event.stopPropagation()
      toggleGroups(groupKeys)
    }
    handlersByGroupKey.set(cacheKey, handler)
    return handler
  }
}
