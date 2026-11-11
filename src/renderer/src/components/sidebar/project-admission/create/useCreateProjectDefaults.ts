// Resolve parent and Git defaults on the chosen host while rejecting stale async results.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitAvailability } from './create-project-defaults'
import {
  RUNTIME_GIT_AVAILABILITY_TIMEOUT_MS,
  resolveRuntimeCreateParent,
  withTimeout
} from './runtime-create-parent'
import type { WorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { AddRepoDialogStep } from '../dialog/add-repo-dialog-types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'

const LOCAL_GIT_AVAILABILITY_TIMEOUT_MS = 1500

export type CreateRuntimeParentStatus = 'idle' | 'checking' | 'failed'

type AutoFilledCreateParent = {
  parent: string
  targetKey: string
}

type CreateParentProvenance = {
  parent: string
  targetKey: string
}

export function useCreateProjectDefaults({
  step,
  activeRuntimeEnvironmentId,
  createParent,
  setCreateParent,
  worktreeLayoutMode,
  hostSettingOverrides
}: {
  step: AddRepoDialogStep
  activeRuntimeEnvironmentId: string | null | undefined
  createParent: string
  setCreateParent: (value: string) => void
  /** Placement mode, so a runtime host's default parent matches the layout in use. */
  worktreeLayoutMode?: WorktreeLayoutMode
  /** Per-host folder overrides: a stored root wins over recomputing from the host's home. */
  hostSettingOverrides?: GlobalSettings['hostSettingOverrides']
}): {
  createDefaultParent: string
  createGitAvailability: GitAvailability
  createRuntimeParentStatus: CreateRuntimeParentStatus
  createParentDefaultPending: boolean
  resetCreateDefaultState: () => void
  markCreateParentTouched: (value?: string) => void
} {
  const [createDefaultParent, setCreateDefaultParent] = useState('')
  const [createGitAvailability, setCreateGitAvailability] = useState<GitAvailability>('unknown')
  const [createRuntimeParentStatus, setCreateRuntimeParentStatus] =
    useState<CreateRuntimeParentStatus>('idle')
  const createStepAutoFilledRef = useRef(false)
  const autoFilledCreateParentRef = useRef<AutoFilledCreateParent | null>(null)
  const createParentProvenanceRef = useRef<CreateParentProvenance | null>(null)
  const createParentTouchedRef = useRef(false)
  const createParentDefaultGenRef = useRef(0)
  const createGitProbeGenRef = useRef(0)
  const activeCreateParentRuntimeEnvironmentId = activeRuntimeEnvironmentId?.trim() || null
  const activeCreateParentTargetKey = activeCreateParentRuntimeEnvironmentId
    ? `runtime:${activeCreateParentRuntimeEnvironmentId}`
    : 'local'

  const canReplaceCreateParentDefault = useCallback((parent: string): boolean => {
    if (createParentTouchedRef.current) {
      return false
    }
    const trimmedParent = parent.trim()
    return !trimmedParent || autoFilledCreateParentRef.current?.parent === trimmedParent
  }, [])

  const resetCreateDefaultState = useCallback(() => {
    createParentDefaultGenRef.current++
    createGitProbeGenRef.current++
    createStepAutoFilledRef.current = false
    autoFilledCreateParentRef.current = null
    createParentProvenanceRef.current = null
    createParentTouchedRef.current = false
    setCreateDefaultParent('')
    setCreateGitAvailability('unknown')
    setCreateRuntimeParentStatus('idle')
  }, [])

  // Why: a default must never clobber a parent the user picked themselves.
  const markCreateParentTouched = useCallback(
    (value?: string) => {
      autoFilledCreateParentRef.current = null
      createParentProvenanceRef.current = {
        parent: (value ?? createParent).trim(),
        targetKey: activeCreateParentTargetKey
      }
      createParentTouchedRef.current = true
    },
    [activeCreateParentTargetKey, createParent]
  )

  const createParentDefaultPending =
    step === 'create' &&
    !createParentTouchedRef.current &&
    Boolean(createParent.trim()) &&
    autoFilledCreateParentRef.current?.parent === createParent.trim() &&
    autoFilledCreateParentRef.current.targetKey !== activeCreateParentTargetKey
  const createParentTargetPending =
    step === 'create' &&
    Boolean(createParent.trim()) &&
    createParentProvenanceRef.current?.parent === createParent.trim() &&
    createParentProvenanceRef.current.targetKey !== activeCreateParentTargetKey
  const createParentPending = createParentDefaultPending || createParentTargetPending

  useEffect(() => {
    if (step !== 'create') {
      return
    }
    if (activeCreateParentRuntimeEnvironmentId) {
      return
    }
    // Why: invalidate any in-flight runtime parent probe once local mode owns the default.
    const gen = ++createParentDefaultGenRef.current
    if (!canReplaceCreateParentDefault(createParent)) {
      return
    }
    if (
      createParent.trim() &&
      autoFilledCreateParentRef.current?.targetKey !== 'local' &&
      autoFilledCreateParentRef.current?.parent === createParent.trim()
    ) {
      setCreateDefaultParent('')
      setCreateParent('')
      return
    }
    if (
      autoFilledCreateParentRef.current?.targetKey === 'local' &&
      autoFilledCreateParentRef.current.parent === createParent.trim()
    ) {
      return
    }
    setCreateDefaultParent('')
    void window.api.repos
      .getDefaultCreateProjectParent()
      .then((parent) => {
        if (
          gen !== createParentDefaultGenRef.current ||
          !canReplaceCreateParentDefault(createParent) ||
          !parent
        ) {
          return
        }
        setCreateDefaultParent(parent)
        createStepAutoFilledRef.current = true
        autoFilledCreateParentRef.current = { parent, targetKey: 'local' }
        createParentProvenanceRef.current = { parent, targetKey: 'local' }
        setCreateParent(parent)
      })
      .catch(() => {
        // Keep the field empty if the local host cannot provide a submit-ready default.
      })
  }, [
    activeRuntimeEnvironmentId,
    activeCreateParentRuntimeEnvironmentId,
    canReplaceCreateParentDefault,
    createParent,
    setCreateParent,
    step
  ])

  useEffect(() => {
    if (step !== 'create') {
      return
    }
    const runtimeEnvironmentId = activeCreateParentRuntimeEnvironmentId
    if (!runtimeEnvironmentId) {
      setCreateRuntimeParentStatus('idle')
      return
    }
    if (!canReplaceCreateParentDefault(createParent)) {
      setCreateRuntimeParentStatus('idle')
      return
    }
    if (
      createParent.trim() &&
      autoFilledCreateParentRef.current?.targetKey !== `runtime:${runtimeEnvironmentId}` &&
      autoFilledCreateParentRef.current?.parent === createParent.trim()
    ) {
      setCreateDefaultParent('')
      setCreateRuntimeParentStatus('checking')
      setCreateParent('')
      return
    }
    if (
      autoFilledCreateParentRef.current?.targetKey === `runtime:${runtimeEnvironmentId}` &&
      autoFilledCreateParentRef.current.parent === createParent.trim()
    ) {
      setCreateRuntimeParentStatus('idle')
      return
    }
    setCreateDefaultParent('')

    const gen = ++createParentDefaultGenRef.current
    setCreateRuntimeParentStatus('checking')
    void resolveRuntimeCreateParent({
      runtimeEnvironmentId,
      worktreeLayoutMode,
      hostSettingOverrides
    })
      .then((result) => {
        if (
          gen !== createParentDefaultGenRef.current ||
          !canReplaceCreateParentDefault(createParent)
        ) {
          return
        }
        const parent = result.parent
        createStepAutoFilledRef.current = true
        autoFilledCreateParentRef.current = {
          parent,
          targetKey: `runtime:${runtimeEnvironmentId}`
        }
        createParentProvenanceRef.current = {
          parent,
          targetKey: `runtime:${runtimeEnvironmentId}`
        }
        setCreateDefaultParent(parent)
        setCreateParent(parent)
        setCreateRuntimeParentStatus('idle')
      })
      .catch(() => {
        if (gen !== createParentDefaultGenRef.current) {
          return
        }
        setCreateRuntimeParentStatus('failed')
      })
  }, [
    activeRuntimeEnvironmentId,
    activeCreateParentRuntimeEnvironmentId,
    canReplaceCreateParentDefault,
    createParent,
    hostSettingOverrides,
    setCreateParent,
    step,
    worktreeLayoutMode
  ])

  useEffect(() => {
    if (step !== 'create') {
      return
    }
    const runtimeEnvironmentId = activeRuntimeEnvironmentId?.trim()
    const gen = ++createGitProbeGenRef.current
    setCreateGitAvailability('checking')
    const probe = runtimeEnvironmentId
      ? callRuntimeRpc<{ available: boolean }>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'repo.gitAvailable',
          undefined,
          { timeoutMs: RUNTIME_GIT_AVAILABILITY_TIMEOUT_MS }
        ).then((result) => result.available)
      : window.api.repos.isGitAvailable()
    const timeoutMs = runtimeEnvironmentId
      ? RUNTIME_GIT_AVAILABILITY_TIMEOUT_MS
      : LOCAL_GIT_AVAILABILITY_TIMEOUT_MS

    void withTimeout(probe, timeoutMs)
      .then((available) => {
        if (gen !== createGitProbeGenRef.current) {
          return
        }
        setCreateGitAvailability(available ? 'available' : 'unavailable')
      })
      .catch(() => {
        if (gen !== createGitProbeGenRef.current) {
          return
        }
        setCreateGitAvailability('unknown')
      })
  }, [activeRuntimeEnvironmentId, step])

  return {
    createDefaultParent,
    createGitAvailability,
    createRuntimeParentStatus,
    createParentDefaultPending: createParentPending,
    resetCreateDefaultState,
    markCreateParentTouched
  }
}
