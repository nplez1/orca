import React from 'react'
import { Input } from '@/components/ui/input'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { replaceCompletedWorkspaceEmojiShortcode } from '@/lib/workspace-emoji-shortcodes'
import { translate } from '@/i18n/i18n'
import { SelectionIcon } from './smart-workspace-source-row-content'
import type { SmartWorkspaceNameSelection } from './smart-workspace-name-field-model'

/** The name field for a composer opened from a task.
 *
 *  `SmartWorkspaceNameField` resolves whatever is typed into a source, and can
 *  show that source *or* the name but never both — so a task-launched composer
 *  parked the name behind an uneditable source pill, and the only way to shorten
 *  it was to clear the pill, which cleared the issue link with it.
 *
 *  When the dialog is opened from a task the source is already implied and there
 *  is nothing to search for, so it is rendered as static context and the name
 *  stays freely editable: the two are separate facts, and a short workspace name
 *  no longer costs the link. */
export function TaskImpliedSourceNameField({
  inputRef,
  source,
  value,
  onValueChange,
  disabled,
  disabledPlaceholder,
  onPlainEnter
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>
  source: SmartWorkspaceNameSelection
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  disabledPlaceholder?: string
  onPlainEnter?: () => void
}): React.JSX.Element {
  const nameLabel = translate(
    'auto.components.new.workspace.SmartWorkspaceNameField.workspaceName',
    'Workspace name'
  )
  const placeholder = disabled
    ? (disabledPlaceholder ??
      translate('auto.components.new.workspace.SmartWorkspaceNameField.unavailable', 'Unavailable'))
    : nameLabel

  return (
    <div className="min-w-0 space-y-1">
      <Input
        ref={inputRef}
        data-workspace-name-input="true"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={nameLabel}
        onChange={(event) => {
          const nextValue = event.target.value
          const completedEmoji = replaceCompletedWorkspaceEmojiShortcode(
            nextValue,
            event.target.selectionStart
          )
          onValueChange(completedEmoji ? completedEmoji.value : nextValue)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') {
            return
          }
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return
          }
          // Why: the Enter that only confirms a CJK candidate must not create.
          if (isImeCompositionKeyDown(event)) {
            return
          }
          event.preventDefault()
          onPlainEnter?.()
        }}
      />
      {/* Why text and not a control: the link is decided by where this dialog was
          opened, so there is nothing here to pick or clear — only something to
          know. The name above it is the one editable fact. */}
      <div
        data-workspace-implied-source="true"
        className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground"
      >
        <SelectionIcon kind={source.kind} />
        <span className="min-w-0 truncate" title={source.label}>
          {source.label}
        </span>
      </div>
    </div>
  )
}
