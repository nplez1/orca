// The post-sync row table, out of post-sync.mjs so a test can assert the wiring without executing the
// script (which spawns pnpm). Each row is `[id, title, look, run]`; the driver owns the report, the
// waiver handling and the exit code.
//
// `problem` is the reason the pre-sync tip does not belong to this sync. Every row that reads a range
// refuses with it rather than scanning the wrong one — that refusal is the point of the split, so a
// missing row here would be a check that silently passes on another sync's range.

import {
  TYPE_CHECK_COMMAND,
  conflictMarkers,
  localizationCatalog,
  repoLint,
  typecheck
} from './checks.mjs'
import { danglingForkReferences } from './dangling-references.mjs'
import { forkSymbolSurvival } from './fork-symbol-check.mjs'
import {
  FORK_SLUG,
  builderConfig,
  deletedForkModules,
  identitySweep,
  localizationVerifiers,
  lostContent,
  unreferencedForkModules,
  updaterFeed
} from './post-sync-checks.mjs'

/** The ids, in report order. Exported so `--waive` can be validated before any check runs. */
export function postSyncRowIds({ options } = {}) {
  return postSyncRows({ tip: null, source: null, problem: null, options: options ?? {} }).map(
    ([id]) => id
  )
}

export function postSyncRows({ tip, source, problem, options }) {
  return [
    [
      'conflict-markers',
      'no conflict markers',
      'each named file still carries a conflict; resolve it before pushing',
      () => conflictMarkers({ delegate: true })
    ],
    [
      'localization-catalog',
      'derived localization catalog regenerates to no diff',
      'commit the regenerated catalog; hand-merging a derived file is the failure this checks for',
      localizationCatalog
    ],
    [
      'localization-verifiers',
      'both localization verifiers pass',
      'the source catalog lost entries the derived file still expects',
      localizationVerifiers
    ],
    [
      'builder-config',
      'the fork builder config loads',
      'the fork patches this file; a clean merge into it was wrong',
      builderConfig
    ],
    [
      'updater-feed',
      `update feed still names ${FORK_SLUG}`,
      'without this, an update check resolves upstream releases and the fork ships a downgrade',
      updaterFeed
    ],
    [
      'identity-sweep',
      'fork identity sweep',
      'the named paths carry upstream identity (bundle id, app name, data dir) that the fork must own',
      identitySweep
    ],
    [
      'lost-content',
      'red-flag scan of files modified since the pre-sync tip',
      "diff each flagged file against the pre-sync tip and take the old tip's content where the replay dropped it",
      () => lostContent(tip, source, problem)
    ],
    [
      'deleted-fork-modules',
      'deleted fork-only modules, with the exported surface each one carried',
      'for each name listed as unreferenced, find the caller the deletion dropped and re-home it; "upstream supersedes this" is not a review',
      () => deletedForkModules(tip, source, problem)
    ],
    [
      'fork-symbol-survival',
      'fork-added names the merged file no longer declares',
      "the file survived the merge and the fork's function, constant or settings field inside it did not: re-home it, or acknowledge it under `symbols` in local/sync/expected-deletions.json",
      () => forkSymbolSurvival(tip, source, { problem })
    ],
    [
      'dangling-references',
      'fork-added references that name nothing at HEAD',
      'a rename or extract left an import, a vi.mock target or a path string pointing at a file that no longer exists; pnpm tc sees the TypeScript imports and nothing else',
      () => danglingForkReferences(tip, source, problem)
    ],
    [
      'unreferenced-fork-modules',
      'fork-only modules under src/ that nothing imports',
      'a fork module whose last caller upstream removed simply stops being read: delete it, or wire it in. Report-only, because deleting product code is a judgement',
      () => unreferencedForkModules()
    ],
    [
      'repo-lint',
      'repo-wide oxlint passes',
      'a merge resolved into a file that now breaks a repo-wide rule (max-lines is the usual one); split the file rather than bumping the cap',
      repoLint
    ],
    [
      'typecheck',
      `merged tip typechecks (${TYPE_CHECK_COMMAND})`,
      'pnpm tc found both semantic breaks of the previous sync that no conflict marker showed',
      () => typecheck(options)
    ]
  ]
}
