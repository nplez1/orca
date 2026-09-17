import { useState } from 'react'

/**
 * The delete dialog's remote-branch opt-in.
 *
 * `null` means "not chosen yet in this dialog session": the setting supplies the value on open
 * without an effect, and a cancelled choice never sticks to the next open.
 */
export function useDeleteRemoteBranchChoice(
  isOpen: boolean,
  settingDefault: boolean
): {
  checked: boolean
  setChecked: (checked: boolean) => void
  /** Spread into a removal's options; empty while the box is unchecked. */
  options: { deleteRemoteBranch?: true }
} {
  const [choice, setChoice] = useState<boolean | null>(null)
  if (!isOpen && choice !== null) {
    setChoice(null)
  }
  const checked = choice ?? settingDefault
  return {
    checked,
    setChecked: setChoice,
    options: checked ? { deleteRemoteBranch: true } : {}
  }
}
