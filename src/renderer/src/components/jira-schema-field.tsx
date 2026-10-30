import type { JiraCreateField, JiraUser } from '../../../shared/jira/jira-types'
import { resolveJiraFieldControlKind } from '../../../shared/jira-field-rendering'
import { joinJiraFieldDraft } from '../../../shared/jira-field-draft'
import { JiraOptionMultiSelect, jiraOptionToken } from '@/components/jira-option-multi-select'
import { JiraUserMultiPicker, jiraHeldUsers } from '@/components/jira-user-multi-picker'
import { JiraUserPicker, type JiraUserPickerFixedOption } from '@/components/jira-user-picker'
import { getJiraCreateAllowedValueLabel } from '@/components/task-page/jira/task-page-jira-create-fields'
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
  fallbackToText,
  displayValue
}: {
  field: JiraCreateField
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  /** Names for a value the control holds in a submission-shaped token (a joined id
   *  list), so a user field's current selection is readable beside it. */
  displayValue?: string
  userField?: {
    selectedUser: JiraUser | null
    onSelectUser: (user: JiraUser | null) => void
    /** The people a multi-user field already holds, and where an edit of them goes. */
    selectedUsers?: JiraUser[]
    onSelectUsers?: (users: JiraUser[]) => void
    providerSettings: RuntimeJiraSettings
    siteId?: string | null
    /** Adds a row that clears the field, so an existing value can be removed. */
    allowClear?: boolean
  }
  /** Renders a text box for a schema Orca has no control for. The create dialog
   *  has always done this; the edit form refuses the field instead and names it,
   *  and the transition form falls back only where the issue holds no value. */
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
  if (kind === 'userList' && userField) {
    const held = jiraHeldUsers(userField.selectedUsers ?? [], value)
    // A host too old to report names leaves the ids standing in for them; the joined
    // names it does still send are the only readable form of the value then.
    const unnamed = held.some((user) => user.displayName === user.accountId)
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <JiraUserMultiPicker
          providerSettings={userField.providerSettings}
          siteId={userField.siteId}
          value={value}
          users={userField.selectedUsers ?? []}
          onChange={(users) => {
            userField.onSelectUsers?.(users)
            onValueChange(joinJiraFieldDraft(users.map((user) => user.accountId)))
          }}
          disabled={disabled}
          label={field.name}
          placeholder={translate('auto.components.TaskPage.1f0fce91e3', 'Select {{value0}}', {
            value0: field.name
          })}
        />
        {unnamed && displayValue && displayValue !== value ? (
          <p className="text-2xs text-muted-foreground">
            {translate('components.jiraSchemaField.currentValue', 'Current: {{value0}}', {
              value0: displayValue
            })}
          </p>
        ) : null}
      </div>
    )
  }
  if (kind === 'optionList' && field.allowedValues?.length) {
    return (
      <JiraOptionMultiSelect
        options={field.allowedValues}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        placeholder={translate('auto.components.TaskPage.1f0fce91e3', 'Select {{value0}}', {
          value0: field.name
        })}
      />
    )
  }
  // Why `user`: a create screen can enumerate a user field's choices, and without a picker those
  // supplied choices are the only valid values.
  if ((kind === 'select' || kind === 'user') && field.allowedValues?.length) {
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
            const optionValue = jiraOptionToken(option)
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
    <div className="flex min-w-0 flex-col gap-1">
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
      {displayValue && displayValue !== value ? (
        <p className="text-2xs text-muted-foreground">
          {translate('components.jiraSchemaField.currentValue', 'Current: {{value0}}', {
            value0: displayValue
          })}
        </p>
      ) : null}
    </div>
  )
}
