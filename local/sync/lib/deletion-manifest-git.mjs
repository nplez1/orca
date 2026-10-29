// The git half of the deletion manifest: which paths each side has, and the upstream blob each entry was
// judged against. Read-only: `ls-tree` and `rev-parse`, both answered null by run.mjs's gitText when the
// ref or path is absent, which is the answer the binding wants.
//
// Same split as fork-surface-git.mjs: the decision lives in a pure module (expected-deletions.mjs), the
// reads live here.
import { readDeletionManifest } from './expected-deletions.mjs'
import { gitText, readSyncState } from './run.mjs'
import { UPSTREAM_REF, mergePair } from './sync-range.mjs'

// null, not an empty set, when the ref does not resolve: "upstream has no files" would read every entry
// as prunable, and an unreadable tree is not evidence about any of them.
const tree = (ref) => {
  const listing = gitText(['ls-tree', '-r', '--name-only', ref])
  return listing === null ? null : new Set(listing.split('\n').filter(Boolean))
}

/**
 * The upstream tree the merge is bringing in. The merge itself is the authority — `MERGE_HEAD` mid-merge,
 * `HEAD^2` once committed — because a state file left by an earlier sync names an upstream that has since
 * moved, and binding an entry against that approves changes nobody reviewed. The recorded base is the
 * fallback for a rebase, where there is no merge commit to read.
 */
export function upstreamRef() {
  const pair = mergePair()
  if (pair !== null) {
    return pair.base
  }
  const recorded = readSyncState().state?.newBase
  if (recorded) {
    const resolved = gitText(['rev-parse', '--verify', '--quiet', `${recorded}^{commit}`])
    if (resolved) {
      return resolved
    }
  }
  return UPSTREAM_REF
}

/** `upstream` overrides the ref the binding is read against (`--merge-tree` knows its own other side). */
export function readDeletionManifestFromGit({ text, manifestPath, upstream = null }) {
  const ref = upstream ?? upstreamRef()
  return readDeletionManifest({
    text,
    manifestPath,
    presentAtHead: tree('HEAD') ?? new Set(),
    presentUpstream: tree(ref),
    upstreamBlobOf: (path) => gitText(['rev-parse', '--verify', '--quiet', `${ref}:${path}`])
  })
}
