import type { TabsSlice, TabsSliceSet } from './tabs-slice-contract'

/**
 * The group-by-branch host choice, shared by the sidebar card's dropdown and the
 * tab strip's sibling rows. Upstream split the rest of this module into
 * `tabs-split-ratio-actions.ts`, so only this action is left here.
 */
export function createTabsBranchGroupHostActions(
  set: TabsSliceSet
): Pick<TabsSlice, 'setBranchGroupHost'> {
  return {
    setBranchGroupHost: (groupKey, hostId) => {
      set((state) => {
        if (state.branchGroupHostByKey[groupKey] === hostId) {
          return state
        }
        return { branchGroupHostByKey: { ...state.branchGroupHostByKey, [groupKey]: hostId } }
      })
    }
  }
}
