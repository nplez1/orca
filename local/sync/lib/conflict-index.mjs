// What the merge will keep, as `proveFile`'s `moduleExists` oracle: `{ exists(path), workspaceSource,
// history }`.
// The oracles are pure (git output in); `workspaceSourceLookup` reads the worktree's package manifests.
import { createWorkspaceSourceResolver } from '../../../config/scripts/workspace/source-exports/workspace-source-exports.mjs'
import { providerHistory } from './conflict-provider-gate.mjs'

/**
 * `@orca/<pkg>[/<subpath>]` -> the repo path of its `orca-source` export, or null. Built from the
 * worktree's manifests; a manifest that does not parse (a conflicted package.json) maps nothing, so every
 * workspace import refuses rather than resolving against a half-merged manifest.
 */
export function workspaceSourceLookup(root) {
  let resolver
  try {
    resolver = createWorkspaceSourceResolver(root)
  } catch {
    return () => null
  }
  return (specifier) => {
    try {
      return resolver.resolve(specifier)?.file ?? null
    } catch {
      return null
    }
  }
}

/**
 * From `git ls-files -s -z`: a path the merge keeps has a stage-0 entry, or a conflict with both sides'
 * stages present. A modify/delete or a one-sided add is undecided, so it answers no and the prover
 * refuses a module path that points at it.
 */
export function indexModuleOracle(lsFilesStaged, workspaceSource = () => null, history = null) {
  const stages = new Map()
  for (const record of lsFilesStaged.split('\u0000')) {
    const match = /^\d+ [0-9a-f]+ (\d)\t(.*)$/s.exec(record)
    if (match) {
      const held = stages.get(match[2]) ?? new Set()
      held.add(match[1])
      stages.set(match[2], held)
    }
  }
  const exists = (path) => {
    const held = stages.get(path)
    return Boolean(held && (held.has('0') || (held.has('2') && held.has('3'))))
  }
  return { exists, workspaceSource, history }
}

/** The same answer for a `--merge-tree` run, from `git ls-tree -r -z --name-only <tree>`: less every conflict that is not UU. */
export function treeModuleOracle(lsTreeNames, files, workspaceSource = () => null, history = null) {
  const undecided = new Set(
    files.filter((file) => file.status !== null && file.status !== 'UU').map((file) => file.path)
  )
  const paths = new Set(lsTreeNames.split('\u0000').filter(Boolean))
  return { exists: (path) => paths.has(path) && !undecided.has(path), workspaceSource, history }
}

/**
 * The `history` the re-pointed-import check reads, from the three commits of the operation: trees,
 * blobs and each side's renames since base, each read once and only when a file first needs it.
 * `gitText(args, { allowFailure })` is the caller's git runner.
 */
export function gitProviderHistory(gitText, { base, ours, theirs }) {
  const cached = (make) => {
    let value
    return () => (value ??= make())
  }
  const commits = { base, ours, theirs }
  const tree = (commit) =>
    cached(
      () =>
        new Set(
          (gitText(['ls-tree', '-r', '-z', '--name-only', commit]) ?? '')
            .split('\u0000')
            .filter(Boolean)
        )
    )
  const renamed = (commit) =>
    cached(() => {
      const parts =
        // -l0: the default rename limit silently stops pairing past ~7,000 candidates, and an
        // upstream reorganisation is exactly that size; unpaired, a moved module reads as a swap.
        (
          gitText(['diff', '-z', '--name-status', '-M', '-l0', '--diff-filter=R', base, commit]) ??
          ''
        ).split('\u0000')
      const map = new Map()
      for (let index = 0; index + 2 < parts.length; index += 3) {
        map.set(parts[index + 1], parts[index + 2])
      }
      return map
    })
  const trees = { base: tree(base), ours: tree(ours), theirs: tree(theirs) }
  const renames = { ours: renamed(ours), theirs: renamed(theirs) }
  return providerHistory({
    files: {
      get base() {
        return trees.base()
      },
      get ours() {
        return trees.ours()
      },
      get theirs() {
        return trees.theirs()
      }
    },
    read: (side, path) => gitText(['show', `${commits[side]}:${path}`], { allowFailure: true }),
    renames: {
      get ours() {
        return renames.ours()
      },
      get theirs() {
        return renames.theirs()
      }
    }
  })
}
