import React, { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen, RotateCcw } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  clearHostSettingOverrideForIds,
  getHostSettingOverrideForIds,
  setHostSettingOverrideForIds,
  type HostSettingOverrideKey
} from '../../../../../shared/host-setting-overrides'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../../shared/execution-host'
import { normalizeWorkspaceDirInput } from '../../../../../shared/worktree/workspace-dir-input'
import { isAbsoluteOrHomeFolderPath } from '@/lib/host-folder-path'
import { isWindowsUserAgent } from '@/lib/user-agent-platform'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Dialog, DialogContent } from '../../ui/dialog'
import { CreateProjectParentBrowser } from '../../sidebar/project-admission/create/CreateProjectLocationField'
import { pickLocalProjectLocationFolder } from '../../new-workspace/pick-local-project-folder'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { SettingsHostScopeUnavailableNotice } from '../host-scope/SettingsHostScopePicker'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { useTranslate } from '@/i18n/use-translate'

export type HostFolderSettingRowProps = {
  scope: SettingsHostScope
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  settingKey: HostSettingOverrideKey
  /** Value shown when the machine holds no override for `settingKey`. */
  fallbackValue: string
  /** How a value typed for this computer is saved when it is not an override (the client default). */
  writeLocal?: (next: string) => Partial<GlobalSettings>
  /** Explains where a remote machine's value comes from. */
  remoteCaption: React.ReactNode
  /** Explains what this computer's value means. */
  localCaption: React.ReactNode
  /** This computer's workspace folder is documented to take a relative per-project path. */
  allowRelativePath?: boolean
  anchorId?: string
  title: string
  description: string
  keywords: string[]
}

/** A destination the clone or create path refuses is a value the row must not save: it names a
 *  folder on another machine, so only that machine's own home can expand a `~`. */
function isUnusableFolderPath(
  value: string,
  requiresAbsolute: boolean,
  isWindowsHost: boolean
): boolean {
  const trimmed = value.trim()
  return requiresAbsolute && trimmed !== '' && !isAbsoluteOrHomeFolderPath(trimmed, isWindowsHost)
}

/** One folder on the machine chosen at the top of Settings; this computer is the client default. */
export function HostFolderSettingRow({
  scope,
  settings,
  updateSettings,
  settingKey,
  fallbackValue,
  writeLocal,
  remoteCaption,
  localCaption,
  allowRelativePath,
  anchorId,
  title,
  description,
  keywords
}: HostFolderSettingRowProps): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const isLocal = scope.hostId === LOCAL_EXECUTION_HOST_ID
  const override = getHostSettingOverrideForIds(settings, scope.equivalentHostIds, settingKey)
  const value = override ?? fallbackValue
  const hasOverride = override !== undefined
  const [draftValue, setDraftValue] = useState(value)
  const draftValueRef = useRef(value)
  const skipNextBlurCommitRef = useRef(false)
  const [browsing, setBrowsing] = useState(false)
  const [pathRefused, setPathRefused] = useState(false)
  // A probed fallback can arrive while the user types; only an untouched draft is re-seeded.
  const editedRef = useRef(false)
  const seededHostIdRef = useRef(scope.hostId)
  const lastCommittedRef = useRef(value)
  // A relative path only ever means a per-project location, which only this computer documents.
  const requiresAbsolutePath = !(allowRelativePath && isLocal)
  const isWindowsHost = isLocal && isWindowsUserAgent()

  useEffect(() => {
    // settings:set creates directories; a new scope must never commit the previous host's draft.
    const untouched = !editedRef.current || draftValueRef.current === lastCommittedRef.current
    if (seededHostIdRef.current === scope.hostId && !untouched) {
      return
    }
    seededHostIdRef.current = scope.hostId
    editedRef.current = false
    lastCommittedRef.current = value
    setDraftValue(value)
    draftValueRef.current = value
    // A value saved before this check existed stays visible as the problem it is.
    setPathRefused(isUnusableFolderPath(value, requiresAbsolutePath, isWindowsHost))
  }, [scope.hostId, value, requiresAbsolutePath, isWindowsHost])

  const setDraft = (next: string): void => {
    editedRef.current = true
    draftValueRef.current = next
    setDraftValue(next)
    setPathRefused(false)
  }

  const writeValue = (next: string): void => {
    updateSettings(
      isLocal && writeLocal
        ? writeLocal(next)
        : {
            hostSettingOverrides: setHostSettingOverrideForIds(
              settings,
              scope.equivalentHostIds,
              settingKey,
              next
            )
          }
    )
  }

  const commitDraftValue = (): void => {
    // Show the value main will save, so a padded re-save of the saved path writes nothing.
    const next = normalizeWorkspaceDirInput(draftValueRef.current, isWindowsUserAgent())
    setDraft(next)
    if (isUnusableFolderPath(next, requiresAbsolutePath, isWindowsHost)) {
      setPathRefused(true)
      return
    }
    if (next === value) {
      return
    }
    // The draft now matches what was saved, so a later value change may re-seed it.
    editedRef.current = false
    lastCommittedRef.current = next
    writeValue(next)
  }

  const handleBlur = (): void => {
    if (skipNextBlurCommitRef.current) {
      skipNextBlurCommitRef.current = false
      return
    }
    commitDraftValue()
  }

  const resetOverride = (): void => {
    // The cleared value re-seeds the row, so a refused draft must not outlive it.
    editedRef.current = false
    setPathRefused(false)
    updateSettings({
      hostSettingOverrides: clearHostSettingOverrideForIds(
        settings,
        scope.equivalentHostIds,
        settingKey
      )
    })
  }

  const parsedHost = parseExecutionHostId(scope.hostId)
  const sshTargetId = parsedHost?.kind === 'ssh' ? parsedHost.targetId : null
  const runtimeEnvironmentId =
    scope.target?.kind === 'environment' ? scope.target.environmentId : null
  const browsable =
    scope.available && (isLocal || sshTargetId !== null || runtimeEnvironmentId !== null)

  const handleBrowse = (): void => {
    // The pointer-down skip has already suppressed the blur this click caused.
    skipNextBlurCommitRef.current = false
    if (isLocal) {
      // The native dialog returns paths on this computer, which is the scope it was opened for.
      void pickLocalProjectLocationFolder((path) => {
        setDraft(path)
        editedRef.current = false
        lastCommittedRef.current = path
        writeValue(path)
      })
      return
    }
    setBrowsing(true)
  }

  return (
    <SearchableSetting
      id={anchorId}
      title={title}
      description={description}
      keywords={keywords}
      className="space-y-2 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId}>{title}</Label>
      </div>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={draftValue}
          disabled={!scope.available}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            // IME candidate-confirming Enter must not commit; wait for a noncomposition Enter.
            if (isImeCompositionKeyDown(e)) {
              return
            }
            if (e.key === 'Enter') {
              skipNextBlurCommitRef.current = true
              commitDraftValue()
              e.currentTarget.blur()
              return
            }
            if (e.key === 'Escape') {
              skipNextBlurCommitRef.current = true
              setDraft(value)
              // Back to the saved value, so a later Reset or scope change may re-seed it.
              editedRef.current = false
              // A saved value that is still unusable stays flagged rather than looking fixed.
              setPathRefused(isUnusableFolderPath(value, requiresAbsolutePath, isWindowsHost))
              e.currentTarget.blur()
            }
          }}
          className="flex-1 text-xs"
          aria-invalid={pathRefused ? true : undefined}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!browsable}
          onPointerDown={() => {
            skipNextBlurCommitRef.current = true
          }}
          onClick={handleBrowse}
          className="shrink-0"
        >
          <FolderOpen className="size-3.5" />
          {t('auto.components.settings.GeneralWorkspaceSettingsSection.5567191a6e', 'Browse')}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        {pathRefused ? (
          <p className="text-xs text-destructive">
            {t(
              'auto.components.settings.general.HostFolderSettingRow.607a8e146c',
              'Use a full path, or one that starts with ~/.'
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{isLocal ? localCaption : remoteCaption}</p>
        )}
        {hasOverride && (
          <Button type="button" variant="ghost" size="xs" onClick={resetOverride}>
            <RotateCcw className="size-3.5" />
            {t('auto.components.settings.WorkspaceDirectorySetting.5e6f7a8b9c', 'Reset')}
          </Button>
        )}
      </div>
      {!scope.available && <SettingsHostScopeUnavailableNotice />}
      {browsing && (
        <Dialog open onOpenChange={(next) => (next ? undefined : setBrowsing(false))}>
          <DialogContent className="sm:max-w-lg">
            <CreateProjectParentBrowser
              sshTargetId={sshTargetId}
              runtimeEnvironmentId={runtimeEnvironmentId}
              createParent={draftValue}
              onParentChange={(path) => {
                setDraft(path)
                editedRef.current = false
                lastCommittedRef.current = path
                writeValue(path)
              }}
              onClose={() => setBrowsing(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </SearchableSetting>
  )
}
