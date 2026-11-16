// What the merge will keep, as `proveFile`'s `moduleExists` oracle. Pure: git output in, a predicate out.

/**
 * From `git ls-files -s -z`: a path the merge keeps has a stage-0 entry, or a conflict with both sides'
 * stages present. A modify/delete or a one-sided add is undecided, so it answers no and the prover
 * refuses a module path that points at it.
 */
export function indexModuleOracle(lsFilesStaged) {
  const stages = new Map()
  for (const record of lsFilesStaged.split('\u0000')) {
    const match = /^\d+ [0-9a-f]+ (\d)\t(.*)$/s.exec(record)
    if (match) {
      const held = stages.get(match[2]) ?? new Set()
      held.add(match[1])
      stages.set(match[2], held)
    }
  }
  return (path) => {
    const held = stages.get(path)
    return Boolean(held && (held.has('0') || (held.has('2') && held.has('3'))))
  }
}

/** The same answer for a `--merge-tree` run, from `git ls-tree -r -z --name-only <tree>`: less every conflict that is not UU. */
export function treeModuleOracle(lsTreeNames, files) {
  const undecided = new Set(
    files.filter((file) => file.status !== null && file.status !== 'UU').map((file) => file.path)
  )
  const paths = new Set(lsTreeNames.split('\u0000').filter(Boolean))
  return (path) => paths.has(path) && !undecided.has(path)
}
