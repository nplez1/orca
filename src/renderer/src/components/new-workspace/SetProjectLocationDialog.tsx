import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { CreateProjectParentBrowser } from '@/components/sidebar/project-admission/create/CreateProjectLocationField'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption
} from '@/lib/project-host-setup-options'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { RepoKind } from '../../../../shared/repo-types'
import { pickLocalProjectLocationFolder } from './pick-local-project-folder'
import { ExistingFolderForm } from './SetProjectLocationForms'
import type { ProjectHostSetupProvisioning } from './use-workspace-copy-target'

type SetProjectLocationDialogProps = {
  option: NeedsSetupProjectHostOption | null
  projectName: string
  projectKind: RepoKind
  initialPath?: string | undefined
  onClose: () => void
  onReady: (setupId: string, provisioning: ProjectHostSetupProvisioning) => void
}

// fork-comment-ok: this surface exists only because the clone moved out of it — the fallback a
// failed or impossible clone lands on. Without that note the next reader restores the clone form.
/** Adopting a checkout that already exists on a host. */
export function SetProjectLocationDialog({
  option,
  projectName,
  projectKind,
  initialPath,
  onClose,
  onReady
}: SetProjectLocationDialogProps): React.JSX.Element {
  const open = option !== null
  // Keep the last body through the close animation to avoid blanking it mid-exit.
  const [renderOption, setRenderOption] = useState(option)
  if (option !== null && option !== renderOption) {
    setRenderOption(option)
  }
  const activeOption = option ?? renderOption
  // fork-comment-ok: Radix captures Escape first, so backing out of the browser is delegated here.
  const exitHostBrowser = useRef<(() => boolean) | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent
        data-testid="set-project-location-dialog"
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (exitHostBrowser.current?.()) {
            // Radix only skips onDismiss when the escape was defaultPrevented.
            event.preventDefault()
          }
        }}
      >
        {activeOption ? (
          <SetProjectLocationDialogBody
            key={`${activeOption.id}:${initialPath ?? ''}`}
            option={activeOption}
            projectName={projectName}
            projectKind={projectKind}
            initialPath={initialPath}
            exitHostBrowser={exitHostBrowser}
            onReady={onReady}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SetProjectLocationDialogBody({
  option,
  projectName,
  projectKind,
  initialPath,
  exitHostBrowser,
  onReady
}: {
  option: NeedsSetupProjectHostOption
  projectName: string
  projectKind: RepoKind
  initialPath?: string | undefined
  exitHostBrowser: RefObject<(() => boolean) | null>
  onReady: (setupId: string, provisioning: ProjectHostSetupProvisioning) => void
}): React.JSX.Element {
  const t = useTranslate()
  const setupProjectExistingFolder = useAppStore((state) => state.setupProjectExistingFolder)
  const [browsing, setBrowsing] = useState(false)
  const [setupPath, setSetupPath] = useState(initialPath ?? '')
  const [setupKind, setSetupKind] = useState<RepoKind>(projectKind)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const abandoned = useRef(false)
  useEffect(() => {
    // Reset on mount because StrictMode’s setup/cleanup/setup would otherwise permanently abandon this dialog.
    abandoned.current = false
    return () => {
      abandoned.current = true
    }
  }, [])
  const parsedHost = parseExecutionHostId(option.hostId)
  const remoteHost =
    parsedHost?.kind === 'ssh' || parsedHost?.kind === 'runtime' ? parsedHost : null

  useEffect(() => {
    exitHostBrowser.current = browsing
      ? () => {
          setBrowsing(false)
          return true
        }
      : null
    return () => {
      exitHostBrowser.current = null
    }
  }, [browsing, exitHostBrowser])

  const openHostBrowser = (): void => {
    if (!remoteHost) {
      void pickLocalProjectLocationFolder(setSetupPath)
      return
    }
    setBrowsing(true)
  }

  const handleExistingSubmit = async (): Promise<void> => {
    if (!setupPath.trim()) {
      return
    }
    setIsSubmitting(true)
    try {
      const result = await setupProjectExistingFolder({
        projectId: option.projectId,
        hostId: option.hostId,
        path: setupPath.trim(),
        kind: setupKind,
        displayName: projectName
      })
      if (result && !abandoned.current) {
        onReady(
          getProjectHostSetupSelectionKey({ id: result.setup.id, hostId: option.hostId }),
          'existing-folder'
        )
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  if (browsing && remoteHost) {
    return (
      <CreateProjectParentBrowser
        sshTargetId={remoteHost.kind === 'ssh' ? remoteHost.targetId : null}
        runtimeEnvironmentId={remoteHost.kind === 'runtime' ? remoteHost.environmentId : null}
        createParent={setupPath}
        onParentChange={setSetupPath}
        onClose={() => setBrowsing(false)}
      />
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t(
            'auto.components.new.workspace.SetProjectLocationDialog.useExistingFolderTitle',
            'Use an existing folder'
          )}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.new.workspace.SetProjectLocationDialog.description',
            'Choose where {{project}} lives on {{host}}.',
            { project: projectName, host: option.label }
          )}
        </DialogDescription>
      </DialogHeader>
      <ExistingFolderForm
        setupPath={setupPath}
        setupKind={setupKind}
        isSubmitting={isSubmitting}
        onPathChange={setSetupPath}
        onKindChange={setSetupKind}
        onBrowse={openHostBrowser}
        onSubmit={() => void handleExistingSubmit()}
      />
    </>
  )
}
