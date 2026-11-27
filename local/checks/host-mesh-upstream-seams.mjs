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
 * Why an undeclared upstream file is a note for another feature and a red for this one: this register governs
 * ONE feature's surface, and `local/gate-lint.mjs` runs it on every pull request. Failing on any upstream-owned
 * file a diff touches made the lint gate red for every branch that fixes an upstream bug — #471's workspace fix
 * touches eight such files and is not the host group at all. So the refusal is scoped to a diff that touches the
 * feature's own files (a `host-mesh` or `host-graph` path upstream does not have), which is the only evidence
 * available that this is hosts work: such a diff still reds on an upstream file it has not declared, which is the
 * sprawl this check exists to catch, while another feature's upstream edits are reported as notes. `--strict`
 * forces that red for a diff carrying no feature file of its own (a seam-only fix), a sync never derives it — its
 * diff is upstream's own work — and the budget of a declared seam fails hard either way.
 *
 * Usage: node local/checks/host-mesh-upstream-seams.mjs [--base <ref>] [--strict] [--quiet]
 * Exit: 0 pass, 1 a declared seam outgrew its budget, or an undeclared upstream file was touched by this feature's
 * own diff (or under --strict); 2 the base or the upstream ruler could not be resolved here — a clone that cannot
 * answer must not pass.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { resolvePullRequestDiffBase } from '../../config/scripts/git/pr-diff-base/git-pull-request-diff-base.mjs'
import {
  SYNC_BASE_RECORD,
  commitExists,
  commitHasPath,
  fetchCommandFor,
  readRecordedSyncBase
} from '../lib/upstream-sync-base.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
/** The fork's own trunk, in the order a clone is likely to carry it. Never upstream's, which is not the base. */
const DIFF_BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'main']

/**
 * Every upstream-owned file this feature may touch, the lines it may add or remove in total, and why.
 * A decimal budget is not allowed to be casually raised: it is a measurement of what the hook needs, and
 * anything above it belongs in a fork-owned module behind a one-line call.
 */
export const SEAMS = [
  {
    path: 'config/react-compiler-bailout-baseline.txt',
    budget: 2,
    why: 'one line of the fork-owned bailout baseline, pruned by the ratchet when this feature’s own hook stopped bailing out; the ratchet refuses to leave an improved row recorded'
  },
  {
    path: 'src/main/runtime/rpc/server/pairing/pairing-offer-requests.ts',
    budget: 9,
    why: 'one `fresh` and one `offerTtlMs` argument on the runtime-offer path and their pass-through: upstream reuses one unused pending offer per (grants, creator), so a mesh pass that mints for two machines would hand both the same device row — one identity, and ejecting either one would cut the other’s link for good'
  },
  {
    path: 'src/main/runtime/rpc/server/runtime-rpc-pairing.ts',
    budget: 10,
    why: 'one `fresh` argument and one branch choosing `addDevice` over the reuse paths, which is the same device-row rule at the registry boundary'
  },
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
    path: 'src/main/ipc/mobile.ts',
    budget: 3,
    why: 'one import and one predicate in the runtime-grant list: an offer past its TTL can pair nothing, and this feature mints one per reverse offer, so an expired row is not a link; the predicate itself is fork-owned (`host-mesh-runtime-grants.ts`)'
  },
  {
    path: 'src/renderer/src/components/settings/runtime-environments/catalog/RuntimeEnvironmentsPane.tsx',
    budget: 3,
    why: 'one import and one <HostGroupSection /> element'
  },
  {
    path: 'src/renderer/src/components/settings/runtime-environments/server-rows/runtime-server-row-menu.tsx',
    budget: 3,
    why: 'one optional `meshItems` slot beside the other row actions, so a member’s Rename and Eject sit in the host’s own overflow menu instead of two ghost buttons beside its status'
  },
  {
    path: 'src/renderer/src/components/settings/runtime-environments/server-rows/runtime-server-row.tsx',
    budget: 3,
    why: 'one import, one <MeshMemberAffordance /> in the chips slot and one `meshItems` slot on the row menu — the chip, both actions and both dialogs are fork-owned, so a host row carries its mesh state and its Eject instead of the pane repeating every host in a second list'
  },
  {
    path: 'src/renderer/src/components/settings/host-rows/ServerListRow.tsx',
    budget: 2,
    why: '`py-px` and `leading-4` off upstream’s chip, so a Mesh, Default or SSH-tunnel chip sits at label height beside the row’s name instead of taller than it'
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
  },
  {
    path: 'src/shared/remote-runtime/host-store/runtime-environment-store-operations.ts',
    budget: 7,
    why: 'one re-export of the fork-owned runtime-environment-rename module, so the store’s command channel keeps one operations surface; the rename itself lives in the fork-owned file'
  },
  {
    path: 'src/shared/remote-runtime/host-store/runtime-environment-store-command.ts',
    budget: 2,
    why: 'one command case, because every environment-store write is dispatched through this switch and a fork operation cannot be reached without one'
  },
  {
    path: 'src/shared/remote-runtime/host-store/runtime-environment-store-worker-protocol.ts',
    budget: 2,
    why: 'one request variant and one success variant, the typed pair the switch above is checked against'
  },
  {
    path: 'src/shared/remote-runtime/host-store/runtime-environment-store.ts',
    budget: 10,
    why: 'one async facade wrapper, so main calls the rename through the worker instead of touching the file itself'
  },
  {
    path: 'src/renderer/src/components/status-bar/host-connections/RuntimeHostStatusRow.tsx',
    budget: 10,
    why: 'one import, one optional meshStatus prop and the glyph beside the name: the row is upstream’s, and the icon component, the hook and the status mapping are fork-owned files'
  },
  {
    path: 'config/main-blocking-helper-baseline.txt',
    budget: 1,
    why: 'one baseline row for the fork-owned rename operation’s single store write; the ratchet charges the module that calls the helper, so the row has to live in upstream’s file'
  },
  {
    path: 'config/zod-prefer-lazy-baseline.txt',
    budget: 1,
    why: 'one baseline row removed, not added: the 2026-11-27 sync wrapped this feature’s params files in lazyZodSchema, so the ratchet’s prune had to rewrite upstream’s file'
  },
  {
    path: 'src/shared/rpc-contract/jira/jira-params.ts',
    budget: 32,
    why: 'the 2026-11-27 sync’s lazyZodSchema pass over this feature’s Jira params: the schemas were re-wrapped as upstream writes them after the merge rebuilt them eagerly, and `ListIssuesFields` became a schema. Measured lines added by that pass; the params themselves were not new'
  },
  {
    path: 'src/shared/rpc-contract/github/github-account-binding-params.ts',
    budget: 21,
    why: 'the same lazyZodSchema pass: both `RepoSelector.extend(...)` calls are wrapped, which also drops the file’s last eager schema'
  },
  {
    path: 'src/shared/rpc-contract/projects/repo-params.ts',
    budget: 12,
    why: 'the same lazyZodSchema pass over this feature’s repo params, where the host-graph selectors are declared'
  },
  {
    path: 'src/main/rate-limits/providers/claude/claude-oauth-credentials.ts',
    budget: 18,
    why: 'the same lazyZodSchema pass: the fork’s settings-env credential source is a wrapped schema now, so the wrapper and its import are fork lines on upstream’s file'
  },
  {
    path: 'src/main/ai-vault/listing/session-list-result-validation.ts',
    budget: 2,
    why: 'the same lazyZodSchema pass: one import and one wrapper around the AI Vault paging schema the fork extended'
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

function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/** A probe whose failure is an answer (a clone without the ref), with git's stderr silenced. */
function gitOrNull(args, root = ROOT) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

/**
 * The tree that decides whether a path is upstream's: `upstream/main` where this clone has it, else the
 * upstream commit the sync baseline records — the same fallback `check-upstream-file-comments` makes, so a
 * CI checkout with no upstream remote measures the files a laptop does. A fork ref is never the ruler: every
 * path exists at the fork's main, so the rule would check nothing.
 */
export function resolveUpstreamRuler(root = ROOT) {
  const tip = gitOrNull(['rev-parse', '--verify', 'upstream/main^{commit}'], root)
  if (tip) {
    return tip
  }
  const recorded = readRecordedSyncBase(root)
  if (recorded && commitExists(root, recorded)) {
    return recorded
  }
  throw new Error(
    recorded
      ? `the recorded sync base ${recorded} is not in this clone — ${fetchCommandFor(recorded)}`
      : 'no upstream/main and no recorded sync base — add the upstream remote, or record one in local/upstream-file-comments-baseline.json'
  )
}

/**
 * The commit the surface is measured from. Why not just `--base`: a pull request checks out the merge commit
 * and fetches no branch ref, so `origin/main` does not exist there and its first parent is the base the change
 * is reviewed against (#466).
 */
export function resolveBase(argv, root = ROOT) {
  const index = argv.indexOf('--base')
  const requested = index === -1 ? 'origin/main' : (argv[index + 1] ?? 'origin/main')
  const pullRequestBase = resolvePullRequestDiffBase(root, null)
  if (pullRequestBase) {
    return pullRequestBase
  }
  for (const candidate of [requested, ...DIFF_BASE_CANDIDATES]) {
    const commit = candidate
      ? gitOrNull(['rev-parse', '--verify', `${candidate}^{commit}`], root)
      : null
    if (commit) {
      return git(['merge-base', 'HEAD', commit], root).trim()
    }
  }
  throw new Error(
    `none of ${[requested, ...DIFF_BASE_CANDIDATES].join(', ')} resolves here — fetch one or pass --base <ref>`
  )
}

/** The merged surface, per upstream-owned file, as `{ path, lines }`. */
export function measureSurface(base, root = ROOT) {
  const ruler = resolveUpstreamRuler(root)
  const rows = git(['diff', '--numstat', `${base}..HEAD`], root)
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
    // A `.fork.txt` overlay is this fork's own baseline row, wherever it sits.
    if (
      entry.path.startsWith('local/') ||
      entry.path.endsWith('.fork.txt') ||
      NOT_UPSTREAM.has(entry.path)
    ) {
      continue
    }
    // Ownership is decided by upstream's own tree, not by the diff base: a file an earlier fork patch added
    // exists at the fork's main and would otherwise be miscounted as upstream's, which is how a fork file
    // ends up needing a seam declaration for its own edit.
    if (!commitHasPath(root, ruler, entry.path)) {
      continue
    }
    touched.push({ path: entry.path, lines: entry.added + entry.removed })
  }
  return touched
}

/**
 * The feature's own path segment. A diff touching one of these is that feature's PR — its fork-owned code is what
 * tells it apart from a branch fixing an upstream bug — so an upstream file such a diff does not declare is the
 * sprawl this register exists to catch. `host-groups` (upstream's own file name) does not match: the segment ends
 * the name or is followed by a separator.
 */
const FEATURE_SEGMENT = /(?:^|[/\\])(?:host-mesh|host-graph|host-group)(?:$|[-./\\])/

/** Every path the diff changes, before the upstream-ownership filter — the feature's own files are fork-owned. */
export function changedPaths(base, root = ROOT) {
  return git(['diff', '--name-only', `${base}..HEAD`], root)
    .trim()
    .split('\n')
    .filter(Boolean)
}

/** Whether a changed path is one of this feature's own files, which upstream's tree answers: absent there, ours. */
export function isFeaturePath(changed, isUpstreamOwned) {
  // `local/` is the fork's own ledgers — this register and its design note — not code the feature ships, and
  // measureSurface skips it, so judging strictness by it could only add reds no seam could ever satisfy.
  return !changed.startsWith('local/') && FEATURE_SEGMENT.test(changed) && !isUpstreamOwned(changed)
}

/**
 * Whether a diff is this feature's own work, which is what makes an undeclared upstream file a red rather than a
 * note. `--strict` overrides it for a diff carrying no feature file of its own (a seam-only change), and a sync
 * never derives it: a sync's diff is upstream's own work, so the feature's files inside it say nothing about what
 * this feature declares.
 */
export function resolveStrict(paths, { strictFlag = false, isUpstreamOwned = () => false } = {}) {
  if (strictFlag) {
    return true
  }
  if (paths.includes(SYNC_BASE_RECORD)) {
    return false
  }
  return paths.some((changed) => isFeaturePath(changed, isUpstreamOwned))
}

/** Every way the surface can be wrong, as lines to print, and the undeclared files it only reports. */
export function auditSurface(touched, { strict = false } = {}) {
  const declared = new Map(SEAMS.map((seam) => [seam.path, seam]))
  const problems = []
  const notes = []
  for (const entry of touched) {
    const seam = declared.get(entry.path)
    if (seam === undefined) {
      const line = `${entry.path}: an upstream file this register does not declare (${entry.lines} line(s)).`
      if (strict) {
        problems.push(
          `${line}\n  Move the code into a fork-owned file, or declare the seam here and in LOCAL-PATCHES.md.`
        )
      } else {
        notes.push(line)
      }
      continue
    }
    if (entry.lines > seam.budget) {
      // Why this shape: `local/gate-lint.mjs` attributes a step's failure to a file only when the step
      // prints `::error file=<path>::<text>`, and without it the only entry that can cover a red here is
      // a whole-step one, which would also hide a new file's breach.
      problems.push(
        `::error file=${entry.path}::${entry.lines} line(s) against a budget of ${seam.budget} — ${seam.why}.\n` +
          '  Every one of these is a hunk an upstream sync pays for; put what grew behind a fork-owned module.'
      )
    }
  }
  return { problems, notes }
}

function main(argv) {
  const verbose = !argv.includes('--quiet')
  let base
  let touched
  let strict
  try {
    base = resolveBase(argv)
    touched = measureSurface(base)
    const ruler = resolveUpstreamRuler()
    strict = resolveStrict(changedPaths(base), {
      strictFlag: argv.includes('--strict'),
      isUpstreamOwned: (changed) => commitHasPath(ROOT, ruler, changed)
    })
  } catch (error) {
    // Why an exit code and one line: a gate that cannot resolve its ruler must say so, not print a stack
    // whose last line is the only thing the lint gate's summary can quote.
    console.error(`host-mesh seams: ${error.message}`)
    process.exit(2)
  }
  const { problems, notes } = auditSurface(touched, { strict })
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
      `host-mesh seams: ${touched.length} upstream file(s), ${total} line(s), every declared seam within budget` +
        `${strict ? ' (undeclared files counted as reds)' : ''}`
    )
    for (const entry of touched) {
      const seam = SEAMS.find((candidate) => candidate.path === entry.path)
      if (seam === undefined) {
        continue
      }
      console.log(`  ${String(entry.lines).padStart(3)}/${seam.budget}  ${entry.path}`)
    }
    for (const note of notes) {
      console.log(`  note: ${note}`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
}
