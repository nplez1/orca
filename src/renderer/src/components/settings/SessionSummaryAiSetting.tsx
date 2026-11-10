import { RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { AiGenerationFields } from './ai-generation-fields'
import { SearchableSetting } from './section-layout/SearchableSetting'
import { useSessionSummaryAiSettings } from './use-session-summary-ai-settings'

/** Settings → Agents: which agent and model fold a session summary.
 *
 *  Its own setting rather than a Source Control AI recipe, so summary cost can be
 *  tuned without changing commit messages. */
export function SessionSummaryAiSetting(): React.JSX.Element {
  const t = useTranslate()
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
    discoveryStatus,
    onAgentChange,
    onModelChange,
    onThinkingChange,
    onCustomCommandChange,
    onRefreshModels
  } = useSessionSummaryAiSettings()

  const title = t('settings.sessionSummaryAi.title', 'Session summaries')
  const description = t(
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
          {discoveryStatus !== 'idle' || activeCapability?.modelSource === 'dynamic' ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] leading-snug text-muted-foreground">
                {discoveryStatus === 'discovering'
                  ? t('settings.sessionSummaryAi.discovering', 'Discovering models…')
                  : discoveryStatus === 'unavailable'
                    ? t(
                        'settings.sessionSummaryAi.modelsUnavailable',
                        "Couldn't list this agent's models — using its built-in list."
                      )
                    : null}
              </p>
              {activeCapability?.modelSource === 'dynamic' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="w-fit shrink-0"
                  onClick={onRefreshModels}
                >
                  <RefreshCw className="size-3" />
                  {t('settings.sessionSummaryAi.refreshModels', 'Refresh models')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SearchableSetting>
    </section>
  )
}
