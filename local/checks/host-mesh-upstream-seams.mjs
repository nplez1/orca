#!/usr/bin/env node
/**
 * Every line this feature adds to an upstream-owned file must be a line someone can resolve.
 *
 * Why this exists: the group needs a few hooks in upstream's tree — a method registry, a settings pane, a
 * launch script, a status-bar menu. Each one is a hunk an upstream sync has to reconcile, and a hunk with no
 * marker is one that gets resolved by guessing. So each carries `local(hosts)`, and this check fails when a
 * marked seam loses its marker, when an unlisted upstream file starts carrying the feature, or when a seam
 * grows past the line budget recorded here.
 *
 * Run: node local/checks/host-mesh-upstream-seams.mjs [--base <ref>]
 * Exit 0 means every seam is marked and within budget; 1 means the diff needs attention.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** The seams this feature is allowed to have, with the marker each must still carry and its line budget. */
const SEAMS = [
  {
    path: 'src/main/runtime/rpc/methods/rpc-method-registry.ts',
    budget: 2,
    why: 'one import, one spread'
  },
  {
    path: 'src/main/runtime/rpc/methods/host-mesh.ts',
    budget: 200,
    why: 'fork file, listed only as a guard'
  },
  {
    path: 'src/shared/remote-runtime/protocol/protocol-version.ts',
    budget: 3,
    why: 'the runtime capability it advertises'
  },
  {
    path: 'src/main/startup/runtime-startup/main-process-runtime-launch.ts',
    budget: 8,
    why: 'one import, one call, the lint line'
  },
  {
    path: 'src/main/ipc/runtime-environments/runtime-environment-connection-observation.ts',
    budget: 4,
    why: 'one import, one call'
  },
  {
    path: 'src/renderer/src/components/settings/runtime-environments/catalog/RuntimeEnvironmentsPane.tsx',
    budget: 4,
    why: 'one import, one element'
  },
  {
    path: 'src/renderer/src/components/status-bar/host-connections/SshStatusSegment.tsx',
    budget: 40,
    why: 'the relayed-fleet items, extracted to their own component'
  },
  { path: 'src/cli/hosts/host-handler-groups.ts', budget: 8, why: 'one import, one entry' },
  { path: 'src/cli/specs/index.ts', budget: 3, why: 'one import, one spread' },
  {
    path: 'src/cli/dispatch/remote-selection-scope.ts',
    budget: 4,
    why: 'one condition: a group is this host own membership'
  }
]

const MARKER = 'local(hosts)'

/**
 * Files this fork already owns in upstream's tree — extension points an earlier `local(...)` patch created, so
 * a change here conflicts with the fork's own work and never with upstream's.
 */
const FORK_OWNED = [
  // Regenerated from the params we add, never hand-edited: a sync resolves it by re-running codegen.
  'src/shared/rpc-contract/rpc-params-catalog.generated.ts',
  'src/main/ipc/register-fork-handlers.ts',
  'src/main/ipc/register-fork-handlers.test.ts',
  'src/preload/api/fork-preload-api.ts',
  'src/renderer/src/i18n/fork/en.json'
]
const base = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'origin/main'

const mergeBase = execFileSync('git', ['merge-base', 'HEAD', base], { encoding: 'utf8' }).trim()
const changed = execFileSync('git', ['diff', '--numstat', `${mergeBase}..HEAD`], {
  encoding: 'utf8'
})
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [added, removed, path] = line.split('\t')
    return { added: Number(added), removed: Number(removed), path }
  })

const failures = []

for (const entry of changed) {
  let existedUpstream = false
  try {
    execFileSync('git', ['cat-file', '-e', `${mergeBase}:${entry.path}`], { stdio: 'ignore' })
    existedUpstream = true
  } catch {
    existedUpstream = false
  }
  // A new file is fork-owned by construction: nothing upstream can conflict with it.
  if (!existedUpstream || entry.path === 'LOCAL-PATCHES.md' || FORK_OWNED.includes(entry.path)) {
    continue
  }
  const seam = SEAMS.find((candidate) => candidate.path === entry.path)
  if (seam === undefined) {
    failures.push(
      `${entry.path}: an upstream file this feature does not declare a seam for (+${entry.added}/-${entry.removed}).\n` +
        '  Either move the code into a fork-owned file, or add it to SEAMS here and to LOCAL-PATCHES.md.'
    )
    continue
  }
  const lines = entry.added + entry.removed
  if (lines > seam.budget) {
    failures.push(
      `${entry.path}: ${lines} lines against a budget of ${seam.budget} (${seam.why}).\n` +
        '  Upstream syncs pay for every one of these; move what you can into a fork-owned file.'
    )
  }
  const text = readFileSync(entry.path, 'utf8')
  if (!text.includes(MARKER)) {
    failures.push(
      `${entry.path}: no \`${MARKER}\` marker in the file.\n` +
        '  A seam with no marker is resolved by guessing. Put one on the line that adds it.'
    )
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n\n'))
  process.exit(1)
}
console.log(`host-mesh seams: ${SEAMS.length} declared, all marked and within budget`)
