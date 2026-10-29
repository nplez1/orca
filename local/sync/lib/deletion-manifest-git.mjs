// The git half of the deletion manifest: which paths each side has, and the upstream blob each entry was
// judged against. Read-only: `ls-tree` and `rev-parse`, both answered null by run.mjs's gitText when the
// ref or path is absent, which is the answer the binding wants.
//
// Same split as fork-surface-git.mjs: the decision lives in a pure module (expected-deletions.mjs), the
// reads live here.
import { readDeletionManifest } from './expected-deletions.mjs'
import { gitText, readSyncState } from './run.mjs'
import { UPSTREAM_REF } from './sync-range.mjs'

const tree = (ref) =>
  new Set((gitText(['ls-tree', '-r', '--name-only', ref]) ?? '').split('\n').filter(Boolean))

/** The upstream tree a merge brings in: the state file's new base, else the tracked upstream ref. */
export function upstreamRef() {
  return readSyncState().state?.newBase ?? UPSTREAM_REF
}

export function readDeletionManifestFromGit({ text, manifestPath }) {
  const upstream = upstreamRef()
  return readDeletionManifest({
    text,
    manifestPath,
    presentAtHead: tree('HEAD'),
    presentUpstream: tree(upstream),
    upstreamBlobOf: (path) => gitText(['rev-parse', '--verify', '--quiet', `${upstream}:${path}`])
  })
}
