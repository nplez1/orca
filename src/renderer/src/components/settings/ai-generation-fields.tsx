import {
  sourceControlModelLabel,
  sourceControlThinkingLabel
} from '../feature-wall/source-control-model-label'
import { useMemo, type JSX } from 'react'
import { Terminal } from 'lucide-react'
import { CUSTOM_PROMPT_PLACEHOLDER } from '../../../../shared/source-control/ai/generation/commit-message-prompt'
import {
  CUSTOM_AGENT_ID,
  listCommitMessageAgentCapabilities,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability
} from '../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import type { CommitMessageAiSettings } from '../../../../shared/source-control/ai/generation/commit-message-ai-types'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { cn } from '@/lib/utils'
import {
  aiGenerationAgentLabel,
  type AiGenerationSettingsConfig
} from '@/lib/ai-generation-settings'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { DropdownMenuItem } from '../ui/dropdown-menu'
import { AgentLaunchPicker } from '../agent/AgentLaunchPicker'
import {
  aiCommitPrPickerDraft,
  commitMessagePickerModel
} from '../feature-wall/ai-commit-pr-picker'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type AiGenerationFieldsBaseProps = {
  config: AiGenerationSettingsConfig
  selectPortalRoot: HTMLElement | null
  activeCapability: CommitMessageAgentCapability | undefined
  isCustom: boolean
  unsupportedAgentLabel: string | null
  onAgentChange: (newAgentId: string) => void
  onCustomCommandChange: (value: string) => void
}

/** One launch picker that chooses agent, model and effort together (Source Control AI). */
type AiGenerationLaunchPickerProps = {
  pickerEntries: AgentPickerEntry[]
  onPick: (agent: TuiAgent, draft?: AgentPickerDraft) => void
  /** Accepted from the Source Control card; custom commands use `onCustomCommandChange`. */
  writeConfig?: (patch: Partial<CommitMessageAiSettings>) => void
}

/** Separate agent, model and effort selects, for settings that have no picker entries. */
type AiGenerationSelectProps = {
  agentSelectValue: string | undefined
  activeModel: CommitMessageModelCapability | null
  activeThinking: string | undefined
  onModelChange: (newModelId: string) => void
  onThinkingChange: (newLevelId: string) => void
}

export type AiGenerationFieldsProps = AiGenerationFieldsBaseProps &
  (AiGenerationLaunchPickerProps | AiGenerationSelectProps)

function usesLaunchPicker(
  props: AiGenerationFieldsProps
): props is AiGenerationFieldsBaseProps & AiGenerationLaunchPickerProps {
  return 'pickerEntries' in props
}

function unsupportedOrUnconfiguredLabel(
  unsupportedAgentLabel: string | null,
  t: Translate
): string {
  return unsupportedAgentLabel
    ? t(
        'auto.components.feature.wall.AiCommitPrSettingsCard.1f9468c5c9',
        '{{value0}} unsupported',
        { value0: unsupportedAgentLabel }
      )
    : t('auto.components.feature.wall.AiCommitPrSettingsCard.bd14e9c42a', 'Not configured')
}

function AiGenerationLaunchAgentPicker({
  selectPortalRoot,
  activeCapability,
  isCustom,
  unsupportedAgentLabel,
  onAgentChange,
  pickerEntries,
  onPick
}: AiGenerationFieldsBaseProps & AiGenerationLaunchPickerProps): JSX.Element {
  const t = useTranslate()
  const model = useMemo(() => commitMessagePickerModel(pickerEntries), [pickerEntries])
  return (
    <AgentLaunchPicker
      model={model}
      entries={pickerEntries}
      agent={activeCapability?.id ?? null}
      draftForEntry={aiCommitPrPickerDraft}
      portalContainer={selectPortalRoot}
      onPick={onPick}
      triggerLabel={
        isCustom
          ? t('auto.components.feature.wall.AiCommitPrSettingsCard.560d4feb00', 'Custom')
          : undefined
      }
      emptyLabel={unsupportedOrUnconfiguredLabel(unsupportedAgentLabel, t)}
    >
      <DropdownMenuItem onSelect={() => onAgentChange(CUSTOM_AGENT_ID)}>
        <Terminal className="size-3.5" />
        {t('auto.components.feature.wall.AiCommitPrSettingsCard.560d4feb00', 'Custom')}
      </DropdownMenuItem>
    </AgentLaunchPicker>
  )
}

function AiGenerationAgentSelect({
  selectPortalRoot,
  activeCapability,
  isCustom,
  unsupportedAgentLabel,
  onAgentChange,
  agentSelectValue
}: AiGenerationFieldsBaseProps & AiGenerationSelectProps): JSX.Element {
  const t = useTranslate()
  return (
    <Select value={agentSelectValue} onValueChange={onAgentChange}>
      <SelectTrigger size="sm" className="h-8 w-full">
        <span
          className={cn(
            'flex min-w-0 items-center gap-2',
            !activeCapability && !isCustom ? 'text-muted-foreground' : null
          )}
        >
          {activeCapability ? (
            <>
              <AgentIcon agent={activeCapability.id} size={14} />
              <span className="truncate">
                {aiGenerationAgentLabel(activeCapability.id, activeCapability)}
              </span>
            </>
          ) : isCustom ? (
            <>
              <Terminal className="size-3.5" />
              <span>
                {t('auto.components.feature.wall.AiCommitPrSettingsCard.560d4feb00', 'Custom')}
              </span>
            </>
          ) : (
            <span className="truncate">
              {unsupportedOrUnconfiguredLabel(unsupportedAgentLabel, t)}
            </span>
          )}
        </span>
      </SelectTrigger>
      <SelectContent portalContainer={selectPortalRoot} position="popper" align="start">
        {listCommitMessageAgentCapabilities().map((capability) => (
          <SelectItem key={capability.id} value={capability.id} className="cursor-pointer">
            <span className="flex items-center gap-2">
              <AgentIcon agent={capability.id} size={14} />
              <span>{aiGenerationAgentLabel(capability.id, capability)}</span>
            </span>
          </SelectItem>
        ))}
        <SelectItem value={CUSTOM_AGENT_ID} className="cursor-pointer">
          <span className="flex items-center gap-2">
            <Terminal className="size-3.5" />
            <span>
              {t('auto.components.feature.wall.AiCommitPrSettingsCard.560d4feb00', 'Custom')}
            </span>
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  )
}

function AiGenerationModelFields({
  selectPortalRoot,
  activeCapability,
  activeModel,
  activeThinking,
  onModelChange,
  onThinkingChange
}: AiGenerationFieldsBaseProps & AiGenerationSelectProps): JSX.Element | null {
  const t = useTranslate()
  if (!activeCapability || !activeModel) {
    return null
  }
  return (
    <>
      <div className="space-y-1.5">
        <Label>
          {t('auto.components.feature.wall.AiCommitPrSettingsCard.be8917699e', 'Model')}
        </Label>
        <Select value={activeModel.id} onValueChange={onModelChange}>
          <SelectTrigger size="sm" className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent portalContainer={selectPortalRoot} position="popper" align="start">
            {activeCapability.models.map((model) => (
              <SelectItem key={model.id} value={model.id} className="cursor-pointer">
                {sourceControlModelLabel(model)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>
          {t('auto.components.feature.wall.AiCommitPrSettingsCard.4b2fc4b80c', 'Thinking effort')}
        </Label>
        {activeModel.thinkingLevels?.length ? (
          <Select value={activeThinking} onValueChange={onThinkingChange}>
            <SelectTrigger size="sm" className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent portalContainer={selectPortalRoot} position="popper" align="start">
              {activeModel.thinkingLevels.map((level) => (
                <SelectItem key={level.id} value={level.id} className="cursor-pointer">
                  {sourceControlThinkingLabel(level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          // Why: the row stays visible so a model without an effort setting reads as
          // exactly that, instead of the control silently disappearing.
          <>
            <Select disabled>
              <SelectTrigger size="sm" className="h-8 w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
            </Select>
            <p className="text-2xs leading-snug text-muted-foreground">
              {t('settings.aiGeneration.noEffortForModel', 'This model has no effort setting.')}
            </p>
          </>
        )}
      </div>
    </>
  )
}

/** Agent / model / thinking-effort pickers for an agent-CLI text-generation setting.
 *
 *  Storage belongs to the caller; this only renders the choice. Keep it in step with
 *  `resolveAiGenerationSelection`, which derives the values its props expect. */
export function AiGenerationFields(props: AiGenerationFieldsProps): JSX.Element {
  const t = useTranslate()
  const { config, isCustom, unsupportedAgentLabel, onCustomCommandChange } = props
  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-1.5">
        <Label>
          {t('auto.components.feature.wall.AiCommitPrSettingsCard.29d119fe95', 'Agent')}
        </Label>
        {usesLaunchPicker(props) ? (
          <AiGenerationLaunchAgentPicker {...props} />
        ) : (
          <AiGenerationAgentSelect {...props} />
        )}
        {unsupportedAgentLabel ? (
          <p className="text-2xs leading-snug text-muted-foreground">
            {t(
              'auto.components.feature.wall.AiCommitPrSettingsCard.unsupportedAgent',
              '{{agent}} is not supported. Choose Claude, Codex, or Custom.',
              { agent: unsupportedAgentLabel }
            )}
          </p>
        ) : null}
      </div>

      {usesLaunchPicker(props) ? null : <AiGenerationModelFields {...props} />}

      {isCustom ? (
        <div className="space-y-1.5">
          <Label htmlFor="ai-generation-custom-command">
            {t('auto.components.feature.wall.AiCommitPrSettingsCard.9ee54037a4', 'Custom command')}
          </Label>
          <Input
            id="ai-generation-custom-command"
            value={config.customAgentCommand}
            onChange={(event) => onCustomCommandChange(event.target.value)}
            placeholder={t(
              'auto.components.feature.wall.AiCommitPrSettingsCard.8d4152701a',
              'e.g. ollama run llama3.1 {{value0}}',
              { value0: CUSTOM_PROMPT_PLACEHOLDER }
            )}
            spellCheck={false}
            className="h-8"
          />
        </div>
      ) : null}
    </div>
  )
}
