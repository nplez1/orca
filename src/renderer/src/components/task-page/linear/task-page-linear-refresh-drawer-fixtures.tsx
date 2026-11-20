import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { LinearIssueTextEditor } from './issue-workspace/LinearIssueTextEditor'
import { useLinearIssueEditController } from './item-drawer/linear-item-drawer-edit-controller'
import type { LinearEditState } from './item-drawer/linear-item-drawer-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'

export function DrawerFields({ row, editState }: { row: LinearIssue; editState: LinearEditState }) {
  const controller = useLinearIssueEditController({
    issue: row,
    editState,
    providerSettings: defaultScopeHost(null)
  })
  return (
    <>
      <output data-testid="drawer">
        {row.state.name}:{editState.priority}:{editState.labels.join(',')}
      </output>
      <button onClick={() => controller.handlePriorityChange('4')}>Priority</button>
      <button onClick={() => controller.handleLabelToggle('bug')}>Label</button>
      <LinearIssueTextEditor issue={row} fields="title" />
    </>
  )
}
