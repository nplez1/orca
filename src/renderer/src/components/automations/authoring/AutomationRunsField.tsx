import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslate } from '@/i18n/use-translate'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { Field, AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from '../automation-page-parts'
import { selectDraftActionKind } from './automation-draft-action'
import type { AutomationDraft } from './AutomationEditorDialog'

export function AutomationRunsField({
  draft,
  botAgentId,
  onDraftChange
}: {
  draft: AutomationDraft
  /** The picked bot's agent, which a run goes back to when it stops being a script. */
  botAgentId?: TuiAgent
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('automations.command.runs', 'Runs')
  const selected = draft.actionKind ?? 'agent'
  return (
    <Field className="mb-4" labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={label}>
      <ToggleGroup
        role="radiogroup"
        aria-label={label}
        type="single"
        spacing={1}
        size="sm"
        variant="segmented-card"
        value={selected}
        onValueChange={(kind) => {
          if (kind === 'agent' || kind === 'command') {
            onDraftChange((current) => selectDraftActionKind(current, kind, botAgentId))
          }
        }}
      >
        <ToggleGroupItem role="radio" aria-checked={selected === 'agent'} value="agent">
          {t('automations.command.runsAgent', 'An agent')}
        </ToggleGroupItem>
        <ToggleGroupItem role="radio" aria-checked={selected === 'command'} value="command">
          {t('automations.command.runsScript', 'A script')}
        </ToggleGroupItem>
      </ToggleGroup>
    </Field>
  )
}
