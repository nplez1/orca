import { useCallback } from 'react'
import { observeTabGroupBodyGridSize } from '@/runtime/sync-runtime-graph/graph-sync-scheduler'
import { registerTabGroupBody } from './tab-group-body-geometry'

/** Body ref: registers the drop target and the geometry observers that read the same node. */
export function useTabGroupBodyRef(
  groupId: string,
  setBodyDropRef: (node: HTMLElement | null) => void
) {
  return useCallback(
    (node: HTMLDivElement | null) => {
      setBodyDropRef(node)
      if (!node) {
        return undefined
      }
      const unregisterBody = registerTabGroupBody(groupId, node)
      const stopGridSizeReport = observeTabGroupBodyGridSize(node)
      return () => {
        unregisterBody()
        stopGridSizeReport()
        setBodyDropRef(null)
      }
    },
    [groupId, setBodyDropRef]
  )
}
