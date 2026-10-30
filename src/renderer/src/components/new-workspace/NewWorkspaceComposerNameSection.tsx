import React from 'react'
import { AlertTriangle } from 'lucide-react'
import SmartWorkspaceNameField from '@/components/new-workspace/SmartWorkspaceNameField'
import { TaskImpliedSourceNameField } from './TaskImpliedSourceNameField'
import { LockedComposerValue } from './LockedComposerValue'
import { resolveImpliedTaskSource } from './implied-task-source'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { shouldShowComposerBaseRefPicker } from './base-ref-picker-visibility'
import { ComposerBaseRefPicker } from './ComposerBaseRefPicker'
import { ComposerBranchChoice } from './ComposerBranchChoice'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerNameSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'nameInputRef'
  | 'eligibleRepos'
  | 'selectedRepo'
  | 'repoId'
  | 'onRepoChange'
  | 'name'
  | 'onNameValueChange'
  | 'onSmartGitHubItemSelect'
  | 'onSmartGitLabItemSelect'
  | 'onSmartBranchSelect'
  | 'onSmartLinearIssueSelect'
  | 'onSmartJiraIssueSelect'
  | 'onOpenJiraSettings'
  | 'smartNameSelection'
  | 'impliedTaskSourceUrl'
  | 'onClearSmartNameSelection'
  | 'smartNameGitHubSourceContext'
  | 'smartNameJiraSourceContext'
  | 'selectedRepoRequiresConnection'
  | 'selectedRepoIsGit'
  | 'branchesEnabled'
  | 'repoBackedSourcesDisabled'
  | 'repoBackedSearchRepos'
  | 'allowSmartNameAddProject'
  | 'smartNameRepoSwitchTarget'
  | 'onSmartNameModeChange'
  | 'smartNameMode'
  | 'forkPushWarning'
  | 'canReuseSelectedBranch'
  | 'reuseSelectedBranch'
  | 'reuseEligibleBranch'
  | 'branchNameOverride'
  | 'onBranchNameOverrideChange'
  | 'onReuseSelectedBranchChange'
  | 'onOpenSelectedBranchWorkspace'
  | 'baseBranch'
  | 'onBaseBranchChange'
  | 'startFromResetHint'
  | 'identityLocked'
  | 'lockedTargetIsSourceHost'
> & {
  onNamePlainEnter: () => void
}

export function NewWorkspaceComposerNameSection({
  nameInputRef,
  eligibleRepos,
  selectedRepo,
  repoId,
  onRepoChange,
  name,
  onNameValueChange,
  onSmartGitHubItemSelect,
  onSmartGitLabItemSelect,
  onSmartBranchSelect,
  onSmartLinearIssueSelect,
  onSmartJiraIssueSelect,
  onOpenJiraSettings,
  smartNameSelection,
  impliedTaskSourceUrl = null,
  onClearSmartNameSelection,
  smartNameGitHubSourceContext,
  smartNameJiraSourceContext,
  selectedRepoRequiresConnection,
  selectedRepoIsGit,
  branchesEnabled = true,
  repoBackedSourcesDisabled = false,
  repoBackedSearchRepos,
  allowSmartNameAddProject = true,
  smartNameRepoSwitchTarget = 'project',
  onSmartNameModeChange,
  smartNameMode,
  onNamePlainEnter,
  forkPushWarning,
  canReuseSelectedBranch,
  reuseSelectedBranch,
  reuseEligibleBranch,
  branchNameOverride,
  onBranchNameOverrideChange,
  onReuseSelectedBranchChange,
  onOpenSelectedBranchWorkspace,
  baseBranch,
  onBaseBranchChange,
  startFromResetHint,
  identityLocked = false,
  lockedTargetIsSourceHost = false
}: NewWorkspaceComposerNameSectionProps): React.JSX.Element {
  const showBaseRefPicker =
    !identityLocked &&
    Boolean(onBaseBranchChange) &&
    shouldShowComposerBaseRefPicker({
      selectedRepoIsGit,
      branchesEnabled,
      smartNameMode: smartNameMode ?? 'smart',
      smartNameSelectionKind: smartNameSelection?.kind ?? null
    })
  const showReuseBranchOption = canReuseSelectedBranch && !identityLocked
  // Why a source the composer cannot change: the dialog was opened from the
  // task, so the only decision left is what to call the workspace. Resolved
  // against the live selection, not a flag, so a source that was dropped or
  // replaced under the composer stops being presented as the fixed one.
  const impliedSource = resolveImpliedTaskSource(impliedTaskSourceUrl, smartNameSelection)
  return (
    <div className="min-w-0 space-y-1" data-contextual-tour-target="workspace-creation-name">
      <div className="flex items-center justify-between gap-2">
        <label className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {selectedRepoIsGit && !impliedSource && !identityLocked
            ? translate('auto.components.NewWorkspaceComposerCard.ac3748dcda', 'Create From')
            : translate(
                'auto.components.NewWorkspaceComposerCard.0ee17638fe',
                'Workspace name'
              )}{' '}
          {identityLocked ? null : (
            <span className="text-muted-foreground/70">
              {translate('auto.components.NewWorkspaceComposerCard.0c5d6a479c', '[Optional]')}
            </span>
          )}
        </label>
        {showBaseRefPicker && onBaseBranchChange ? (
          <ComposerBaseRefPicker
            repoId={repoId}
            baseBranch={baseBranch}
            onBaseBranchChange={onBaseBranchChange}
            resetHint={startFromResetHint}
            readOnly={selectedRepoRequiresConnection}
          />
        ) : null}
      </div>
      {identityLocked ? (
        // Why: the workspace this copy stands for already fixed the name and branch;
        // only the host is still a decision, so the field is a fact rather than an input.
        <LockedComposerValue value={name} />
      ) : impliedSource ? (
        <TaskImpliedSourceNameField
          inputRef={nameInputRef}
          source={impliedSource}
          value={name}
          onValueChange={onNameValueChange}
          disabled={selectedRepoRequiresConnection}
          disabledPlaceholder={translate(
            'auto.components.NewWorkspaceComposerCard.connectProjectFirst',
            'Connect this project first'
          )}
          onPlainEnter={onNamePlainEnter}
        />
      ) : (
        <SmartWorkspaceNameField
          inputRef={nameInputRef}
          repos={eligibleRepos}
          selectedRepo={selectedRepo}
          repoId={repoId}
          onRepoChange={onRepoChange}
          value={name}
          onValueChange={onNameValueChange}
          onGitHubItemSelect={onSmartGitHubItemSelect}
          onGitLabItemSelect={onSmartGitLabItemSelect}
          onBranchSelect={onSmartBranchSelect}
          onLinearIssueSelect={onSmartLinearIssueSelect}
          onJiraIssueSelect={onSmartJiraIssueSelect}
          onOpenJiraSettings={onOpenJiraSettings}
          selectedSource={smartNameSelection}
          onClearSelectedSource={onClearSmartNameSelection}
          githubSourceContext={smartNameGitHubSourceContext}
          jiraSourceContext={smartNameJiraSourceContext}
          disabled={selectedRepoRequiresConnection}
          disabledPlaceholder={translate(
            'auto.components.NewWorkspaceComposerCard.connectProjectFirst',
            'Connect this project first'
          )}
          textOnly={!selectedRepoIsGit}
          branchesEnabled={branchesEnabled}
          repoBackedSourcesDisabled={repoBackedSourcesDisabled}
          repoBackedSearchRepos={repoBackedSearchRepos}
          allowCrossRepoProjectAdd={allowSmartNameAddProject}
          crossRepoSwitchTarget={smartNameRepoSwitchTarget}
          onActiveSourceModeChange={onSmartNameModeChange}
          onPlainEnter={onNamePlainEnter}
        />
      )}
      {lockedTargetIsSourceHost ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.NewWorkspaceComposerCard.pickAnotherHost',
            'This workspace already lives on that host. Pick another one to copy this branch there.'
          )}
        </p>
      ) : null}
      {forkPushWarning ? (
        <p className="flex items-start gap-1.5 text-[11px] text-yellow-600 dark:text-yellow-500">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{forkPushWarning}</span>
        </p>
      ) : null}
      <div
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          showReuseBranchOption ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        aria-hidden={!showReuseBranchOption}
        inert={!showReuseBranchOption}
      >
        <div className="min-h-0">
          <div className="pt-3">
            <ComposerBranchChoice
              existingBranchName={reuseEligibleBranch ?? smartNameSelection?.label}
              reuseSelectedBranch={reuseSelectedBranch}
              onReuseSelectedBranchChange={onReuseSelectedBranchChange}
              branchNameOverride={branchNameOverride}
              onBranchNameOverrideChange={onBranchNameOverrideChange}
              onOpenSelectedBranchWorkspace={onOpenSelectedBranchWorkspace}
              disabled={!canReuseSelectedBranch}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
