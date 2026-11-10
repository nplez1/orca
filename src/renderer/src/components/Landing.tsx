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
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { hasGitHubBackedProject, type PreflightIssue } from './landing-preflight-issues'
import { useLandingPreflightRuntime } from './landing-preflight-runtime'
import { GitHubStarButton } from './GitHubStarButton'
import { useOrcaStarState } from './orca-star-state'
import { OrcaBrandMark } from './OrcaBrandMark'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import {
  LANDING_ACTION_BUTTON_CLASS,
  LandingShortcutList,
  type LandingShortcutItem
} from './landing-layout'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
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
              aria-label={t('auto.components.Landing.preflightDismiss', 'Dismiss')}
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
  const t = useTranslate()
  const repos = useAppStore((s) => s.repos)
  const openModal = useAppStore((s) => s.openModal)

  const createActionLabel =
    repos.length > 0 && repos.every((repo) => isGitRepoKind(repo))
      ? t('auto.components.NewWorkspaceComposerModal.createWorktree', 'Create worktree')
      : t('auto.components.NewWorkspaceComposerModal.createWorkspace', 'Create workspace')
  const moveUpLabel = t('auto.components.Landing.moveUpWorkspace', 'Move up workspace')
  const moveDownLabel = t('auto.components.Landing.moveDownWorkspace', 'Move down workspace')
  const hasProjects = repos.length > 0
  const hasGitHubProject = useMemo(() => hasGitHubBackedProject(repos), [repos])
  const showGitHubSupportFooter = repos.length === 0 || hasGitHubProject

  // Probe the active execution host, including remote runtimes.
  const { preflightIssues } = useLandingPreflightRuntime()
  const [starState, setStarState] = useOrcaStarState()

  const createWorktreeShortcut = useShortcutKeyDetails('workspace.create')
  const previousWorktreeShortcut = useShortcutKeyDetails('worktree.navigateUp')
  const nextWorktreeShortcut = useShortcutKeyDetails('worktree.navigateDown')
  const shortcuts = useMemo<LandingShortcutItem[]>(() => {
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
            logoAlt={t('auto.components.Landing.520304a067', 'Orca logo')}
            title={t('auto.components.Landing.6ca6ff404e', 'ORCA')}
          />

          {preflightIssues.length > 0 && <PreflightBanner issues={preflightIssues} repos={repos} />}

          <p className="text-sm text-muted-foreground text-center">
            {hasProjects
              ? t(
                  'auto.components.Landing.9c00bd4adf',
                  'Select a workspace from the sidebar to begin.'
                )
              : t('auto.components.Landing.cd21242762', 'Add a project to get started.')}
          </p>

          <div className="flex items-center justify-center gap-2.5 flex-wrap">
            <button className={LANDING_ACTION_BUTTON_CLASS} onClick={() => openModal('add-repo')}>
              <FolderPlus className="size-3.5" />
              {t('auto.components.Landing.f9eaa9e12d', 'Add project')}
            </button>

            <button
              className={LANDING_ACTION_BUTTON_CLASS}
              onClick={() => openModal('new-workspace-composer', { telemetrySource: 'unknown' })}
            >
              <GitBranchPlus className="size-3.5" />
              {createActionLabel}
            </button>
          </div>

          <LandingShortcutList shortcuts={shortcuts} />
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
