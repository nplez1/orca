import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import { AiGenerationFields } from './ai-generation-fields'
import { SearchableSetting } from './SearchableSetting'
import { useSessionSummaryAiSettings } from './use-session-summary-ai-settings'

/** Settings → Agents: which agent and model fold a session summary.
 *
 *  Its own setting rather than a Source Control AI recipe, so summary cost can be
 *  tuned without changing commit messages. */
export function SessionSummaryAiSetting(): React.JSX.Element {
  const {
    config,
    selectPortalRoot,
    setSelectPortalHost,
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
  } = useSessionSummaryAiSettings()

  const title = translate('settings.sessionSummaryAi.title', 'Session summaries')
  const description = translate(
    'settings.sessionSummaryAi.description',
    'The agent and model that summarize a session in the Summary tab. A fold runs only while that tab is open, reads only what was added since the last fold, and its result is cached.'
  )

  return (
    <section className="space-y-3" ref={setSelectPortalHost}>
      <SearchableSetting
        title={title}
        description={description}
        keywords={['summary', 'summaries', 'agent', 'model', 'transcript', 'tokens', 'cost']}
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{title}</Label>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <AiGenerationFields
            config={config}
            selectPortalRoot={selectPortalRoot}
            agentSelectValue={agentSelectValue}
            activeCapability={activeCapability}
            activeModel={activeModel}
            activeThinking={activeThinking}
            isCustom={isCustom}
            unsupportedAgentLabel={unsupportedAgentLabel}
            onAgentChange={onAgentChange}
            onModelChange={onModelChange}
            onThinkingChange={onThinkingChange}
            onCustomCommandChange={onCustomCommandChange}
          />
        </div>
      </SearchableSetting>
    </section>
  )
}
