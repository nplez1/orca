import { useMemo } from 'react'

/**
 * The two line filters the add-note "+" overlay applies.
 *
 * `commentableLineSet` is null when the surface makes every line commentable, which is the worktree
 * diff tab's default. `gutterOccupiedLineSet` holds the lines a collapsed review thread already
 * draws a bubble on: those get the conversation instead of a second control in the same slot.
 */
export function useDiffCommentLineSets(
  commentableLineNumbers: readonly number[] | undefined,
  gutterOccupiedLineNumbers: readonly number[] | undefined
): { commentableLineSet: Set<number> | null; gutterOccupiedLineSet: ReadonlySet<number> } {
  // Key on the values, not the array identity: review surfaces re-fetch PR/MR file data on every
  // refresh and hand us a fresh-but-equal number[], which would otherwise churn every consumer.
  // Memoized on the array identity: the join walks every commentable line of the patch (thousands
  // on a large file) and every mounted diff row runs this hook on every render.
  const commentableLineKey = useMemo(
    () => commentableLineNumbers?.join(','),
    [commentableLineNumbers]
  )
  const commentableLineSet = useMemo(
    () => (commentableLineNumbers ? new Set(commentableLineNumbers) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commentableLineKey]
  )
  // Value-keyed for the same reason: a thread toggled anywhere hands every mounted surface a fresh
  // display map, and a new-but-equal array must not cost the overlay a push it does not need.
  const gutterOccupiedLineKey = useMemo(
    () => gutterOccupiedLineNumbers?.join(','),
    [gutterOccupiedLineNumbers]
  )
  const gutterOccupiedLineSet = useMemo(
    () => new Set(gutterOccupiedLineNumbers ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gutterOccupiedLineKey]
  )
  return { commentableLineSet, gutterOccupiedLineSet }
}
