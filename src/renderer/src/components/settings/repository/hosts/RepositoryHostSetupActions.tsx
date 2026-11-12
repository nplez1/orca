import { useEffect, useState } from 'react'
import { useCloneFolderOverride } from '../../../sidebar/project-admission/clone-folder/use-clone-folder-override'
import { getProjectCloneCheckTarget } from '../../../../store/projects/project-host-routing'
import { Plus, X } from 'lucide-react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectHostAddRequest } from '@/store/slices/fork-ui'
import type {
  ProjectHostSetup,
  ProjectHostSetupCreateResult,
  ProjectHostSetupResult
} from '../../../../../../shared/project-types'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { resolveWorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import { useCloneParentDefault } from '../../../sidebar/project-admission/create/use-clone-parent-default'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { HostCombobox } from '../../../host-picker/HostCombobox'
import type { SetupHostOption } from './repository-host-setup-options'
import {
  HostSetupCloneStep,
  HostSetupExistingFolderStep,
  HostSetupPlannedStep,
  HostSetupStartActions
} from './repository-host-add-project-steps'

type RepositoryHostSetupActionsProps = {
  repoDisplayName: string
  selectedProjectHostSetup: ProjectHostSetup
  setupHostOptions: SetupHostOption[]
  setupProjectExistingFolder: (args: {
    projectId: string
    hostId: ExecutionHostId
    path: string
    kind: 'git' | 'folder'
    displayName: string
  }) => Promise<ProjectHostSetupResult | null>
  setupProjectClone: (args: {
    projectId: string
    hostId: ExecutionHostId
    url: string
    destination: string
    folderName?: string
    displayName: string
  }) => Promise<ProjectHostSetupResult | null>
  createProjectHostSetup: (args: {
    projectId: string
    hostId: ExecutionHostId
    displayName: string
    setupState: 'not-set-up'
    setupMethod: 'provisioned'
  }) => Promise<ProjectHostSetupCreateResult | null>
  onSetupReady: (hostId: ExecutionHostId) => void
  /** Sidebar Add to… request for this project: opens the flow on that host instead of the default. */
  addHostRequest?: ProjectHostAddRequest | null
  onAddHostRequestHandled: () => void
}

type SetupStep = 'choose' | 'existing' | 'clone' | 'planned'

export function RepositoryHostSetupActions({
  repoDisplayName,
  selectedProjectHostSetup,
  setupHostOptions,
  setupProjectExistingFolder,
  setupProjectClone,
  createProjectHostSetup,
  onSetupReady,
  addHostRequest = null,
  onAddHostRequestHandled
}: RepositoryHostSetupActionsProps): React.JSX.Element | null {
  const t = useTranslate()
  const [isOpen, setIsOpen] = useState(false)
  const [step, setStep] = useState<SetupStep>('choose')
  const [selectedSetupHostId, setSelectedSetupHostId] = useState<ExecutionHostId | null>(null)
  const [setupPath, setSetupPath] = useState('')
  const [setupKind, setSetupKind] = useState<'git' | 'folder'>('git')
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [cloneDestinationEdited, setCloneDestinationEdited] = useState(false)
  const [isSettingUp, setIsSettingUp] = useState(false)
  const [isCloning, setIsCloning] = useState(false)
  const [isCreatingPendingSetup, setIsCreatingPendingSetup] = useState(false)
  const settings = useAppStore((state) => state.settings)
  const [handledAddHostRequest, setHandledAddHostRequest] = useState<ProjectHostAddRequest | null>(
    null
  )
  const pendingAddHostRequest =
    addHostRequest && addHostRequest !== handledAddHostRequest ? addHostRequest : null
  // Why: the sidebar validated the host against this pane's own option list, so a request only
  // ever names a destination this flow can reach. Applied while rendering (React's own pattern
  // for a prop-driven reset) instead of from an effect, which would flash the stale step.
  if (pendingAddHostRequest) {
    setHandledAddHostRequest(pendingAddHostRequest)
    setSelectedSetupHostId(pendingAddHostRequest.hostId)
    setStep('choose')
    setSetupPath('')
    setCloneUrl('')
    setCloneDestination('')
    setCloneDestinationEdited(false)
    setIsOpen(true)
  }
  useEffect(() => {
    if (handledAddHostRequest) {
      // Why: the store request only carried the intent here; it must not survive to reopen the flow.
      onAddHostRequestHandled()
    }
  }, [handledAddHostRequest, onAddHostRequestHandled])
  const defaultSetupHostOption =
    setupHostOptions.find((option) => option.isAvailable && option.canUsePathActions) ??
    setupHostOptions.find((option) => option.isAvailable) ??
    setupHostOptions[0] ??
    null
  const setupTargetHostId = selectedSetupHostId ?? defaultSetupHostOption?.id ?? null
  const setupTargetHostOption =
    setupHostOptions.find((option) => option.id === setupTargetHostId) ?? null
  const canUseSetupTargetHost = setupTargetHostOption?.isAvailable ?? false
  const canUsePathActions =
    canUseSetupTargetHost && (setupTargetHostOption?.canUsePathActions ?? false)
  // Same rule as the sidebar clone step, so adding a project to a host needs no typed path.
  const hostRepoRoot = useCloneParentDefault({
    settings,
    hostIds: setupTargetHostId ? [setupTargetHostId] : [],
    layoutMode: settings ? resolveWorktreeLayoutMode(settings) : undefined,
    enabled: isOpen && canUsePathActions
  })
  const cloneParent = hostRepoRoot.parent
  // Why: the default seeds the field, it is not merged into every render — otherwise clearing it
  // snaps the text back and the next keystroke appends to the default (issue #374). A default that
  // arrives late still fills an untouched field, and it follows a host change until the user edits.
  useEffect(() => {
    if (step !== 'clone' || cloneDestinationEdited) {
      return
    }
    if (!cloneParent || cloneParent === cloneDestination) {
      return
    }
    setCloneDestination(cloneParent)
  }, [step, cloneDestinationEdited, cloneDestination, cloneParent])
  // Only the clone destination gets a default: the existing-folder step imports a folder that must
  // already exist.
  const cloneDestinationValue = cloneDestination
  const { cloneFolder, cloneArgs, setCloneFolderName, resetCloneFolder, checkCloneFolderTaken } =
    useCloneFolderOverride(cloneUrl, cloneDestinationValue)

  if (setupHostOptions.length === 0) {
    return null
  }

  const resetFlow = (): void => {
    setIsOpen(false)
    setStep('choose')
    setSelectedSetupHostId(null)
    setSetupPath('')
    setCloneUrl('')
    setCloneDestination('')
    setCloneDestinationEdited(false)
    resetCloneFolder()
  }

  const changeCloneDestination = (value: string): void => {
    // Why: any edit claims the field, so clearing it stays empty and no default overwrites it.
    setCloneDestinationEdited(true)
    setCloneDestination(value)
  }

  const handleExistingFolder = async (): Promise<void> => {
    if (!setupTargetHostId || !canUsePathActions || !setupPath.trim()) {
      return
    }
    setIsSettingUp(true)
    try {
      const result = await setupProjectExistingFolder({
        projectId: selectedProjectHostSetup.projectId,
        hostId: setupTargetHostId,
        path: setupPath.trim(),
        kind: setupKind,
        displayName: repoDisplayName
      })
      if (result) {
        resetFlow()
        onSetupReady(setupTargetHostId)
      }
    } finally {
      setIsSettingUp(false)
    }
  }

  const handleClone = async (): Promise<void> => {
    if (
      !setupTargetHostId ||
      !canUsePathActions ||
      !cloneUrl.trim() ||
      !cloneDestinationValue.trim()
    ) {
      return
    }
    setIsCloning(true)
    try {
      if (await checkCloneFolderTaken(getProjectCloneCheckTarget(setupTargetHostId))) {
        return
      }
      const result = await setupProjectClone({
        projectId: selectedProjectHostSetup.projectId,
        hostId: setupTargetHostId,
        ...cloneArgs,
        displayName: repoDisplayName
      })
      if (result) {
        resetFlow()
        onSetupReady(setupTargetHostId)
      }
    } finally {
      setIsCloning(false)
    }
  }

  const handleCreatePendingSetup = async (): Promise<void> => {
    if (!setupTargetHostId || !canUseSetupTargetHost) {
      return
    }
    setIsCreatingPendingSetup(true)
    try {
      const result = await createProjectHostSetup({
        projectId: selectedProjectHostSetup.projectId,
        hostId: setupTargetHostId,
        displayName: repoDisplayName,
        setupState: 'not-set-up',
        setupMethod: 'provisioned'
      })
      if (result) {
        resetFlow()
      }
    } finally {
      setIsCreatingPendingSetup(false)
    }
  }

  if (!isOpen) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm font-semibold">
            {t('auto.components.settings.RepositoryPane.hostAvailability', 'Host availability')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.RepositoryPane.hostAvailabilityHelp',
              'Add this same project on another connected host.'
            )}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setIsOpen(true)}>
          <Plus className="size-4" />
          {t('auto.components.settings.RepositoryPane.addToAnotherHost', 'Add to another host')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm font-semibold">
            {t('auto.components.settings.RepositoryPane.addProjectHost', 'Add project to host')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.RepositoryPane.addProjectHostHelp',
              'Choose where this project should also be available.'
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('auto.components.settings.RepositoryPane.closeHostSetup', 'Close')}
          onClick={resetFlow}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">
          {t('auto.components.settings.RepositoryPane.setupHostLabel', 'Host')}
        </Label>
        <HostCombobox
          value={setupTargetHostId ?? ''}
          onChange={(value) => {
            const option = setupHostOptions.find((candidate) => candidate.id === value)
            if (option) {
              setSelectedSetupHostId(option.id)
            }
          }}
          options={setupHostOptions.map((option) => ({
            id: option.id,
            label: option.label,
            disabled: !option.isAvailable,
            detail: !option.isAvailable || !option.canUsePathActions ? option.detail : undefined
          }))}
          className="min-w-0"
        />
        {(!canUseSetupTargetHost || !canUsePathActions) && setupTargetHostOption ? (
          <p className="text-xs text-muted-foreground">{setupTargetHostOption.detail}</p>
        ) : null}
      </div>

      {step === 'choose' ? (
        <HostSetupStartActions
          pathActionsDisabled={!canUsePathActions}
          planDisabled={!canUseSetupTargetHost}
          onBrowse={() => setStep('existing')}
          onClone={() => setStep('clone')}
          onPlan={() => setStep('planned')}
        />
      ) : null}
      {step === 'existing' ? (
        <HostSetupExistingFolderStep
          setupPath={setupPath}
          setupKind={setupKind}
          disabled={!canUsePathActions}
          isSettingUp={isSettingUp}
          onBack={() => setStep('choose')}
          onPathChange={setSetupPath}
          onKindChange={setSetupKind}
          onSubmit={handleExistingFolder}
        />
      ) : null}
      {step === 'clone' ? (
        <HostSetupCloneStep
          cloneUrl={cloneUrl}
          cloneDestination={cloneDestinationValue}
          disabled={!canUsePathActions}
          isCloning={isCloning}
          onBack={() => setStep('choose')}
          onCloneUrlChange={setCloneUrl}
          onCloneDestinationChange={changeCloneDestination}
          cloneFolder={cloneFolder}
          onCloneFolderNameChange={setCloneFolderName}
          onSubmit={handleClone}
        />
      ) : null}
      {step === 'planned' ? (
        <HostSetupPlannedStep
          disabled={!canUseSetupTargetHost}
          isCreatingPendingSetup={isCreatingPendingSetup}
          hostLabel={setupTargetHostOption?.label ?? ''}
          onBack={() => setStep('choose')}
          onSubmit={handleCreatePendingSetup}
        />
      ) : null}
    </div>
  )
}
