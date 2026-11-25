#!/usr/bin/env node
/**
 * The register of every upstream line this feature costs, and a check that it stays that small.
 *
 * Why this exists: the host group needs a few hooks in upstream's tree — a method registry, a settings pane,
 * a launch script, a status-bar menu. Each one is a hunk an upstream sync has to reconcile, so each is listed
 * here with the exact number of lines it is allowed to add, and this check fails when the surface grows.
 *
 * Why there are no `local(hosts)` markers in the code: `local/check-upstream-file-comments.mjs` forbids fork
 * comments in upstream-owned files, on measured evidence — 162 of the 233 conflicts in the 2026-10-28 sync came
 * from exactly that. A rationale paragraph above upstream's code is conflict adjacency and nothing else, so the
 * register lives here and in `LOCAL-PATCHES.md`, where nothing upstream can collide with it.
 *
 * Why a budget rather than a hard zero: some of these seams cannot be avoided — a method registry needs its
 * spread, a pane needs its element, a launch script needs its call. The budget says how much is unavoidable,
 * measured, so the next person adding one to a fork-owned file instead is the easy path and adding it here is
 * the deliberate one.
 *
 * Usage: node local/checks/host-mesh-upstream-seams.mjs [--base <ref>] [--quiet]
 * Exit: 0 pass, 1 the surface grew or an undeclared upstream file is touched.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')

/**
 * Every upstream-owned file this feature may touch, the lines it may add or remove in total, and why.
 * A decimal budget is not allowed to be casually raised: it is a measurement of what the hook needs, and
 * anything above it belongs in a fork-owned module behind a one-line call.
 */
export const SEAMS = [
  {
    path: 'src/main/runtime/rpc/methods/rpc-method-registry.ts',
    budget: 2,
    why: 'one import and one spread of FORK_RPC_METHODS, which aggregates this fork’s methods'
  },
  {
    path: 'src/shared/remote-runtime/protocol/protocol-version.ts',
    budget: 2,
    why: 'one import and one entry: the runtime capability peers negotiate the fleet with'
  },
  {
    path: 'src/main/startup/runtime-startup/main-process-runtime-launch.ts',
    budget: 3,
    why: 'one import, one installHostMeshRuntime call, and the max-lines directive upstream’s length forces'
  },
  {
    path: 'src/main/ipc/runtime-environments/runtime-environment-connection-observation.ts',
    budget: 2,
    why: 'one import and one call telling the fleet a connection changed'
  },
  {
    path: 'src/renderer/src/components/settings/runtime-environments/catalog/RuntimeEnvironmentsPane.tsx',
    budget: 3,
    why: 'one import and one <HostGroupSection /> element'
  },
  {
    path: 'src/renderer/src/components/status-bar/host-connections/SshStatusSegment.tsx',
    budget: 21,
    why: 'the relayed-fleet block, extracted into RelayedFleetStatusItems; what remains is its call site, the hook, and two counts'
  },
  {
    path: 'src/cli/hosts/host-handler-groups.ts',
    budget: 6,
    why: 'one import and one manifest entry, with the entry itself defined in host-mesh-handler-group.ts'
  },
  {
    path: 'src/cli/specs/index.ts',
    budget: 2,
    why: 'one import and one spread of the group commands'
  },
  {
    path: 'src/cli/dispatch/remote-selection-scope.ts',
    budget: 2,
    why: 'one condition: a group is this host’s own membership, so remote routing would report another host'
  }
]

/**
 * Files this fork already owns in upstream's tree, plus the generated catalog. A change to one of these
 * conflicts with this fork's own patches, never with upstream's, and the catalog is resolved by re-running
 * codegen rather than by hand.
 */
const NOT_UPSTREAM = new Set([
  'LOCAL-PATCHES.md',
  'src/main/ipc/register-fork-handlers.ts',
  'src/main/ipc/register-fork-handlers.test.ts',
  'src/preload/api/fork-preload-api.ts',
  'src/renderer/src/i18n/fork/en.json',
  'src/shared/rpc-contract/rpc-params-catalog.generated.ts'
])

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

/** Whether the merge base has this path, without letting git's "does not exist" reach the terminal. */
function existsAt(mergeBase, filePath) {
  try {
    execFileSync('git', ['cat-file', '-e', `${mergeBase}:${filePath}`], {
      cwd: ROOT,
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

export function resolveBase(argv) {
  const index = argv.indexOf('--base')
  if (index === -1) {
    return 'origin/main'
  }
  return argv[index + 1] ?? 'origin/main'
}

/** The merged surface, per upstream-owned file, as `{ path, lines }`. */
export function measureSurface(base) {
  const mergeBase = git(['merge-base', 'HEAD', base]).trim()
  const rows = git(['diff', '--numstat', `${mergeBase}..HEAD`])
    .trim()
    .split('\n')
    .filter(Boolean)
  const changed = rows.map((row) => {
    const [added, removed, filePath] = row.split('\t')
    return { added: Number(added), removed: Number(removed), path: filePath }
  })
  const touched = []
  for (const entry of changed) {
    // `local/` and the fork's own ledgers are this fork's files, whether or not a fork commit put them there.
    if (entry.path.startsWith('local/') || NOT_UPSTREAM.has(entry.path)) {
      continue
    }
    // A file upstream does not have is fork-owned by construction: nothing there can conflict.
    if (!existsAt(mergeBase, entry.path)) {
      continue
    }
    touched.push({ path: entry.path, lines: entry.added + entry.removed })
  }
  return touched
}

/** Every way the surface can be wrong, as lines to print. */
export function auditSurface(touched) {
  const declared = new Map(SEAMS.map((seam) => [seam.path, seam]))
  const problems = []
  for (const entry of touched) {
    const seam = declared.get(entry.path)
    if (seam === undefined) {
      problems.push(
        `${entry.path}: an upstream file this feature has no declared seam for (${entry.lines} line(s)).\n` +
          '  Move the code into a fork-owned file, or declare the seam here and in LOCAL-PATCHES.md.'
      )
      continue
    }
    if (entry.lines > seam.budget) {
      problems.push(
        `${entry.path}: ${entry.lines} line(s) against a budget of ${seam.budget} — ${seam.why}.\n` +
          '  Every one of these is a hunk an upstream sync pays for; put what grew behind a fork-owned module.'
      )
    }
  }
  return problems
}

function main(argv) {
  const verbose = !argv.includes('--quiet')
  const touched = measureSurface(resolveBase(argv))
  const problems = auditSurface(touched)
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem)
      console.error('')
    }
    process.exit(1)
  }
  if (verbose) {
    const total = touched.reduce((sum, entry) => sum + entry.lines, 0)
    console.log(
      `host-mesh seams: ${touched.length} upstream file(s), ${total} line(s) — all declared and within budget`
    )
    for (const entry of touched) {
      const seam = SEAMS.find((candidate) => candidate.path === entry.path)
      console.log(`  ${String(entry.lines).padStart(3)}/${seam.budget}  ${entry.path}`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
}
