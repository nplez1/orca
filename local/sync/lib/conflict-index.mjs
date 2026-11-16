// What the merge will keep, as `proveFile`'s `moduleExists` oracle: `{ exists(path), workspaceSource,
// history }`.
// The oracles are pure (git output in); `workspaceSourceLookup` reads the worktree's package manifests.
import { spawnSync } from 'node:child_process'
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
 * refuses a module path that points at it. `makeHistory(stagesAt)` builds the re-pointed-import
 * history over the same entries.
 */
export function indexModuleOracle(lsFilesStaged, workspaceSource = () => null, makeHistory = null) {
  const stages = new Map()
  for (const record of lsFilesStaged.split('\u0000')) {
    const match = /^\d+ ([0-9a-f]+) (\d)\t(.*)$/s.exec(record)
    if (match) {
      const held = stages.get(match[3]) ?? new Map()
      held.set(match[2], match[1])
      stages.set(match[3], held)
    }
  }
  const exists = (path) => {
    const held = stages.get(path)
    return Boolean(held && (held.has('0') || (held.has('2') && held.has('3'))))
  }
  // The history proves a move against the index's own entries, so it is built from them.
  const history = makeHistory ? makeHistory((path) => stages.get(path) ?? null) : null
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

/** `git diff -z --name-status -M --diff-filter=R` output -> Map of old path -> new path. */
export function parseRenames(z) {
  const parts = z.split('\u0000')
  const map = new Map()
  for (let index = 0; index + 2 < parts.length; index += 3) {
    if (/^R\d*$/.test(parts[index])) {
      map.set(parts[index + 1], parts[index + 2])
    }
  }
  return map
}

/**
 * `git cat-file --batch` over `<commit>:<path>` requests -> Map of path -> text (a missing object is
 * left out). One process for a whole closure level instead of one `git show` per file.
 */
export function catFileBatch(commit, paths) {
  const result = spawnSync('git', ['cat-file', '--batch'], {
    input: paths.map((path) => `${commit}:${path}\n`).join(''),
    maxBuffer: 1024 * 1024 * 1024
  })
  const out = result.stdout ?? Buffer.alloc(0)
  const texts = new Map()
  let offset = 0
  for (const path of paths) {
    const end = out.indexOf(0x0a, offset)
    if (end === -1) {
      break
    }
    const header = out.subarray(offset, end).toString('utf8').split(' ')
    offset = end + 1
    if (header[1] === 'missing' || header.length < 3) {
      continue
    }
    const size = Number(header[2])
    texts.set(path, out.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  return texts
}

/** `git ls-tree -r -z <commit>` output -> Map of path -> blob oid. */
export function parseTree(z) {
  const map = new Map()
  for (const record of z.split('\u0000')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(record)
    if (match) {
      map.set(match[2], match[1])
    }
  }
  return map
}

/**
 * The `history` the re-pointed-import check reads, from the three commits of the operation: trees,
 * blobs and each side's renames since base, each read once and only when a file first needs it.
 * `gitText(args, { allowFailure })` is the caller's git runner; `stagesAt(path)` the index's Map of
 * stage -> oid for a path (null without an index, which leaves no move provable).
 */
export function gitProviderHistory(gitText, { base, ours, theirs }, stagesAt = null) {
  const cached = (make) => {
    let value
    return () => (value ??= make())
  }
  const commits = { base, ours, theirs }
  const tree = (commit) => cached(() => parseTree(gitText(['ls-tree', '-r', '-z', commit]) ?? ''))
  // -l0: the default rename limit stopped pairing at 6,940 of the 2026-11-15 sync's 7,872 renames, and
  // an unpaired move reads as a swap.
  const renamed = (commit) =>
    cached(() =>
      parseRenames(
        gitText(['diff', '-z', '--name-status', '-M', '-l0', '--diff-filter=R', base, commit]) ?? ''
      )
    )
  const trees = { base: tree(base), ours: tree(ours), theirs: tree(theirs) }
  const renames = { ours: renamed(ours), theirs: renamed(theirs) }
  const lazy = (table) =>
    Object.defineProperties(
      {},
      Object.fromEntries(
        Object.keys(table).map((side) => [side, { get: () => table[side](), enumerable: true }])
      )
    )
  const history = providerHistory({
    files: lazy(trees),
    read: (side, path) => gitText(['show', `${commits[side]}:${path}`], { allowFailure: true }),
    renames: lazy(renames),
    prefetch: (side, paths) => catFileBatch(commits[side], paths),
    // The merge paired the move only if the index holds its result: a conflict whose base stage is the
    // old module and whose other-side stage is that side's copy, or a clean entry equal to the
    // three-way merge of exactly those blobs.
    carries: ({ now, old, other, taker }) => {
      const held = stagesAt?.(now)
      const baseOid = trees.base().get(old)
      const otherOid = trees[other]().get(history.renamedTo(other, old))
      const takerOid = trees[taker]().get(now)
      if (!held || !baseOid || !otherOid || !takerOid) {
        return false
      }
      if (held.has('1')) {
        return held.get('1') === baseOid && held.get(other === 'ours' ? '2' : '3') === otherOid
      }
      const [first, second] = taker === 'ours' ? [takerOid, otherOid] : [otherOid, takerOid]
      const merged = gitText(['merge-file', '--object-id', first, baseOid, second], {
        allowFailure: true
      })
      return merged !== null && held.get('0') === merged.trim()
    }
  })
  return history
}
