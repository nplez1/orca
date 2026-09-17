import { useId, type JSX } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'

/**
 * Opt-in companion to the local branch delete. Unchecked unless the user (or the
 * `deleteRemoteBranchOnWorkspaceDelete` setting) asks for it, because unlike `git branch -d`
 * there is no server-side refusal to fall back on — `git push --delete` always removes the ref.
 */
export function DeleteWorktreeRemoteBranchOption({
  checked,
  onCheckedChange
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): JSX.Element {
  const controlId = useId()
  const hintId = useId()
  return (
    <div className="flex items-start gap-2 px-1 py-1">
      <Checkbox
        id={controlId}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-describedby={hintId}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <label htmlFor={controlId} className="block cursor-pointer text-xs text-foreground/80">
          {translate(
            'auto.components.sidebar.DeleteWorktreeRemoteBranchOption.alsoDeleteRemoteBranch',
            'Also delete the remote branch'
          )}
        </label>
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.sidebar.DeleteWorktreeRemoteBranchOption.alsoDeleteRemoteBranchHint',
            "Permanently deletes this workspace's branch on its remote. Cannot be undone, and is skipped when the local branch is kept."
          )}
        </p>
      </div>
    </div>
  )
}
