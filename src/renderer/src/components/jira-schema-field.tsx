import type { JiraCreateField, JiraUser } from '../../../shared/jira-types'
import { resolveJiraFieldControlKind } from '../../../shared/jira-field-rendering'
import { JiraUserPicker, type JiraUserPickerFixedOption } from '@/components/jira-user-picker'
import { getJiraCreateAllowedValueLabel } from '@/components/task-page-jira-create-fields'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'

/**
 * One Jira field's control, chosen from its schema. Shared by the create dialog,
 * the issue-detail edit form, and the transition-fields form so the
 * schema-to-control mapping exists once. `userField` is what selects the user
 * picker: a caller with no user-selection state (create) omits it and gets a
 * text box, which is what it submitted before.
 */
export function JiraSchemaFieldControl({
  field,
  value,
  onValueChange,
  disabled,
  userField,
  fallbackToText
}: {
  field: JiraCreateField
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  userField?: {
    selectedUser: JiraUser | null
    onSelectUser: (user: JiraUser | null) => void
    providerSettings: RuntimeJiraSettings
    siteId?: string | null
    /** Adds a row that clears the field, so an existing value can be removed. */
    allowClear?: boolean
  }
  /** Renders a text box for a schema Orca has no control for. The create dialog
   *  has always done this; the edit and transition forms refuse the field instead
   *  and name it, because they resubmit a value Jira already holds. */
  fallbackToText?: boolean
}): React.JSX.Element | null {
  const kind = resolveJiraFieldControlKind(field)
  if (kind === null && !fallbackToText) {
    return null
  }
  if (kind === 'user' && userField) {
    const fixedOptions: JiraUserPickerFixedOption[] = userField.allowClear
      ? [
          {
            key: 'none',
            label: translate('components.jiraSchemaField.noUser', 'None'),
            onSelect: () => {
              userField.onSelectUser(null)
              onValueChange('')
            }
          }
        ]
      : []
    return (
      <JiraUserPicker
        providerSettings={userField.providerSettings}
        siteId={userField.siteId}
        value={value}
        selectedUser={userField.selectedUser}
        onSelect={(user) => {
          userField.onSelectUser(user)
          onValueChange(user.accountId)
        }}
        disabled={disabled}
        label={field.name}
        fixedOptions={fixedOptions}
      />
    )
  }
  if (kind === 'select' && field.allowedValues?.length) {
    return (
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue
            placeholder={translate('auto.components.TaskPage.1f0fce91e3', 'Select {{value0}}', {
              value0: field.name
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {field.allowedValues.map((option) => {
            const optionValue = option.id ?? option.value ?? option.name ?? ''
            return optionValue ? (
              <SelectItem key={optionValue} value={optionValue}>
                {getJiraCreateAllowedValueLabel(option)}
              </SelectItem>
            ) : null
          })}
        </SelectContent>
      </Select>
    )
  }
  if (kind === 'textarea') {
    return (
      <textarea
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={translate('auto.components.TaskPage.919a20dd5b', 'Enter {{value0}}', {
          value0: field.name
        })}
        rows={4}
        disabled={disabled}
        className="w-full min-w-0 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 max-h-60 overflow-y-auto scrollbar-sleek"
      />
    )
  }
  return (
    <Input
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
      placeholder={
        kind === 'textList' || kind === 'userList'
          ? translate('auto.components.TaskPage.56cdb413a2', 'Comma-separated values')
          : translate('auto.components.TaskPage.919a20dd5b', 'Enter {{value0}}', {
              value0: field.name
            })
      }
      disabled={disabled}
    />
  )
}
