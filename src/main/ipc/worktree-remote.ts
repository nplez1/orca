/* eslint-disable max-lines */

import { worktreeCreateGit } from '../git/worktree-create-git-executor'
import { getStoredRepoExecutionHostId } from '../repo-execution-host'
import type { BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'
import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import type { LocalGitExecOptions } from '../github/github-repository-identity'
import type { Repo } from '../../shared/repo-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type {
  CreateWorktreeArgs,
  CreateWorktreeProgressEvent,
  CreateWorktreeResult,
  WorktreeCheckoutProgress,
  WorktreeCreateBaseFallback
} from '../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitPushTarget,
  GitStatusMetadataChangedEvent,
  Worktree,
  WorktreeHeadIdentity
} from '../../shared/worktree/types'
import { getPRForBranch } from '../github/client'
import { listWorktrees, addWorktree, addSparseWorktree } from '../git/worktree'
import type { AddWorktreeOptions, AddWorktreeResult } from '../git/worktree'
import {
  consumePreparedWorktreeCreate,
  type PreparationRearmHolder
} from '../worktree-create-preparation'
import { getBranchConflictKind, resolveDefaultBaseRefWithLocalGit } from '../git/repo'
import { WorktreeCreateCollisionError } from '../../shared/new-workspace/worktree-create-collision'
import { resolveLocalGitUsername } from '../git/git-username'
import { hasLocalWorktreeBaseRef } from '../git/worktree-base-ref-probe'
import { resolveWorktreeCreateBase } from '../worktree-create-base'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import type { ForgeProviderId } from '../source-control/forge-provider'
import { validateGitPushTarget } from '../git/push-target-validation'
import { gitExecFileAsync } from '../git/runner'
import type {
  OrcaRuntimeService,
  RemoteFetchResult,
  RemoteTrackingBase
} from '../runtime/orca-runtime'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import { getEffectiveHooks, loadHooks } from '../hooks'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import {
  getDefaultTabsLaunch,
  getEffectiveHooksFromConfig,
  shouldRunSetupForCreate
} from '../effective-hook-config'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { runWorktreeChangeInvalidators } from './worktree-change-invalidators'

type CreateWorktreeArgsWithSystemProvenance = CreateWorktreeArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
  cliProvenance?: CliWorkspaceProvenance
}
import {
  sanitizeWorktreeName,
  computeWorktreePath,
  computeWorkspaceRootAsync,
  ensurePathWithinWorkspace,
  getWorktreeCreationLayout,
  getWorktreePathSettings
} from './worktree-logic'
import {
  resolveWorktreeCreateDisplayNameRequest,
  resolveWorktreeCreateDisplayNameMeta
} from './worktree-display-name'
import { computeValidatedBranchName } from './worktree-branch-name'
import { mergeWorktree } from './worktree-metadata-merge'
import { resolveCreatedWorktree } from './created-worktree-reconciliation'
import { notifyLineageRepos } from '../worktree-lineage-change-notification'
import { composeWorktreeId, getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { BranchPrefixSettings } from '../../shared/branch-prefix'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { sharesWorktreeLineageBoundary } from '../../shared/resolved-worktree-lineage'
import {
  cleanupUnusedWorktreePushTargetRemoteWithExec,
  sameGitHubRemoteUrl,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'
import { reconcileOrphanedPrRemotes } from './worktree-push-target-reconciliation'
import {
  configureCreatedWorktreePushTargetWithExec,
  prepareWorktreePushTargetWithExec,
  remoteAlreadyMatchesUrl,
  restoreUpstreamAfterMaterialize
} from './worktree-push-target-setup'
import {
  buildNarrowForkFetchRefspec,
  ensureRemoteTracksBranchNarrowly,
  forkRemoteTrackingRefExists
} from '../git/fork-remote-refspec'
import { migrateForkRemoteRefspecs } from './worktree-push-target-refspec-migration'
import {
  registerCreatedWorktreeRoot,
  registerWorktreeRootsForRepo
} from './registered-worktree-roots-cache'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from './worktree-symlinks'
import { formatWorktreeIncludeCopyWarning } from './worktree-include-copy-budget'
import { formatWorktreeSharedDirectoriesWarning } from '../git/worktree-shared-directories-warning'
import { resolveWorktreeIncludePaths } from '../git/worktree-include-file'
import { resolveWorktreeSharedDirectories } from '../git/worktree-shared-directories'
import { normalizeSparseDirectories } from './sparse-checkout-directories'
import { attributedSparsePresetId } from './sparse-preset-attribution'
import {
  buildSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from '../../shared/setup-runner-command'
import { createSequencedSetupAgentCommands } from '../../shared/setup-agent-sequencing'
import { buildObservedSetupCommand } from '../runtime/orchestration/setup-completion-signal'
import {
  createWorktreeCreateTimingRecorder,
  localWorktreeCreateExecutionHost,
  type WorktreeCreateTimingRecorder
} from '../worktree-create-timing'
import {
  getLocalProjectGhExecOptions,
  getLocalProjectGitExecOptions,
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from '../project-runtime-git-options'
import {
  getBranchNameOverrideCandidate,
  getGeneratedWorktreeCreateCandidate,
  getWorktreeCreateCandidate,
  isGeneratedWorktreeCreateName,
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS
} from '../worktree-create-candidates'
import {
  failedWorktreeCreationNeedsRetirement,
  getRetiredNameRegistryForRepo,
  retireGeneratedWorktreeName
} from '../worktree-name-retirement'
import { createRetiredNameLookup } from '../../shared/worktree/retired-name-registry'
import { findPendingWorktreeRemovalConflict } from '../worktree-removal-table'
import { isWslMoveWorktreeBlocked } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'
import {
  hostWorktreeTargetForRepo,
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost,
  worktreeRowTarget
} from '../persistence/host-qualified-worktree-meta'
// Bound network fetches so Windows credential-manager GUI hangs cannot wedge creation (STA-1292).
const CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS = 60_000
// Deferred materialization also fetches outside the create path and needs the same hang bound.
const DEFERRED_PUSH_TARGET_FETCH_TIMEOUT_MS = 60_000
// Coalesce spawn/sync materialization so competing remote adds cannot strand duplicates.
const worktreePushTargetMaterializeInflight = new Map<string, Promise<GitPushTarget>>()

function worktreePushTargetMaterializeKey(repoPath: string, remoteName: string): string {
  return `${repoPath}::${remoteName}`
}

type StagedStartupResult = {
  startupTerminal?: CreateWorktreeResult['startupTerminal']
  activationSetup?: CreateWorktreeResult['setup']
  didSpawnSetup: boolean
  warning?: string
}

function appendWorktreeCreateWarning(current: string | undefined, next: string): string {
  return current ? `${current} Also ${next[0]?.toLowerCase() ?? ''}${next.slice(1)}` : next
}

function getSetupRunnerCommandPlatformForLaunch(
  setup: CreateWorktreeResult['setup'],
  fallbackPlatform: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallbackPlatform)
}

/** Missing parent picks degrade to no nesting; malformed or self-referential keys still fail. */
export function assertAttachableParentWorkspace(
  store: Store,
  parentWorkspace: CreateWorktreeArgs['parentWorkspace'],
  childWorkspaceKey: ReturnType<typeof worktreeWorkspaceKey>
): void {
  if (!parentWorkspace) {
    return
  }
  if (parentWorkspace === childWorkspaceKey) {
    throw new Error('A worktree cannot be attached to itself.')
  }
  const parentScope = parseWorkspaceKey(parentWorkspace)
  if (!parentScope) {
    throw new Error(`Invalid parent workspace: ${parentWorkspace}`)
  }
  if (parentScope.type === 'folder' && !store.getFolderWorkspace(parentScope.folderWorkspaceId)) {
    console.warn(`[worktree-create] parent folder workspace not found: ${parentWorkspace}`)
    return
  }
  if (parentScope.type === 'worktree' && !store.getWorktreeMeta(parentScope.worktreeId)) {
    console.warn(`[worktree-create] parent worktree workspace not found: ${parentWorkspace}`)
  }
}

type CreatedWorktreeLineageRecords = {
  lineage: CreateWorktreeResult['lineage']
  workspaceLineage: CreateWorktreeResult['workspaceLineage']
}

const NO_CREATED_WORKTREE_LINEAGE: CreatedWorktreeLineageRecords = {
  lineage: null,
  workspaceLineage: null
}

export function recordWorkspaceLineageForCreatedWorktree(
  store: Store,
  args: CreateWorktreeArgs,
  worktree: Worktree,
  createdAt: number
): CreatedWorktreeLineageRecords {
  if (!args.parentWorkspace || !worktree.instanceId) {
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const childWorkspaceKey = worktreeWorkspaceKey(worktree.id)
  if (args.parentWorkspace === childWorkspaceKey) {
    console.warn(`[worktree-create] refusing to attach ${worktree.id} to itself`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const parentScope = parseWorkspaceKey(args.parentWorkspace)
  if (!parentScope) {
    console.warn(`[worktree-create] ignoring invalid parent workspace ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  if (parentScope.type === 'folder' && !store.getFolderWorkspace(parentScope.folderWorkspaceId)) {
    console.warn(`[worktree-create] parent folder workspace disappeared: ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const parentWorktreeMeta =
    parentScope.type === 'worktree'
      ? ((worktree.hostId
          ? readWorktreeMetaForHost(store, parentScope.worktreeId, worktree.hostId)
          : undefined) ?? store.getWorktreeMeta(parentScope.worktreeId))
      : null
  if (parentScope.type === 'worktree' && !parentWorktreeMeta) {
    console.warn(`[worktree-create] parent worktree workspace disappeared: ${args.parentWorkspace}`)
    return NO_CREATED_WORKTREE_LINEAGE
  }

  // Folder parents have no WorktreeLineage row and do not create sidebar nesting.
  let lineage: CreateWorktreeResult['lineage'] = null
  let parentOutsideLineageBoundary = false
  let lineageOwnedByTwin = false
  if (parentScope.type === 'worktree' && parentWorktreeMeta) {
    if (!parentWorktreeMeta.instanceId) {
      console.warn(
        `[worktree-create] parent ${parentScope.worktreeId} has no instance identity; skipping lineage`
      )
    } else if (!sharesWorktreeLineageBoundary(worktree, parentWorktreeMeta)) {
      parentOutsideLineageBoundary = true
      console.warn(
        `[worktree-create] parent ${parentScope.worktreeId} is outside ${worktree.id}'s execution host; skipping lineage`
      )
    } else {
      const target = worktreeRowTarget(store, worktree)
      lineage =
        (target &&
          store.setWorktreeLineage(target, {
            worktreeId: worktree.id,
            worktreeInstanceId: worktree.instanceId,
            parentWorktreeId: parentScope.worktreeId,
            parentWorktreeInstanceId: parentWorktreeMeta.instanceId,
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt
          })) ??
        null
      lineageOwnedByTwin = lineage === null
    }
  }

  // Out-of-boundary parents and twin-owned buckets must not persist cross-host workspace links.
  if (parentOutsideLineageBoundary || lineageOwnedByTwin) {
    return NO_CREATED_WORKTREE_LINEAGE
  }

  const workspaceLineage = store.setWorkspaceLineage({
    childWorkspaceKey,
    childInstanceId: worktree.instanceId,
    parentWorkspaceKey: args.parentWorkspace,
    parentInstanceId: parentWorktreeMeta?.instanceId ?? null,
    origin: 'manual',
    capture: {
      source: parentScope.type === 'worktree' ? 'manual-action' : 'active-workspace',
      confidence: 'explicit'
    },
    createdAt
  })
  return { lineage, workspaceLineage }
}

async function spawnLocalStartupAndSetupTerminals(args: {
  runtime: OrcaRuntimeService
  worktree: Worktree
  startup: CreateWorktreeArgs['startup']
  setup: CreateWorktreeResult['setup']
  defaultTabs: CreateWorktreeResult['defaultTabs']
  settings: GlobalSettings
  createdWithAgent: CreateWorktreeArgs['createdWithAgent']
  /** True when an automation's terminals are provisioned in main (`provisionManagedWorktreeTerminals`). */
  provisionedByHost: boolean
}): Promise<StagedStartupResult> {
  const { runtime, worktree, startup, setup, defaultTabs, createdWithAgent } = args
  const hasDefaultTabs = (defaultTabs?.tabs.length ?? 0) > 0
  // Why no launch-mode input: upstream retired `setupScriptLaunchMode` and stale profiles are
  // stripped on load. The fork's default was `new-tab` — the host spawns the Setup tab itself, so
  // the setting is gone but that behaviour stands (ledger § "Worktree create and removal").
  const canSpawnSetupWithoutStartup = setup !== undefined
  // Why `provisionedByHost && !startup`: with no startup command an automation's terminals (its
  // setup and default tabs) are provisioned in main, so spawning the setup terminal here too would
  // run the setup script twice — and the blank first shell below would activate a background
  // workspace. A create from the app window still stages setup itself.
  if (
    !runtime ||
    (startup && hasDefaultTabs) ||
    (!startup && (args.provisionedByHost || !canSpawnSetupWithoutStartup))
  ) {
    return { didSpawnSetup: false }
  }

  let warning: string | undefined
  let startupTerminalHandle: string | null = null
  let startupTerminal: CreateWorktreeResult['startupTerminal']

  let sequencedStartup = startup
  let wrappedSetupCommandStr: string | undefined
  if (startup && setup?.waitForAgentStartup === true) {
    const platform = getSetupRunnerCommandPlatformForLaunch(
      setup,
      process.platform === 'win32' ? 'windows' : 'posix'
    )
    const sequenced = createSequencedSetupAgentCommands({
      runnerScriptPath: setup.runnerScriptPath,
      startupCommand: startup.command,
      platform,
      shell: setup.shell
    })
    sequencedStartup = {
      ...startup,
      command: sequenced.startupCommand,
      ...(sequenced.startupEnv ? { env: { ...startup.env, ...sequenced.startupEnv } } : {})
    }
    wrappedSetupCommandStr = sequenced.setupCommand
  }

  try {
    if (startup && sequencedStartup) {
      // Why: only after `git worktree add` + metadata registration is the path safe for a runtime PTY to boot the agent while setup runs alongside.
      const terminal = await runtime.createTerminal(
        `id:${worktree.id}`,
        {
          command: sequencedStartup.command,
          ...(setup ? { claudeAgentTeamsSourceCommand: startup.command } : {}),
          env: sequencedStartup.env,
          ...(sequencedStartup.launchConfig ? { launchConfig: sequencedStartup.launchConfig } : {}),
          ...(isTuiAgent(createdWithAgent) ? { launchAgent: createdWithAgent } : {}),
          ...(sequencedStartup.viewMode ? { viewMode: sequencedStartup.viewMode } : {}),
          startupCommandDelivery: sequencedStartup.startupCommandDelivery,
          telemetry: sequencedStartup.telemetry,
          // Why: the submitting renderer decides whether to open the workspace; activating here yanked users who moved on (#9944).
          surfaceOwner: false
        },
        worktree
      )
      startupTerminalHandle = terminal.handle
      startupTerminal = {
        spawned: true,
        surface: terminal.surface
      }
    } else if (setup && !hasDefaultTabs) {
      // Why: blank worktree creates normally seed this first shell in the renderer; spawning it here keeps setup status under host observation.
      // Why no creation evidence here: this shell is the blank create's first terminal, seeded
      // from the renderer side, so it is not attributed to a host worktree materialization.
      const terminal = await runtime.createTerminal(`id:${worktree.id}`, { activate: true })
      startupTerminalHandle = terminal.handle
      startupTerminal = { spawned: true, surface: terminal.surface }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warning = `Failed to create the startup terminal for ${worktree.path}: ${message}`
    console.warn(`[worktree-create] ${warning}`)
    return { didSpawnSetup: false, warning }
  }

  let didSpawnSetup = false
  if (setup) {
    try {
      // Why: the desktop create spawns Setup itself, so this is the only place
      // that can tell the sidebar a script (not an agent) is working here. The
      // sequenced variant already wraps the runner and is left unobserved.
      const completionToken = wrappedSetupCommandStr ? null : randomUUID()
      const observed = completionToken
        ? buildObservedSetupCommand(
            setup.runnerScriptPath,
            getSetupRunnerCommandPlatformForLaunch(
              setup,
              process.platform === 'win32' ? 'windows' : 'posix'
            ),
            completionToken,
            setup.shell
          )
        : null
      const setupCommand =
        wrappedSetupCommandStr ??
        observed?.command ??
        buildSetupRunnerCommand(
          setup.runnerScriptPath,
          getSetupRunnerCommandPlatformForLaunch(
            setup,
            process.platform === 'win32' ? 'windows' : 'posix'
          ),
          setup.shell
        )
      const setupEnv = { ...setup.envVars, ...observed?.env }
      let setupTerminalHandle: string | undefined
      setupTerminalHandle = (
        await runtime.createTerminal(
          `id:${worktree.id}`,
          {
            title: runtime.getSetupTerminalTitle(),
            command: setupCommand,
            env: setupEnv,
            activate: false,
            surfaceOwner: false
          },
          worktree
        )
      ).handle
      // Why before arming: an observation failure must not make a spawned runner
      // look like a failed spawn and send the renderer off to re-queue setup.
      didSpawnSetup = true
      if (completionToken && setupTerminalHandle) {
        runtime.armWorktreeSetupRunner(setupTerminalHandle, worktree.id, completionToken)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const nextWarning = `failed to create the setup terminal for ${worktree.path}: ${message}`
      warning = appendWorktreeCreateWarning(warning, nextWarning)
      console.warn(`[worktree-create] ${warning}`)
    }
  }

  return {
    ...(setup && !didSpawnSetup
      ? {
          activationSetup: {
            ...setup,
            ...(startupTerminalHandle && wrappedSetupCommandStr
              ? { command: wrappedSetupCommandStr }
              : {})
          }
        }
      : {}),
    ...(startupTerminal ? { startupTerminal } : {}),
    didSpawnSetup,
    ...(warning ? { warning } : {})
  }
}

async function resolveCreateBranchName(
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: BranchPrefixSettings,
  username: string | null,
  gitOptions: { wslDistro?: string } = {}
): Promise<string> {
  if (!branchNameOverride) {
    return computeValidatedBranchName(sanitizedName, settings, username)
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await gitExecFileAsync(['check-ref-format', '--branch', branchNameOverride], {
    cwd: repoPath,
    ...gitOptions
  })
  return branchNameOverride
}

function normalizeLocalBranchName(branchName: string | undefined): string {
  return branchName?.replace(/^refs\/heads\//, '') ?? ''
}

async function canCheckoutExistingLocalBranch(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  gitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  let localHead = ''
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      {
        cwd: repoPath,
        ...gitOptions
      }
    )
    localHead = stdout.trim()
  } catch {
    return false
  }
  if (normalizeLocalBranchName(baseBranch) !== branchName) {
    if (!localHead) {
      return false
    }
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`],
        { cwd: repoPath, ...gitOptions }
      )
      if (stdout.trim() !== localHead) {
        return false
      }
    } catch {
      return false
    }
  }
  const worktrees = await listWorktrees(repoPath, gitOptions)
  return !worktrees.some((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
}

function hasLocalGitOptions(gitOptions: LocalGitExecOptions): boolean {
  return Object.keys(gitOptions).length > 0
}

function getLocalGitHubPrForBranch(
  repoPath: string,
  branchName: string,
  gitOptions: LocalGitExecOptions
): ReturnType<typeof getPRForBranch> {
  return hasLocalGitOptions(gitOptions)
    ? getPRForBranch(repoPath, branchName, null, null, null, { localGitExecOptions: gitOptions })
    : getPRForBranch(repoPath, branchName)
}

type SelectedReviewBranchInput = Pick<
  CreateWorktreeArgs,
  | 'branchNameOverride'
  | 'linkedPR'
  | 'linkedGitLabMR'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'
  | 'pushTarget'
>

type SelectedReviewBranch = {
  provider: ForgeProviderId
  number: number
}

function getSelectedReviewBranch(args: SelectedReviewBranchInput): SelectedReviewBranch | null {
  if (typeof args.linkedPR === 'number') {
    return { provider: 'github', number: args.linkedPR }
  }
  if (typeof args.linkedGitLabMR === 'number') {
    return { provider: 'gitlab', number: args.linkedGitLabMR }
  }
  if (typeof args.linkedBitbucketPR === 'number') {
    return { provider: 'bitbucket', number: args.linkedBitbucketPR }
  }
  if (typeof args.linkedAzureDevOpsPR === 'number') {
    return { provider: 'azure-devops', number: args.linkedAzureDevOpsPR }
  }
  if (typeof args.linkedGiteaPR === 'number') {
    return { provider: 'gitea', number: args.linkedGiteaPR }
  }
  return null
}

function isSelectedGitHubPrBranchOverride(
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return typeof args.linkedPR === 'number' && args.branchNameOverride === branchName
}

function isSelectedReviewBranchOverride(
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return getSelectedReviewBranch(args) !== null && args.branchNameOverride === branchName
}

function isMatchingSelectedGitHubPr(
  existingPR: Awaited<ReturnType<typeof getPRForBranch>>,
  args: SelectedReviewBranchInput,
  branchName: string
): boolean {
  return Boolean(
    existingPR &&
    isSelectedGitHubPrBranchOverride(args, branchName) &&
    existingPR.number === args.linkedPR
  )
}

function isAllowedPushTargetRemoteConflict(
  conflictKind: 'local' | 'remote' | null,
  branchName: string,
  args: SelectedReviewBranchInput
): boolean {
  return (
    conflictKind === 'remote' &&
    isSelectedReviewBranchOverride(args, branchName) &&
    args.pushTarget?.branchName === branchName
  )
}

function getSelectedReviewLookupHints(args: SelectedReviewBranchInput): {
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
} {
  return {
    linkedGitHubPR: args.linkedPR ?? null,
    linkedGitLabMR: args.linkedGitLabMR ?? null,
    linkedBitbucketPR: args.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: args.linkedGiteaPR ?? null
  }
}

async function getSelectedHostedReviewForBranch(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>,
  branchName: string,
  args: SelectedReviewBranchInput
): Promise<{ matchesSelected: boolean; number: number } | null> {
  const selectedReview = getSelectedReviewBranch(args)
  if (!selectedReview) {
    return null
  }
  const review = await getHostedReviewForBranch({
    repoPath: repo.path,
    executionHostId: getStoredRepoExecutionHostId(repo),
    branch: branchName,
    ...getSelectedReviewLookupHints(args)
  })
  if (!review) {
    return null
  }
  return {
    matchesSelected:
      review.provider === selectedReview.provider && review.number === selectedReview.number,
    number: review.number
  }
}

export async function prepareWorktreePushTarget(
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore | null,
  repoId?: string,
  gitOptions: { wslDistro?: string } = {},
  // Ownership evidence comes only from the host this git runs on.
  hostId?: ExecutionHostId
): Promise<GitPushTarget> {
  await validateGitPushTarget(repoPath, target, gitOptions)
  const prepared = await prepareWorktreePushTargetWithExec(
    // Bound only network fetch; local remote/config probes retain normal untimed behavior.
    (args, cwd) =>
      gitExecFileAsync(args, {
        cwd,
        ...gitOptions,
        ...(args[0] === 'fetch' ? { timeout: DEFERRED_PUSH_TARGET_FETCH_TIMEOUT_MS } : {})
      }),
    repoPath,
    target,
    (existingRemote) =>
      store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            { ...target, remoteName: existingRemote },
            repoId,
            hostId
          )
        : false
  )
  // Narrow legacy fork remotes opportunistically without adding migration latency to creation.
  if (store && repoId) {
    void migrateForkRemoteRefspecs(repoPath, repoId, store, gitOptions)
  }
  return prepared
}

/** Carry the proven Git execution host; worktree ID alone cannot distinguish host twins. */
export function ipcGitWorktreeTarget(args: {
  worktreeId?: string
  connectionId?: string
}): HostWorktreeTarget | undefined {
  return args.worktreeId
    ? hostWorktreeTarget({
        id: args.worktreeId,
        hostId: getConnectionExecutionHostId(args.connectionId)
      })
    : undefined
}

export async function materializeWorktreePushTargetRemote(
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore | null,
  repoId?: string,
  gitOptions: { wslDistro?: string } = {},
  worktree?: HostWorktreeTarget
): Promise<GitPushTarget> {
  if (!target.remoteUrl || target.remoteCreated) {
    return target
  }
  const execGit: GitRemoteExec = (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions })
  if (await remoteAlreadyMatchesUrl(execGit, repoPath, target.remoteName, target.remoteUrl)) {
    return runForkRemoteAdoption(repoPath, target, () =>
      adoptExistingForkRemoteForBranch(
        execGit,
        repoPath,
        target,
        gitOptions,
        store,
        repoId,
        worktree
      )
    )
  }
  const key = worktreePushTargetMaterializeKey(repoPath, target.remoteName)
  const existing = worktreePushTargetMaterializeInflight.get(key)
  if (existing) {
    // Join the remote mint, then adopt this caller's branch; failed mints roll back, so propagate rather than writing ghost config.
    await existing
    return runForkRemoteAdoption(repoPath, target, () =>
      adoptExistingForkRemoteForBranch(
        execGit,
        repoPath,
        target,
        gitOptions,
        store,
        repoId,
        worktree
      )
    )
  }
  const promise = prepareWorktreePushTarget(
    repoPath,
    target,
    store,
    repoId,
    gitOptions,
    worktree?.hostId
  )
    .then((prepared) => restoreUpstreamAfterMaterialize(execGit, repoPath, prepared))
    .then((prepared) => {
      persistMaterializedPushTargetIfCreated(store, worktree, prepared)
      return prepared
    })
    .finally(() => {
      if (worktreePushTargetMaterializeInflight.get(key) === promise) {
        worktreePushTargetMaterializeInflight.delete(key)
      }
    })
  worktreePushTargetMaterializeInflight.set(key, promise)
  return promise
}

// Remote reuse still needs this branch's refspec, tracking ref and upstream, including after the initial materialization.
async function adoptExistingForkRemoteForBranch(
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget,
  gitOptions: { wslDistro?: string },
  store: WorktreePushTargetStore | null | undefined,
  repoId: string | undefined,
  worktree: HostWorktreeTarget | undefined
): Promise<GitPushTarget> {
  await ensureRemoteTracksBranchNarrowly(execGit, repoPath, target.remoteName, target.branchName)
  // Config widening imports no refs; fetch missing tracking refs before upstream assignment while repeat calls stay local.
  if (
    !(await forkRemoteTrackingRefExists(execGit, repoPath, target.remoteName, target.branchName))
  ) {
    // Bound this network fetch like the full-mint path.
    await gitExecFileAsync(
      [
        'fetch',
        target.remoteName,
        buildNarrowForkFetchRefspec(target.remoteName, target.branchName)
      ],
      { cwd: repoPath, ...gitOptions, timeout: DEFERRED_PUSH_TARGET_FETCH_TIMEOUT_MS }
    )
  }
  const restored = await restoreUpstreamAfterMaterialize(execGit, repoPath, target)
  // Persist inherited Orca ownership for orphan cleanup; derive repo ID because IPC and runtime callers supply different context.
  const ownerRepoId = repoId ?? (worktree ? getRepoIdFromWorktreeId(worktree.id) : undefined)
  const owned =
    store !== undefined &&
    ownerRepoId !== undefined &&
    // SAFETY: Legacy null keeps this branch's original failure rather than introducing a fallback.
    isPushTargetRemoteCreatedByKnownWorktree(store!, restored, ownerRepoId, worktree?.hostId)
  const adopted = owned ? { ...restored, remoteCreated: true } : restored
  persistMaterializedPushTargetIfCreated(store, worktree, adopted)
  return adopted
}

// Serialize per-remote adoption: concurrent git config writes can fail locks or duplicate refspecs.
const forkRemoteAdoptionQueue = new Map<string, Promise<unknown>>()

function runForkRemoteAdoption<T>(
  repoPath: string,
  target: GitPushTarget,
  run: () => Promise<T>
): Promise<T> {
  const key = worktreePushTargetMaterializeKey(repoPath, target.remoteName)
  const previous = forkRemoteAdoptionQueue.get(key)
  const next = previous ? previous.then(run, run) : run()
  const settled = next.then(
    () => undefined,
    () => undefined
  )
  forkRemoteAdoptionQueue.set(key, settled)
  void settled.finally(() => {
    if (forkRemoteAdoptionQueue.get(key) === settled) {
      forkRemoteAdoptionQueue.delete(key)
    }
  })
  return next
}

// Deferred creation bypasses create-time metadata writes; persist ownership for orphan cleanup and older SSH hosts.
function persistMaterializedPushTargetIfCreated(
  store: WorktreePushTargetStore | null | undefined,
  worktree: HostWorktreeTarget | undefined,
  target: GitPushTarget
): void {
  if (!target.remoteCreated || !worktree || !store?.setWorktreeMeta) {
    return
  }
  const repoId = getRepoIdFromWorktreeId(worktree.id)
  const repos = store.getRepos?.()
  // A copy whose repo this host no longer has gets no new row.
  if (
    repos &&
    !repos.some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === worktree.hostId)
  ) {
    return
  }
  // Bookkeeping incidental to the push: a project a WSL move is taking skips it, not the push.
  if (isWslMoveWorktreeBlocked(worktree.id, worktree.hostId)) {
    return
  }
  store.setWorktreeMeta(worktree, { pushTarget: target })
}

function isPushTargetRemoteCreatedByKnownWorktree(
  store: WorktreePushTargetStore,
  target: GitPushTarget,
  repoId?: string,
  // A same-id twin's remote on another host proves nothing about this host's remote.
  hostId?: ExecutionHostId
): boolean {
  const rows = hostId ? readAllWorktreeMetaForHost(store, hostId) : store.getAllWorktreeMeta()
  return Object.entries(rows).some(([worktreeId, meta]) => {
    if (repoId && getRepoIdFromWorktreeId(worktreeId) !== repoId) {
      return false
    }
    if (!meta.pushTarget?.remoteCreated) {
      return false
    }
    const otherRemoteUrl = meta.pushTarget.remoteUrl
    const targetRemoteUrl = target.remoteUrl
    return (
      meta.pushTarget.remoteName === target.remoteName ||
      (typeof otherRemoteUrl === 'string' &&
        typeof targetRemoteUrl === 'string' &&
        sameGitHubRemoteUrl(otherRemoteUrl, targetRemoteUrl))
    )
  })
}

export async function cleanupUnusedWorktreePushTargetRemote(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore,
  gitOptions: { wslDistro?: string } = {}
): Promise<void> {
  try {
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      repoPath,
      removedWorktreeId,
      target,
      store,
      (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions })
    )
  } catch (error) {
    console.warn(`[worktrees] Failed to clean up fork PR remote for ${removedWorktreeId}`, error)
  }
  // Reclaim legacy/external-removal leaks asynchronously; per-repo rate limits bound subprocess cost.
  void reconcileOrphanedPrRemotes(
    repoPath,
    getRepoIdFromWorktreeId(removedWorktreeId),
    store,
    gitOptions
  )
}

export async function configureCreatedWorktreePushTarget(
  worktreePath: string,
  branchName: string,
  target: GitPushTarget,
  gitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {}
): Promise<GitPushTarget> {
  return configureCreatedWorktreePushTargetWithExec(
    (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
    worktreePath,
    branchName,
    target
  )
}

export function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  // Invalidate before notifying so observer list requests see the changed catalog.
  runWorktreeChangeInvalidators(repoId)
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}

export function notifyWorktreeGitStatusMetadataChanged(
  mainWindow: BrowserWindow,
  repoId: string,
  worktreePaths: readonly string[] | null = null
): void {
  // Index churn refreshes Source Control only; it must not mutate structural caches or runtime/mobile graphs.
  if (!mainWindow.isDestroyed()) {
    const payload: GitStatusMetadataChangedEvent = worktreePaths
      ? { repoId, worktreePaths: [...worktreePaths] }
      : { repoId }
    mainWindow.webContents.send('worktrees:gitStatusMetadataChanged', payload)
  }
}

export function notifyWorktreeHeadIdentitiesChanged(
  mainWindow: BrowserWindow,
  repoId: string,
  identities: WorktreeHeadIdentity[]
): void {
  // Background workspaces lack active status refresh; publish head moves through targeted events.
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:headIdentitiesChanged', { repoId, identities })
  }
}

// Report fetching/creating separately; checkout carries Git progress and null marks completion.
export function emitCreateWorktreeProgress(
  mainWindow: BrowserWindow,
  phase: 'fetching' | 'creating',
  creationId?: string,
  detail?: Pick<CreateWorktreeProgressEvent, 'checkout' | 'worktreeId'>
): void {
  if (!mainWindow.isDestroyed()) {
    const event: CreateWorktreeProgressEvent = { creationId, phase, ...detail }
    mainWindow.webContents.send('createWorktree:progress', event)
  }
}

export function createLocalWorktree(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow,
  runtime: OrcaRuntimeService,
  timing: WorktreeCreateTimingRecorder = createWorktreeCreateTimingRecorder(),
  onWorkspaceCreated?: (worktreeId: string) => void
): Promise<CreateWorktreeResult> {
  // Always rearm consumed preparation, even if later copy, metadata or startup work fails.
  const rearm: PreparationRearmHolder = { fire: () => {} }
  return worktreeCreateGit
    .run(() =>
      performLocalWorktreeCreate(
        args,
        repo,
        store,
        mainWindow,
        rearm,
        timing,
        runtime,
        onWorkspaceCreated
      )
    )
    .finally(() => {
      // Finish create timing before rearm so replacement preparation is not charged to this request.
      timing.finish()
      rearm.fire()
    })
}

/**
 * Whether `worktreePath` is already on disk, for name allocation. Same answer `existsSync` gave — any
 * error means absent — asked off the main thread so a stalled repo volume cannot freeze the app.
 */
async function worktreePathTaken(worktreePath: string): Promise<boolean> {
  try {
    await stat(worktreePath)
    return true
  } catch {
    return false
  }
}

async function performLocalWorktreeCreate(
  args: CreateWorktreeArgsWithSystemProvenance,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow,
  rearm: PreparationRearmHolder,
  timing: WorktreeCreateTimingRecorder,
  runtime: OrcaRuntimeService,
  onWorkspaceCreated?: (worktreeId: string) => void
): Promise<CreateWorktreeResult> {
  const settings = store.getSettings()
  const worktreePathSettings = getWorktreePathSettings(
    repo,
    settings,
    getWorktreeMirrorDistro(store, repo)
  )
  const localGitExecOptions = getLocalProjectGitExecOptions(store, repo)
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  // Why: the branch→PR collision probes are gh calls; run them as the repo's pinned account.
  const localGhExecOptions = getLocalProjectGhExecOptions(store, repo)
  timing.recordExecutionHost(localWorktreeCreateExecutionHost(localGitExecOptions))
  const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
  const localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }] = hasLocalWorktreeGitOptions
    ? [localWorktreeGitOptions]
    : []
  const creationId = args.creationId
  const addProjectGitOptions = (options?: AddWorktreeOptions): AddWorktreeOptions => ({
    ...options,
    ...localWorktreeGitOptions,
    ...(creationId
      ? {
          onCheckoutProgress: (checkout: WorktreeCheckoutProgress | null) =>
            emitCreateWorktreeProgress(mainWindow, 'creating', creationId, { checkout })
        }
      : {})
  })

  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  const displayNameRequest = resolveWorktreeCreateDisplayNameRequest(
    args.displayName,
    args.displayNameKind,
    args.name,
    args.cliProvenance?.kind === 'created-by-cli',
    args.nameWasGenerated === true
  )
  const requestedDisplayName = displayNameRequest.value
  // Resolve username only for generated username-prefixed branches; overlap its independent probe with base resolution.
  const usernamePromise =
    !args.branchNameOverride && settings.branchPrefix === 'git-username'
      ? resolveLocalGitUsername(repo.path, repo.ghAccount)
      : Promise.resolve('')
  const baseBranchPromise = resolveWorktreeCreateBase({
    requestedBaseBranch: args.baseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () => resolveDefaultBaseRefWithLocalGit(localGitExecOptions),
    isBaseUsable: async (baseBranchCandidate) => {
      if (runtime) {
        const remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
          repo.path,
          baseBranchCandidate,
          ...localWorktreeGitOptionArgs
        )
        if (remoteTrackingBase) {
          if (
            await runtime.hasRemoteTrackingRef(
              repo.path,
              remoteTrackingBase,
              ...localWorktreeGitOptionArgs
            )
          ) {
            return true
          }
          return hasLocalWorktreeBaseRef(repo.path, baseBranchCandidate, localGitExecOptions)
        }
      }
      return hasLocalWorktreeBaseRef(repo.path, baseBranchCandidate, localGitExecOptions)
    }
  })
  const [username, resolvedBaseBranch] = await Promise.all([usernamePromise, baseBranchPromise])
  let baseBranch = resolvedBaseBranch
  if (!baseBranch) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }

  let remoteTrackingBase: RemoteTrackingBase | null = null
  let baseFallback: WorktreeCreateBaseFallback | undefined
  let remoteTrackingRefresh: {
    base: RemoteTrackingBase
    hadLocalBaseRef: boolean
    promise: Promise<RemoteFetchResult>
  } | null = null
  let legacyFetchPromise: Promise<void> | null = null

  if (runtime) {
    remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
      repo.path,
      baseBranch,
      ...localWorktreeGitOptionArgs
    )
    if (remoteTrackingBase) {
      const [hasRemoteTrackingBaseRef, hasNamedLocalBaseRef] = await Promise.all([
        runtime.hasRemoteTrackingRef(repo.path, remoteTrackingBase, ...localWorktreeGitOptionArgs),
        hasLocalWorktreeBaseRef(repo.path, baseBranch, localGitExecOptions)
      ])
      const hasFallbackLocalBaseRef =
        !hasNamedLocalBaseRef &&
        (await hasLocalWorktreeBaseRef(repo.path, remoteTrackingBase.branch, localGitExecOptions))
      const hasLocalBaseRef =
        hasRemoteTrackingBaseRef || hasNamedLocalBaseRef || hasFallbackLocalBaseRef
      if (!hasRemoteTrackingBaseRef && hasLocalBaseRef) {
        // Offline creation can still use a local base when tracking refresh fails.
        if (hasFallbackLocalBaseRef) {
          baseBranch = remoteTrackingBase.branch
        }
        baseFallback = {
          requestedRef: remoteTrackingBase.base,
          localRef: baseBranch
        }
        remoteTrackingBase = null
      } else {
        emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
        remoteTrackingRefresh = {
          base: remoteTrackingBase,
          hadLocalBaseRef: hasRemoteTrackingBaseRef,
          promise: runtime.getOrStartRemoteTrackingBaseRefresh(
            repo.path,
            remoteTrackingBase,
            ...localWorktreeGitOptionArgs
          )
        }
      }
    } else if (!(await hasLocalWorktreeBaseRef(repo.path, baseBranch, localGitExecOptions))) {
      // Local bases retain best-effort origin refresh; verified review SHAs already have their objects.
      legacyFetchPromise = runtime
        .fetchRemoteWithCache(repo.path, 'origin', ...localWorktreeGitOptionArgs)
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  } else {
    if (!(await hasLocalWorktreeBaseRef(repo.path, baseBranch, localGitExecOptions))) {
      legacyFetchPromise = gitExecFileAsync(['fetch', 'origin'], {
        ...localGitExecOptions,
        timeout: CREATE_BASE_FALLBACK_FETCH_TIMEOUT_MS
      })
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching', args.creationId)
    }
  }
  const workspaceRoot = await computeWorkspaceRootAsync(repo.path, worktreePathSettings)

  // Hook validation is ref-independent and can overlap required tracking-base refresh.
  const primarySetupScript = getEffectiveHooks(repo)?.scripts.setup
  if (primarySetupScript) {
    shouldRunSetupForCreate(repo, args.setupDecision)
  }
  const sparseDirectories = args.sparseCheckout
    ? normalizeSparseDirectories(args.sparseCheckout.directories)
    : []
  if (args.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  const sparsePresetId = attributedSparsePresetId(
    () => store.getSparsePresets(repo.id),
    repo.id,
    args.sparseCheckout?.presetId,
    sparseDirectories
  )

  let effectiveRequestedName = requestedName
  let effectiveSanitizedName = sanitizedName
  let branchName = ''
  let worktreePath = ''

  if (args.exactBranchName && !args.branchNameOverride) {
    // Why: "keep this branch" only means something with a branch to keep; refuse rather than
    // invent one from the worktree name.
    throw new Error('An exact-branch create needs the branch it must keep.')
  }
  const branchConflictSubject = args.branchNameOverride ? 'branch name' : 'worktree name'
  let resolved = false
  let checkoutExistingBranch = false
  let selectedExistingLocalBranchName: string | null = null
  let selectedRemoteBranchName: string | null = null
  let lastBranchConflictKind: 'local' | 'remote' | null = null
  let lastExistingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
  let lastExistingReviewNumber: number | null = null
  const shouldRetireGeneratedName =
    args.nameWasGenerated === true && isGeneratedWorktreeCreateName(sanitizedName)
  if (
    args.branchIntent === 'open-existing' &&
    args.branchNameOverride &&
    !args.pushTarget &&
    getSelectedReviewBranch(args) === null
  ) {
    branchName = await resolveCreateBranchName(
      repo.path,
      args.branchNameOverride,
      sanitizedName,
      settings,
      username,
      localWorktreeGitOptions
    )
    const conflict = await getBranchConflictKind(
      repo.path,
      branchName,
      baseBranch,
      localWorktreeGitOptions
    )
    if (conflict === null) {
      selectedRemoteBranchName = branchName
    }
  }
  const pathIsAvailable = async (): Promise<boolean> => {
    worktreePath = ensurePathWithinWorkspace(
      computeWorktreePath(effectiveSanitizedName, repo.path, worktreePathSettings, workspaceRoot),
      workspaceRoot
    )
    // Pending removals still own paths Git may already have deleted; skip them until teardown settles.
    return (
      !(await worktreePathTaken(worktreePath)) &&
      !findPendingWorktreeRemovalConflict(repo.path, { worktreePath })
    )
  }
  await timing.time('resolve_name', async () => {
    const retiredNameRegistry = shouldRetireGeneratedName
      ? await getRetiredNameRegistryForRepo(store, repo, store.getRepos(), settings)
      : null
    const isRetiredName = retiredNameRegistry ? createRetiredNameLookup(retiredNameRegistry) : null
    // Existing review branches need matching branch/path suffixes rather than blocking creation.
    for (
      let suffix = 1, attempts = 0;
      attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS;
      suffix += 1
    ) {
      effectiveSanitizedName = shouldRetireGeneratedName
        ? getGeneratedWorktreeCreateCandidate(
            sanitizedName,
            suffix,
            retiredNameRegistry?.exhaustedTiers
          )
        : getWorktreeCreateCandidate(sanitizedName, suffix)
      effectiveRequestedName = shouldRetireGeneratedName
        ? effectiveSanitizedName
        : requestedName.trim()
          ? getWorktreeCreateCandidate(requestedName, suffix)
          : effectiveSanitizedName
      if (isRetiredName?.(effectiveSanitizedName)) {
        continue
      }
      attempts += 1
      if (selectedRemoteBranchName) {
        if (await pathIsAvailable()) {
          resolved = true
          break
        }
        continue
      }
      lastExistingReviewNumber = null

      branchName = await resolveCreateBranchName(
        repo.path,
        selectedExistingLocalBranchName
          ? selectedExistingLocalBranchName
          : getBranchNameOverrideCandidate(
              args.branchNameOverride,
              // Why: an exact branch keeps its name; only the worktree directory may take the suffix.
              args.exactBranchName ? 1 : suffix
            ),
        effectiveSanitizedName,
        settings,
        username,
        localWorktreeGitOptions
      )
      const tryExistingBranch = async (): Promise<boolean> => {
        checkoutExistingBranch = await canCheckoutExistingLocalBranch(
          repo.path,
          branchName,
          baseBranch,
          localWorktreeGitOptions
        )
        return checkoutExistingBranch
      }
      // Explicit branch selections retain the adoption-first path.
      const preferExistingBranch = Boolean(
        args.branchNameOverride || selectedExistingLocalBranchName
      )
      checkoutExistingBranch = preferExistingBranch && (await tryExistingBranch())
      lastBranchConflictKind = checkoutExistingBranch
        ? null
        : await getBranchConflictKind(
            repo.path,
            branchName,
            baseBranch,
            localWorktreeGitOptions,
            preferExistingBranch ? undefined : tryExistingBranch
          )
      if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
        // Path retries must retain the adopted branch.
        selectedExistingLocalBranchName = branchName
      }
      const allowedPushTargetRemoteConflict =
        lastBranchConflictKind &&
        isAllowedPushTargetRemoteConflict(lastBranchConflictKind, branchName, args)
      if (lastBranchConflictKind) {
        if (allowedPushTargetRemoteConflict) {
          lastExistingPR = null
          let lookupFailed = false
          const selectedReview = getSelectedReviewBranch(args)
          if (selectedReview?.provider === 'github') {
            try {
              lastExistingPR = await getLocalGitHubPrForBranch(
                repo.path,
                branchName,
                localGhExecOptions
              )
            } catch {
              lookupFailed = true
            }
            if (!lookupFailed && isMatchingSelectedGitHubPr(lastExistingPR, args, branchName)) {
              lastBranchConflictKind = null
            } else if (lastExistingPR) {
              lastExistingReviewNumber = lastExistingPR.number
            }
          } else if (selectedReview) {
            let hostedReview: Awaited<ReturnType<typeof getSelectedHostedReviewForBranch>> = null
            try {
              hostedReview = await getSelectedHostedReviewForBranch(repo, branchName, args)
            } catch {
              lookupFailed = true
            }
            if (!lookupFailed && hostedReview?.matchesSelected) {
              lastBranchConflictKind = null
            } else if (hostedReview) {
              lastExistingReviewNumber = hostedReview.number
            }
          }
        }
      }
      if (lastBranchConflictKind) {
        if (args.exactBranchName) {
          // Why: a copied workspace must land on its own branch; Orca's retry would otherwise
          // publish the wrong branch under a suffixed name.
          throw new WorktreeCreateCollisionError(
            `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}, and this workspace keeps its branch name.`
          )
        }
        continue
      }

      // Why: gh pr list is a ~1–3s network call; only probe PR conflicts after a branch collision (suffix > 1) so the common no-collision path skips it.
      // An exact-branch copy keeps its branch, so the PR on that branch belongs to the workspace
      // being copied and must not send the loop hunting for a free branch.
      if (suffix > 1 && !checkoutExistingBranch && !args.exactBranchName) {
        lastExistingPR = null
        try {
          lastExistingPR = await getLocalGitHubPrForBranch(
            repo.path,
            branchName,
            localGhExecOptions
          )
        } catch {
          // GitHub API may be unreachable, rate-limited, or token missing
        }
        if (lastExistingPR && !isMatchingSelectedGitHubPr(lastExistingPR, args, branchName)) {
          lastExistingReviewNumber = lastExistingPR.number
          continue
        }
      }

      if (!(await pathIsAvailable())) {
        continue
      }

      resolved = true
      break
    }
  })

  if (!resolved) {
    // Snapshot callback-assigned review state for narrowing and report collision exhaustion precisely.
    const existingReviewNumber = lastExistingReviewNumber
    if (existingReviewNumber !== null) {
      throw new WorktreeCreateCollisionError(
        `Branch "${branchName}" already has PR #${String(existingReviewNumber)}. Pick a different ${branchConflictSubject}.`
      )
    }
    if (lastBranchConflictKind) {
      throw new WorktreeCreateCollisionError(
        `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different ${branchConflictSubject}.`
      )
    }
    throw new Error(
      `Could not find an available worktree name for "${sanitizedName}". Pick a different worktree name.`
    )
  }

  assertAttachableParentWorkspace(
    store,
    args.parentWorkspace,
    worktreeWorkspaceKey(`${repo.id}::${worktreePath}`)
  )

  if (remoteTrackingRefresh) {
    await timing.time('refresh_base_ref', async () => {
      const result = await remoteTrackingRefresh.promise
      if (!result.ok && !remoteTrackingRefresh.hadLocalBaseRef) {
        throw new Error(
          `Could not refresh base ref "${baseBranch}" from "${remoteTrackingRefresh.base.remote}". Check your network and try again.`
        )
      }
      if (
        !remoteTrackingRefresh.hadLocalBaseRef &&
        !(await runtime?.hasRemoteTrackingRef(
          repo.path,
          remoteTrackingRefresh.base,
          ...localWorktreeGitOptionArgs
        ))
      ) {
        throw new Error(`Base ref "${baseBranch}" was not found after fetching.`)
      }
    })
  }

  if (legacyFetchPromise) {
    await timing.time('refresh_base_ref', async () => {
      await legacyFetchPromise
    })
  }
  // Why: the catalog watcher can publish the checkout mid-create; the renderer must not seed it a shell yet.
  emitCreateWorktreeProgress(mainWindow, 'creating', args.creationId, {
    worktreeId: composeWorktreeId(repo.id, worktreePath)
  })

  // Defer fork remote creation/fetch until first synchronization; read-only review creation needs neither.
  const preparedPushTarget: GitPushTarget | undefined = args.pushTarget

  const suggestLocalBaseRefUpdate =
    !settings.refreshLocalBaseRefOnWorktreeCreate &&
    !settings.localBaseRefSuggestionDismissed &&
    Boolean(remoteTrackingBase)
  const remoteTrackingBaseOption = remoteTrackingBase ? { remoteTrackingBase } : undefined
  const existingBranchOption = {
    checkoutExistingBranch,
    ...remoteTrackingBaseOption,
    ...(suggestLocalBaseRefUpdate ? { suggestLocalBaseRefUpdate } : {})
  }
  const preparedWorktreeOptions = addProjectGitOptions(
    suggestLocalBaseRefUpdate
      ? { ...remoteTrackingBaseOption, suggestLocalBaseRefUpdate }
      : remoteTrackingBaseOption
  )
  let addResult: AddWorktreeResult
  try {
    addResult =
      (await timing.time('git_worktree_add', async () => {
        if (sparseDirectories.length === 0 && !checkoutExistingBranch) {
          const prepared = await consumePreparedWorktreeCreate({
            repoPath: repo.path,
            workspaceRoot,
            worktreePath,
            branch: branchName,
            baseBranch,
            refreshLocalBaseRef: settings.refreshLocalBaseRefOnWorktreeCreate,
            options: preparedWorktreeOptions,
            timing
          })
          if (prepared.status === 'hit') {
            // Preparation rearm runs reset --hard; defer it so it cannot occupy admission during this create's Git work.
            rearm.fire = prepared.rearm
            return prepared.result
          }
          if (prepared.rearm) {
            rearm.fire = prepared.rearm
          }
        } else {
          timing.recordPreparedCheckout({
            status: 'miss',
            reason: sparseDirectories.length > 0 ? 'sparse_checkout' : 'checkout_existing_branch'
          })
        }
        if (sparseDirectories.length > 0) {
          if (checkoutExistingBranch) {
            return addSparseWorktree(
              repo.path,
              worktreePath,
              branchName,
              sparseDirectories,
              baseBranch,
              settings.refreshLocalBaseRefOnWorktreeCreate,
              addProjectGitOptions(existingBranchOption)
            )
          }
          return addSparseWorktree(
            repo.path,
            worktreePath,
            branchName,
            sparseDirectories,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            preparedWorktreeOptions
          )
        }

        if (checkoutExistingBranch) {
          return addWorktree(
            repo.path,
            worktreePath,
            branchName,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            false,
            addProjectGitOptions(existingBranchOption)
          )
        }
        return addWorktree(
          repo.path,
          worktreePath,
          branchName,
          baseBranch,
          settings.refreshLocalBaseRefOnWorktreeCreate,
          false,
          preparedWorktreeOptions
        )
      })) ?? {}
  } catch (error) {
    if (shouldRetireGeneratedName && failedWorktreeCreationNeedsRetirement(error)) {
      await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
    }
    throw error
  }
  // Creation makes the checkout listable; older detected scans must not publish or cache pre-create catalogs.
  runWorktreeChangeInvalidators(repo.id)

  // Retire the generated name before fallible metadata work can leave a real workspace name reusable.
  if (shouldRetireGeneratedName) {
    await retireGeneratedWorktreeName(store, repo, settings, effectiveSanitizedName)
  }

  // Upstream assignment needs an existing remote; fork remotes materialize later.
  let configuredPushTarget: GitPushTarget | undefined = preparedPushTarget
  if (preparedPushTarget && !preparedPushTarget.remoteUrl) {
    configuredPushTarget = await configureCreatedWorktreePushTarget(
      worktreePath,
      branchName,
      preparedPushTarget,
      localWorktreeGitOptions
    )
  }

  const {
    created,
    worktrees: gitWorktrees,
    listingComplete
  } = await timing.time('list_created_worktree', async () =>
    resolveCreatedWorktree(repo.path, worktreePath, branchName, localWorktreeGitOptions)
  )
  if (listingComplete) {
    timing.recordWorktreeCount(gitWorktrees.length)
  }

  const worktreeId = `${repo.id}::${created.path}`
  if (created.path !== worktreePath) {
    emitCreateWorktreeProgress(mainWindow, 'creating', args.creationId, { worktreeId })
  }
  const now = Date.now()
  // Review head SHA/ref seeds creation; Source Control comparison uses the review target branch.
  const metadataBaseRef = args.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  const metaUpdates: Partial<WorktreeMeta> = {
    // Path IDs can be reused after external deletion; rotate instance identity to reject stale lineage.
    instanceId: randomUUID(),
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    // Seed final activity ordering before scroll-to-reveal so later refresh cannot move the row.
    lastActivityAt: now,
    // createdAt protects the new worktree from ambient PTY bumps for CREATE_GRACE_MS.
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'desktop',
    creatorProvenance: { kind: 'host' },
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {}),
    baseRef: metadataBaseRef,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...resolveWorktreeCreateDisplayNameMeta(
      requestedDisplayName,
      branchName,
      displayNameRequest.kind,
      { requestedName: effectiveRequestedName, sanitizedName: effectiveSanitizedName }
    ),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: metadataBaseRef,
          sparsePresetId
        }
      : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename === true && isTuiAgent(args.createdWithAgent)
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedItems !== undefined ? { linkedItems: args.linkedItems } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const { worktree } = timing.timeSync('persist_metadata', () => {
    const meta = store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), metaUpdates)
    return { worktree: mergeWorktree(repo.id, created, meta) }
  })
  onWorkspaceCreated?.(worktreeId)
  const { lineage: worktreeLineage, workspaceLineage } = recordWorkspaceLineageForCreatedWorktree(
    store,
    args,
    worktree,
    now
  )
  // Reuse complete listing roots for authorization; incomplete recovery must not replace the repo's full root set.
  if (listingComplete) {
    registerWorktreeRootsForRepo(
      store,
      repo,
      [repo.path, ...gitWorktrees.map((worktree) => worktree.path)],
      localWorktreeGitOptions
    )
  } else {
    // Incomplete recovery authorizes only the created root until a complete listing repopulates the cache.
    registerCreatedWorktreeRoot(store, repo, created.path)
  }

  // Materialize configured shared paths before setup scripts need them.
  const symlinkPaths = repo.symlinkPaths ?? []
  if (symlinkPaths.length > 0) {
    await timing.time('create_symlinks', async () => {
      await createWorktreeLinkedPaths(repo.path, created.path, symlinkPaths)
    })
  }

  // Repo shared directories supplement user settings so teammates inherit project configuration (#10451).
  const [sharedDirectories, includePaths] = await Promise.all([
    timing.time('resolve_shared_directories', () =>
      resolveWorktreeSharedDirectories(repo.path, localWorktreeGitOptions)
    ),
    timing.time('resolve_worktreeinclude', () =>
      resolveWorktreeIncludePaths(repo.path, localWorktreeGitOptions)
    )
  ])
  let materializationWarning: string | undefined
  if (sharedDirectories.length > 0) {
    const failedSharedDirectories = await timing.time(
      'create_shared_directories',
      async () =>
        await createWorktreeSharedPaths(repo.path, created.path, sharedDirectories, {
          sharedDirectoriesMode: repo.sharedDirectoriesMode
        })
    )
    const sharedDirectoriesWarning = formatWorktreeSharedDirectoriesWarning(failedSharedDirectories)
    if (sharedDirectoriesWarning) {
      console.warn(`[worktree-shared-directories] ${sharedDirectoriesWarning}`)
      materializationWarning = sharedDirectoriesWarning
    }
  }

  // Why: project-level `.worktreeinclude` travels with the repo (issue #7549); copy semantics
  // (never symlink) so each worktree owns its files. Paths already linked above are skipped.
  if (includePaths.length > 0) {
    await timing.time('copy_worktreeinclude', async () => {
      const skippedIncludePaths = await createWorktreeCopiedPaths(
        repo.path,
        created.path,
        includePaths
      )
      const includeCopyWarning = formatWorktreeIncludeCopyWarning(skippedIncludePaths)
      if (includeCopyWarning) {
        console.warn(`[worktree-include] ${includeCopyWarning}`)
        materializationWarning = appendWorktreeCreateWarning(
          materializationWarning,
          includeCopyWarning
        )
      }
    })
  }

  // Created branch hooks are authoritative; benign divergence from primary must not disable setup (#1280).
  let setup: CreateWorktreeResult['setup']
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  await timing.time('prepare_setup', async () => {
    const createdYamlHooks = loadHooks(worktreePath)
    const createdEffectiveHooks = getEffectiveHooksFromConfig(repo, createdYamlHooks)
    try {
      defaultTabs = getDefaultTabsLaunch(createdYamlHooks, repo, args.setupDecision)
    } catch (error) {
      // Unapproved target-branch tab commands may create tabs but must not execute.
      console.warn(`[hooks] default tab commands skipped for ${worktreePath}:`, error)
      defaultTabs = createdYamlHooks?.defaultTabs
        ? { tabs: createdYamlHooks.defaultTabs, runCommands: false }
        : undefined
    }
    const setupScript = createdEffectiveHooks?.scripts.setup
    let shouldLaunchSetup = false
    if (setupScript) {
      try {
        shouldLaunchSetup = shouldRunSetupForCreate(repo, args.setupDecision)
      } catch (error) {
        // Target branch can add unseen hooks; skip unapproved setup without failing the existing workspace.
        console.warn(`[hooks] setup hook skipped for ${worktreePath}:`, error)
      }
    }
    if (setupScript && shouldLaunchSetup) {
      try {
        // Main generates setup scripts without executing them; generation failure leaves the created workspace usable.
        setup = createSetupRunnerScript(
          repo,
          worktreePath,
          setupScript,
          localWorktreeGitOptionArgs[0],
          resolveSetupRunnerShell(settings),
          createdYamlHooks?.setupAgentStartupPolicy
        )
      } catch (error) {
        console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
      }
    }
  })

  // Startup resolves the new id before lifecycle notifications invalidate runtime caches.
  runtime?.invalidateWorktreeCatalog?.(repo.id)
  const stagedStartup = await timing.time('spawn_startup_terminal', () =>
    spawnLocalStartupAndSetupTerminals({
      runtime,
      worktree,
      startup: args.startup,
      setup,
      defaultTabs,
      settings,
      createdWithAgent: args.createdWithAgent,
      provisionedByHost: Boolean(args.automationProvenance)
    })
  )

  // Automation terminals are host-provisioned, so return none for renderer launch.
  const provisionedByHost = Boolean(args.automationProvenance)
  if (provisionedByHost && (setup || defaultTabs?.tabs.length)) {
    void runtime.provisionManagedWorktreeTerminals(
      {
        worktreeSelector: `id:${worktree.id}`,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        ...(setup ? { setup } : {}),
        ...(defaultTabs ? { defaultTabs } : {}),
        hasStartupTerminal: false,
        setupCommandPlatform: getSetupRunnerCommandPlatformForLaunch(setup, 'posix'),
        surfaceOwner: false
      },
      worktree
    )
  }

  notifyLineageRepos(
    (repoId) => notifyWorktreesChanged(mainWindow, repoId),
    repo.id,
    worktreeLineage?.parentWorktreeId
  )
  return {
    worktree: {
      ...worktree,
      workspaceLineage,
      ...(worktreeLineage
        ? { lineage: worktreeLineage, parentWorktreeId: worktreeLineage.parentWorktreeId }
        : {})
    },
    ...(worktreeLineage ? { lineage: worktreeLineage } : {}),
    ...(workspaceLineage ? { workspaceLineage } : {}),
    ...(provisionedByHost
      ? {}
      : {
          ...(stagedStartup.activationSetup
            ? { setup: stagedStartup.activationSetup }
            : setup && !stagedStartup.didSpawnSetup
              ? { setup }
              : {}),
          ...(defaultTabs ? { defaultTabs } : {})
        }),
    ...(addResult.localBaseRefRefresh
      ? { localBaseRefRefresh: addResult.localBaseRefRefresh }
      : {}),
    ...(addResult.localBaseRefUpdateSuggestion
      ? { localBaseRefUpdateSuggestion: addResult.localBaseRefUpdateSuggestion }
      : {}),
    ...(stagedStartup.startupTerminal ? { startupTerminal: stagedStartup.startupTerminal } : {}),
    ...(baseFallback ? { baseFallback } : {}),
    ...(stagedStartup.warning
      ? { warning: appendWorktreeCreateWarning(materializationWarning, stagedStartup.warning) }
      : materializationWarning
        ? { warning: materializationWarning }
        : {}),
    timing: timing.finish()
  }
}
