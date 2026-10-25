import { useMemo } from 'react'
import { TerminalSquare } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { useShortcutKeyDetails, type ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { useTabBarDefaultAgent } from '@/components/tab-bar/use-tab-bar-default-agent'
import { hasGitHubBackedProject } from '@/components/landing-preflight-issues'
import { GitHubStarButton } from '@/components/GitHubStarButton'
import { useOrcaStarState } from '@/components/orca-star-state'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { TuiAgent } from '../../../../shared/tui-agent'
import logo from '../../../../../resources/logo.svg'

type ShortcutItem = { id: string; shortcut: ShortcutKeyComboDetails; action: string }

export type WorkspaceEmptyStateProps = {
  worktreeId: string
  onNewTerminal: () => void
  onNewAgent: (agent: TuiAgent) => void
}

/**
 * The workspace surface for an open workspace with no tabs. Closing the last tab keeps the
 * workspace selected and lands here instead of the landing page, so every way to open the first
 * tab — and the shortcuts that do it — is offered in place.
 */
export function WorkspaceEmptyState({
  worktreeId,
  onNewTerminal,
  onNewAgent
}: WorkspaceEmptyStateProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const { agent: defaultAgent, isAgentLaunchPending } = useTabBarDefaultAgent(worktreeId)
  const [starState, setStarState] = useOrcaStarState()

  const newTerminalShortcut = useShortcutKeyDetails('tab.newTerminal')
  const newAgentShortcut = useShortcutKeyDetails('tab.newAgent')
  const shortcuts = useMemo<ShortcutItem[]>(() => {
    const items: ShortcutItem[] = []
    if (defaultAgent && newAgentShortcut.keys.length > 0) {
      items.push({
        id: 'agent',
        shortcut: newAgentShortcut,
        action: translate('auto.components.workspaceEmptyState.agentShortcut', 'New agent tab')
      })
    }
    if (newTerminalShortcut.keys.length > 0) {
      items.push({
        id: 'terminal',
        shortcut: newTerminalShortcut,
        action: translate(
          'auto.components.workspaceEmptyState.terminalShortcut',
          'New terminal tab'
        )
      })
    }
    return items
  }, [defaultAgent, newAgentShortcut, newTerminalShortcut])

  const defaultAgentLabel = defaultAgent
    ? (getAgentCatalog().find((entry) => entry.id === defaultAgent)?.label ?? defaultAgent)
    : null
  const showStarFooter = repos.length === 0 || hasGitHubBackedProject(repos)

  return (
    <div
      className="relative flex h-full w-full min-w-0 min-h-0 items-center justify-center overflow-hidden bg-background"
      data-workspace-empty-state=""
    >
      <div className="w-full max-w-lg px-6">
        <div className="flex flex-col items-center gap-4 py-8">
          <div
            className="flex items-center justify-center size-20 rounded-2xl border border-border/80 shadow-lg shadow-black/40"
            style={{ backgroundColor: '#12181e' }}
          >
            <img
              src={logo}
              alt={translate('auto.components.workspaceEmptyState.logo', 'Orca logo')}
              className="size-12"
            />
          </div>
          <h1 className="text-4xl font-bold text-foreground tracking-tight">
            {translate('auto.components.workspaceEmptyState.title', 'ORCA')}
          </h1>

          <p className="text-sm text-muted-foreground text-center">
            {translate(
              'auto.components.workspaceEmptyState.description',
              'This workspace has no open tabs.'
            )}
          </p>

          <div className="flex items-center justify-center gap-2.5 flex-wrap">
            {defaultAgent && defaultAgentLabel ? (
              <button
                className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-default disabled:hover:bg-secondary/70"
                onClick={() => onNewAgent(defaultAgent)}
                disabled={isAgentLaunchPending}
              >
                <AgentIcon agent={defaultAgent} size={14} />
                {translate('auto.components.workspaceEmptyState.newAgent', 'New {{agent}} agent', {
                  agent: defaultAgentLabel
                })}
              </button>
            ) : null}

            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors"
              onClick={onNewTerminal}
            >
              <TerminalSquare className="size-3.5" />
              {translate('auto.components.workspaceEmptyState.newTerminal', 'New terminal')}
            </button>
          </div>

          {shortcuts.length > 0 ? (
            <div className="mt-6 w-full max-w-xs space-y-2">
              {shortcuts.map((shortcut) => (
                <div key={shortcut.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
                  <span className="text-sm text-muted-foreground">{shortcut.action}</span>
                  <ShortcutKeyCombo
                    keys={shortcut.shortcut.keys}
                    doubleTap={shortcut.shortcut.doubleTap}
                    separatorClassName="mx-0.5 text-[10px] text-muted-foreground"
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {showStarFooter ? (
        <div className="absolute bottom-6 left-0 right-0 flex justify-center">
          <GitHubStarButton hasRepos={repos.length > 0} state={starState} setState={setStarState} />
        </div>
      ) : null}
    </div>
  )
}
