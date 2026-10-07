import type { JSX } from 'react'
import { Terminal } from 'lucide-react'
import { CUSTOM_PROMPT_PLACEHOLDER } from '../../../../shared/commit-message-prompt'
import {
  CUSTOM_AGENT_ID,
  listCommitMessageAgentCapabilities,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability
} from '../../../../shared/commit-message-agent-spec'
import { cn } from '@/lib/utils'
import {
  aiGenerationAgentLabel,
  type AiGenerationSettingsConfig
} from '@/lib/ai-generation-settings'
import { AgentIcon } from '@/lib/agent-catalog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

export type AiGenerationFieldsProps = {
  config: AiGenerationSettingsConfig
  selectPortalRoot: HTMLElement | null
  agentSelectValue: string | undefined
  activeCapability: CommitMessageAgentCapability | undefined
  activeModel: CommitMessageModelCapability | null
  activeThinking: string | undefined
  isCustom: boolean
  unsupportedAgentLabel: string | null
  onAgentChange: (newAgentId: string) => void
  onModelChange: (newModelId: string) => void
  onThinkingChange: (newLevelId: string) => void
  onCustomCommandChange: (value: string) => void
}

/** Agent / model / thinking-effort pickers for an agent-CLI text-generation setting.
 *
 *  Storage belongs to the caller; this only renders the choice. Keep it in step with
 *  `resolveAiGenerationSelection`, which derives the values its props expect. */
export function AiGenerationFields({
  config,
  selectPortalRoot,
  agentSelectValue,
  activeCapability,
  activeModel,
  activeThinking,
  isCustom,
  unsupportedAgentLabel,
  onAgentChange,
  onModelChange,
  onThinkingChange,
  onCustomCommandChange
}: AiGenerationFieldsProps): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-1.5">
        <Label>
          {translate('auto.components.feature.wall.AiCommitPrSettingsCard.29d119fe95', 'Agent')}
        </Label>
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
                    {translate(
                      'auto.components.feature.wall.AiCommitPrSettingsCard.560d4feb00',
                      'Custom'
                    )}
                  </span>
                </>
              ) : (
                <span className="truncate">
                  {unsupportedAgentLabel
                    ? translate(
                        'auto.components.feature.wall.AiCommitPrSettingsCard.1f9468c5c9',
                        '{{value0}} unsupported',
                        { value0: unsupportedAgentLabel }
                      )
                    : translate(
                        'auto.components.feature.wall.AiCommitPrSettingsCard.bd14e9c42a',
                        'Not configured'
                      )}
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
                  {translate(
                    'auto.components.feature.wall.AiCommitPrSettingsCard.560d4feb00',
                    'Custom'
                  )}
                </span>
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        {unsupportedAgentLabel ? (
          <p className="text-[11px] leading-snug text-muted-foreground">
            {unsupportedAgentLabel}{' '}
            {translate(
              'auto.components.feature.wall.AiCommitPrSettingsCard.4d9b6d84df',
              'unsupported. Choose Claude, Codex, or Custom.'
            )}
          </p>
        ) : null}
      </div>

      {activeCapability && activeModel ? (
        <div className="space-y-1.5">
          <Label>
            {translate('auto.components.feature.wall.AiCommitPrSettingsCard.be8917699e', 'Model')}
          </Label>
          <Select value={activeModel.id} onValueChange={onModelChange}>
            <SelectTrigger size="sm" className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent portalContainer={selectPortalRoot} position="popper" align="start">
              {activeCapability.models.map((model) => (
                <SelectItem key={model.id} value={model.id} className="cursor-pointer">
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {activeCapability && activeModel ? (
        <div className="space-y-1.5">
          <Label>
            {translate(
              'auto.components.feature.wall.AiCommitPrSettingsCard.4b2fc4b80c',
              'Thinking effort'
            )}
          </Label>
          {activeModel.thinkingLevels?.length ? (
            <Select value={activeThinking} onValueChange={onThinkingChange}>
              <SelectTrigger size="sm" className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent portalContainer={selectPortalRoot} position="popper" align="start">
                {activeModel.thinkingLevels.map((level) => (
                  <SelectItem key={level.id} value={level.id} className="cursor-pointer">
                    {level.label}
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
              <p className="text-[11px] leading-snug text-muted-foreground">
                {translate(
                  'settings.aiGeneration.noEffortForModel',
                  'This model has no effort setting.'
                )}
              </p>
            </>
          )}
        </div>
      ) : null}

      {isCustom ? (
        <div className="space-y-1.5">
          <Label htmlFor="ai-generation-custom-command">
            {translate(
              'auto.components.feature.wall.AiCommitPrSettingsCard.9ee54037a4',
              'Custom command'
            )}
          </Label>
          <Input
            id="ai-generation-custom-command"
            value={config.customAgentCommand}
            onChange={(event) => onCustomCommandChange(event.target.value)}
            placeholder={translate(
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
