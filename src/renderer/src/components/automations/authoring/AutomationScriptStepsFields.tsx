import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from '../automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'
import {
  getDraftScriptStepsError,
  moveScriptStepDraft,
  newScriptStepDraft,
  type AutomationScriptStepDraft
} from './automation-script-steps-draft'

type AutomationScriptStepsFieldsProps = {
  draft: AutomationDraft
  disabled: boolean
  pickerTriggerClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

const TIMEOUT_OPTIONS = ['30', '60', '120', '300', '600', '1800', '3600'] as const

function IconAction({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Ordered script steps that run on the automation's host before its agent, or instead of it. */
export function AutomationScriptStepsFields({
  draft,
  disabled,
  pickerTriggerClassName,
  onDraftChange
}: AutomationScriptStepsFieldsProps): React.JSX.Element {
  const t = useTranslate()
  const steps = draft.scriptSteps ?? []
  const error = steps.some((step) => step.script.trim()) ? getDraftScriptStepsError(draft) : null
  const setSteps = (next: AutomationScriptStepDraft[]): void =>
    onDraftChange((current) => ({
      ...current,
      scriptSteps: next,
      runAgentStep: next.length === 0 ? true : (current.runAgentStep ?? true)
    }))
  const updateStep = (index: number, patch: Partial<AutomationScriptStepDraft>): void =>
    setSteps(steps.map((step, at) => (at === index ? { ...step, ...patch } : step)))
  const timeoutLabel = (seconds: string): string =>
    Number(seconds) < 60
      ? t('automations.scriptSteps.timeoutSeconds', '{{seconds}} sec', { seconds })
      : t('automations.scriptSteps.timeoutMinutes', '{{minutes}} min', {
          minutes: Math.round(Number(seconds) / 60)
        })

  return (
    <Field
      label={
        <span className="flex items-center justify-between gap-2">
          <span className={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}>
            {t('automations.scriptSteps.title', 'Script steps')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled || steps.length >= 8}
            onClick={() => setSteps([...steps, newScriptStepDraft(steps)])}
          >
            <Plus />
            {t('automations.scriptSteps.add', 'Add step')}
          </Button>
        </span>
      }
    >
      {steps.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'automations.scriptSteps.empty',
            'Run committed scripts on the host before the agent. A failing step stops the run.'
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <div
              key={step.key}
              className="flex flex-col gap-1.5 rounded-md border border-border px-2 py-2"
            >
              <div className="flex items-center gap-1">
                <Input
                  variant="code"
                  density="compact"
                  className="w-24 shrink-0"
                  value={step.id}
                  disabled={disabled}
                  aria-label={t('automations.scriptSteps.id', 'Step id')}
                  onChange={(event) => updateStep(index, { id: event.target.value })}
                />
                <Input
                  variant="code"
                  density="compact"
                  value={step.script}
                  disabled={disabled}
                  placeholder={t('automations.scriptSteps.scriptPlaceholder', 'scripts/triage.sh')}
                  aria-label={t('automations.scriptSteps.script', 'Script path')}
                  onChange={(event) => updateStep(index, { script: event.target.value })}
                />
                <IconAction
                  label={t('automations.scriptSteps.moveUp', 'Move up')}
                  disabled={disabled || index === 0}
                  onClick={() => setSteps(moveScriptStepDraft(steps, index, -1))}
                >
                  <ArrowUp />
                </IconAction>
                <IconAction
                  label={t('automations.scriptSteps.moveDown', 'Move down')}
                  disabled={disabled || index === steps.length - 1}
                  onClick={() => setSteps(moveScriptStepDraft(steps, index, 1))}
                >
                  <ArrowDown />
                </IconAction>
                <IconAction
                  label={t('automations.scriptSteps.remove', 'Remove step')}
                  disabled={disabled}
                  onClick={() => setSteps(steps.filter((_, at) => at !== index))}
                >
                  <X />
                </IconAction>
              </div>
              <div className="flex items-center gap-1">
                <Input
                  variant="code"
                  density="compact"
                  value={step.args}
                  disabled={disabled}
                  placeholder={t('automations.scriptSteps.argsPlaceholder', 'Arguments')}
                  aria-label={t('automations.scriptSteps.args', 'Arguments')}
                  onChange={(event) => updateStep(index, { args: event.target.value })}
                />
                <Select
                  value={step.timeoutSeconds}
                  disabled={disabled}
                  onValueChange={(timeoutSeconds) => updateStep(index, { timeoutSeconds })}
                >
                  <SelectTrigger
                    aria-label={t('automations.scriptSteps.timeout', 'Timeout')}
                    size="sm"
                    className={`h-7 w-auto shrink-0 ${pickerTriggerClassName}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" side="bottom" align="end" sideOffset={4}>
                    {TIMEOUT_OPTIONS.some((seconds) => seconds === step.timeoutSeconds) ? null : (
                      <SelectItem value={step.timeoutSeconds}>
                        {timeoutLabel(step.timeoutSeconds)}
                      </SelectItem>
                    )}
                    {TIMEOUT_OPTIONS.map((seconds) => (
                      <SelectItem key={seconds} value={seconds}>
                        {timeoutLabel(seconds)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={step.onFailure}
                  disabled={disabled}
                  onValueChange={(onFailure) =>
                    updateStep(index, { onFailure: onFailure === 'continue' ? 'continue' : 'stop' })
                  }
                >
                  <SelectTrigger
                    aria-label={t('automations.scriptSteps.onFailure', 'If it fails')}
                    size="sm"
                    className={`h-7 w-auto shrink-0 ${pickerTriggerClassName}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" side="bottom" align="end" sideOffset={4}>
                    <SelectItem value="stop">
                      {t('automations.scriptSteps.onFailureStop', 'Stop on failure')}
                    </SelectItem>
                    <SelectItem value="continue">
                      {t('automations.scriptSteps.onFailureContinue', 'Continue on failure')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={draft.runAgentStep !== false}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onDraftChange((current) => ({ ...current, runAgentStep: checked === true }))
              }
            />
            {t('automations.scriptSteps.runAgent', 'Then run the agent with the prompt')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              'automations.scriptSteps.handoff',
              'Later steps and the agent read each step’s result as ORCA_STEP_<ID>_STDOUT and ORCA_STEP_<ID>_EXIT. Each runs as a copy beside its file, named .orca-step-<random>-<name> and excluded from Git, so basename "$0" is that name; ORCA_AUTOMATION_STEP_SCRIPT names the original. A new or changed script or argument stops its run until you approve it from that run.'
            )}
          </p>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Field>
  )
}
