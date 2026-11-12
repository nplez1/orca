import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStateValue } from '@/store/retained-views/app-state-view'

// Match repository-hook script drafts’ debounce.
const SETTINGS_TEXT_COMMIT_DEBOUNCE_MS = 700

export type DebouncedSettingsTextDraft = {
  value: string
  onChange: (next: string) => void
  onBlur: () => void
}

/** Debounce settings IPC to avoid per-keystroke rerenders across windows; timer presence tracks uncommitted edits. */
export function useDebouncedSettingsTextDraft(args: {
  value: string
  commit: (next: string) => void
}): DebouncedSettingsTextDraft {
  const { value, commit } = args
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(draft)
  const commitRef = useRef(commit)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writeFailureRevision = useAppStateValue((state) => state.settingsWriteFailureRevision)
  const appliedWriteFailureRevisionRef = useRef(writeFailureRevision)

  // Publish after commit because React may replay renders.
  useEffect(() => {
    commitRef.current = commit
  }, [commit])

  // Accept external writes only without pending local edits so echoes cannot erase new typing.
  useEffect(() => {
    if (timerRef.current !== null) {
      return
    }
    draftRef.current = value
    setDraft(value)
  }, [value])

  // A rejected write leaves `value` untouched, so the draft needs its own revert.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: the revert key is an external write-failure signal, and a pending debounce timer must keep the user's typing.
  useEffect(() => {
    if (writeFailureRevision === appliedWriteFailureRevisionRef.current) {
      return
    }
    appliedWriteFailureRevisionRef.current = writeFailureRevision
    if (timerRef.current !== null) {
      return
    }
    draftRef.current = value
    setDraft(value)
  }, [writeFailureRevision, value])

  const flush = useCallback(() => {
    if (timerRef.current === null) {
      return
    }
    clearTimeout(timerRef.current)
    timerRef.current = null
    commitRef.current(draftRef.current)
  }, [])

  const onChange = useCallback(
    (next: string) => {
      draftRef.current = next
      setDraft(next)
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
      timerRef.current = setTimeout(flush, SETTINGS_TEXT_COMMIT_DEBOUNCE_MS)
    },
    [flush]
  )

  // Unmount flushes partial edits; close dispatches beforeunload while mounted so synchronous IPC precedes main’s quit flush.
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flush])

  return { value: draft, onChange, onBlur: flush }
}
