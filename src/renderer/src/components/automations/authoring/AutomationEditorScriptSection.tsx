import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import {
  MAX_AUTOMATION_COMMAND_LENGTH,
  MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS
} from '../../../../../shared/automations/launch/automation-command'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from '../automation-page-parts'
import {
  EMPTY_AUTOMATION_SCRIPT_DRAFT,
  type AutomationScriptDraft
} from './automation-draft-action'
import {
  getAutomationReportOptions,
  getAutomationShellOptions
} from './automation-script-option-copy'
import type { AutomationDraft } from './AutomationEditorDialog'

function ScriptOptionField<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: readonly { value: T; label: string; description: string }[]
  onChange: (value: T) => void
}): React.JSX.Element {
  const idPrefix = useId()
  return (
    <Field labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={label}>
      <RadioGroup
        aria-label={label}
        value={value}
        onValueChange={(next) => {
          const option = options.find((entry) => entry.value === next)
          if (option) {
            onChange(option.value)
          }
        }}
      >
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`${idPrefix}-${option.value}`}
            className="flex items-start gap-2"
          >
            <RadioGroupItem
              id={`${idPrefix}-${option.value}`}
              value={option.value}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </Field>
  )
}

export function AutomationEditorScriptSection({
  draft,
  onDraftChange
}: {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const t = useTranslate()
  const script = draft.script ?? EMPTY_AUTOMATION_SCRIPT_DRAFT
  const update = (patch: Partial<AutomationScriptDraft>): void =>
    onDraftChange((current) => ({
      ...current,
      script: { ...(current.script ?? EMPTY_AUTOMATION_SCRIPT_DRAFT), ...patch }
    }))
  const commandLabel = t('automations.command.command', 'Command')
  const timeoutLabel = t('automations.command.timeoutSeconds', 'Timeout (seconds)')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto scrollbar-sleek p-1 @max-[35rem]:overflow-visible">
      <Field labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={commandLabel}>
        <Textarea
          variant="code"
          rows={4}
          required
          spellCheck={false}
          maxLength={MAX_AUTOMATION_COMMAND_LENGTH}
          aria-label={commandLabel}
          value={script.command}
          placeholder={t('automations.command.commandPlaceholder', './scripts/nightly-report.sh')}
          onChange={(event) => update({ command: event.target.value })}
        />
      </Field>
      <Field labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={timeoutLabel}>
        <Input
          type="number"
          min={1}
          max={MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS}
          step={1}
          className="w-32"
          aria-label={timeoutLabel}
          value={script.timeoutSeconds}
          onChange={(event) => update({ timeoutSeconds: event.target.value })}
        />
      </Field>
      <ScriptOptionField
        label={t('automations.command.shell', 'Shell')}
        value={script.shell}
        options={getAutomationShellOptions(t)}
        onChange={(shell) => update({ shell })}
      />
      <ScriptOptionField
        label={t('automations.command.report', 'Report')}
        value={script.report}
        options={getAutomationReportOptions(t)}
        onChange={(report) => update({ report })}
      />
    </div>
  )
}
