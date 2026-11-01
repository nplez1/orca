import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, FolderPlus, GitBranchPlus, X } from 'lucide-react'
import { useAppStore } from '../store'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import {
  dismissPreflightIssue,
  githubProjectKeys,
  isPreflightIssueDismissed
} from './landing-preflight-dismissal'
import { ShortcutKeyCombo } from './ShortcutKeyCombo'
import { useShortcutKeyDetails, type ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { hasGitHubBackedProject, type PreflightIssue } from './landing-preflight-issues'
import { useLandingPreflightRuntime } from './landing-preflight-runtime'
import { GitHubStarButton } from './GitHubStarButton'
import { useOrcaStarState } from './orca-star-state'
import { OrcaBrandMark } from './OrcaBrandMark'
import { openAppHttpLink } from '@/lib/app-http-link-open'

type ShortcutItem = {
  id: string
  shortcut: ShortcutKeyComboDetails
  action: string
}

function dismissedPreflightIssueIds(issues: PreflightIssue[], repos: readonly Repo[]): Set<string> {
  return new Set(
    issues
      .filter((issue) => issue.dismissible && isPreflightIssueDismissed(issue.id, repos))
      .map((issue) => issue.id)
  )
}

function PreflightBanner({
  issues,
  repos
}: {
  issues: PreflightIssue[]
  repos: readonly Repo[]
}): React.JSX.Element | null {
  // Recheck dismissals when the GitHub project set changes so expired nudges can reappear.
  const githubKey = githubProjectKeys(repos).join('|')
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    dismissedPreflightIssueIds(issues, repos)
  )

  // Reseed only when GitHub projects change; issues identity is stable and would reset transient dismissals each render.
  const reseedDismissed = useEffectEvent(() =>
    setDismissed(dismissedPreflightIssueIds(issues, repos))
  )
  useEffect(() => {
    reseedDismissed()
  }, [githubKey])

  const visibleIssues = issues.filter((issue) => !dismissed.has(issue.id))
  if (visibleIssues.length === 0) {
    return null
  }

  const dismiss = (issue: PreflightIssue): void => {
    dismissPreflightIssue(issue.id, repos)
    setDismissed((prev) => new Set(prev).add(issue.id))
  }

  return (
    // Keep setup nudges narrow and muted; the styleguide reserves warning/error framing for actual problems.
    <div className="w-full max-w-sm space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
      {visibleIssues.map((issue) => (
        <div
          key={issue.id}
          className="flex items-start gap-3 rounded-md px-1 py-1.5 first:pt-0 last:pb-0"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500/70" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-[13px] font-medium leading-snug text-foreground">{issue.title}</p>
            <p className="text-xs leading-snug text-muted-foreground">{issue.description}</p>
            <button
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline cursor-pointer"
              data-link-url={issue.fixUrl}
              onClick={(event) => openAppHttpLink(issue.fixUrl, { event })}
            >
              {issue.fixLabel}
              <ExternalLink className="size-3" />
            </button>
          </div>
          {issue.dismissible && (
            <button
              className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
              onClick={() => dismiss(issue)}
              aria-label={translate('auto.components.Landing.preflightDismiss', 'Dismiss')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export default function Landing(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const openModal = useAppStore((s) => s.openModal)

  const createActionLabel =
    repos.length > 0 && repos.every((repo) => isGitRepoKind(repo))
      ? translate('auto.components.NewWorkspaceComposerModal.createWorktree', 'Create worktree')
      : translate('auto.components.NewWorkspaceComposerModal.createWorkspace', 'Create workspace')
  const moveUpLabel = translate('auto.components.Landing.moveUpWorkspace', 'Move up workspace')
  const moveDownLabel = translate(
    'auto.components.Landing.moveDownWorkspace',
    'Move down workspace'
  )
  const hasProjects = repos.length > 0
  const hasGitHubProject = useMemo(() => hasGitHubBackedProject(repos), [repos])
  const showGitHubSupportFooter = repos.length === 0 || hasGitHubProject

  // Probe the active execution host, including remote runtimes.
  const { preflightIssues } = useLandingPreflightRuntime()
  const [starState, setStarState] = useOrcaStarState()

  const createWorktreeShortcut = useShortcutKeyDetails('workspace.create')
  const previousWorktreeShortcut = useShortcutKeyDetails('worktree.navigateUp')
  const nextWorktreeShortcut = useShortcutKeyDetails('worktree.navigateDown')
  const shortcuts = useMemo<ShortcutItem[]>(() => {
    return [
      { id: 'create', shortcut: createWorktreeShortcut, action: createActionLabel },
      { id: 'up', shortcut: previousWorktreeShortcut, action: moveUpLabel },
      { id: 'down', shortcut: nextWorktreeShortcut, action: moveDownLabel }
    ]
  }, [
    createActionLabel,
    moveUpLabel,
    moveDownLabel,
    createWorktreeShortcut,
    nextWorktreeShortcut,
    previousWorktreeShortcut
  ])

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-lg px-6">
        <div className="flex flex-col items-center gap-4 py-8">
          <OrcaBrandMark
            logoAlt={translate('auto.components.Landing.520304a067', 'Orca logo')}
            title={translate('auto.components.Landing.6ca6ff404e', 'ORCA')}
          />

          {preflightIssues.length > 0 && <PreflightBanner issues={preflightIssues} repos={repos} />}

          <p className="text-sm text-muted-foreground text-center">
            {hasProjects
              ? translate(
                  'auto.components.Landing.9c00bd4adf',
                  'Select a workspace from the sidebar to begin.'
                )
              : translate('auto.components.Landing.cd21242762', 'Add a project to get started.')}
          </p>

          <div className="flex items-center justify-center gap-2.5 flex-wrap">
            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors"
              onClick={() => openModal('add-repo')}
            >
              <FolderPlus className="size-3.5" />
              {translate('auto.components.Landing.f9eaa9e12d', 'Add project')}
            </button>

            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors"
              onClick={() => openModal('new-workspace-composer', { telemetrySource: 'unknown' })}
            >
              <GitBranchPlus className="size-3.5" />
              {createActionLabel}
            </button>
          </div>

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
        </div>
      </div>

      {showGitHubSupportFooter && (
        <div className="absolute bottom-6 left-0 right-0 flex justify-center">
          <GitHubStarButton hasRepos={repos.length > 0} state={starState} setState={setStarState} />
        </div>
      )}
    </div>
  )
}
