import { useRef } from 'react'
import {
  areTaskSourceContextsEqual,
  type TaskSourceContext
} from '../../../shared/task-source-context'

/**
 * One reference per equal source value. Why a value comparison and not `useMemo`: a derived source
 * is allocated per call and the panes refetch on its identity, while the active workspace row is
 * replaced on routine writes that change nothing an owner depends on — a PTY bind bumps
 * `lastActivityAt` — so a memo keyed on the row would still hand the panes a fresh object and blank
 * them to a loader. The comparison is the task-source contract's own, so two sources that route and
 * cache identically are treated as one.
 */
export function useStableTaskSource(source: TaskSourceContext): TaskSourceContext
/** For a link that may carry no source at all: null stays null instead of becoming a source. */
export function useStableTaskSource(source: TaskSourceContext | null): TaskSourceContext | null
export function useStableTaskSource(source: TaskSourceContext | null): TaskSourceContext | null {
  const held = useRef(source)
  if (!areTaskSourceContextsEqual(held.current, source)) {
    held.current = source
  }
  return held.current
}
