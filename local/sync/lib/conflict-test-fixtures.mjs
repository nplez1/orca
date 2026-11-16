// Conflict fixtures shared by the conflict-prove, file-gate and apply-proven tests. Not a test file.
import { parseConflictHunks } from './conflict-classify.mjs'
import { proveFile, reconstruct } from './conflict-prove.mjs'
import { providerHistory } from './conflict-provider-gate.mjs'

export const hunk = ({ ours, base, theirs }) => [
  '<<<<<<< ours',
  ...ours,
  ...(base === null ? [] : ['||||||| base', ...base]),
  '=======',
  ...theirs,
  '>>>>>>> theirs'
]
export const file = (...parts) => [...parts.flat(), ''].join('\n')

// A fixture has no clean-merged lines, so each side's reconstruction IS its index stage.
export const stagesOf = (merged) => {
  const hunks = parseConflictHunks(merged)
  const side = (name) => reconstruct(merged, hunks, name).text
  return { base: side('base'), ours: side('ours'), theirs: side('theirs') }
}
export const everyModule = () => true
export const proveWithIndex = (
  path,
  merged,
  moduleExists = everyModule,
  stages = stagesOf(merged)
) => proveFile({ path, merged, moduleExists, stages })

/** `history` over in-memory sides: `{ base: { path: text }, ours, theirs }`, renames base path -> side path. */
export const historyOf = (sides, renames = {}) =>
  providerHistory({
    files: Object.fromEntries(
      Object.entries(sides).map(([side, blobs]) => [side, new Set(Object.keys(blobs))])
    ),
    read: (side, path) => sides[side][path] ?? null,
    renames: { ours: new Map(renames.ours ?? []), theirs: new Map(renames.theirs ?? []) }
  })
