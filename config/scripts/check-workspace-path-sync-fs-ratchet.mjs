import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

// Ratchet for synchronous `fs` probes on a workspace or repository path in Electron main.
//
// On a local SSD these finish in microseconds, so they look free. When the volume holding the repo
// stalls — an external drive waking up, a disk under heavy I/O, a network mount — one call blocks
// the main event loop for as long as the volume takes, freezing menus, input and terminal IPC for
// the whole app (issue #157: a 382s main-thread hang while every repo lived on one external volume).
// The async probes exist and are what these call sites should use; this gate keeps new ones out.
//
// Why lexical on the argument text: the hazard is the *path* an fs probe is handed, and which module
// a given identifier came from is not decidable without full type information. A workspace-ish
// identifier is the signal — `existsSync(worktreePath)` is the shape of every site this gate has
// found. Identifiers are split into camelCase segments, so `plan.validationCwd` and
// `resolveFloatingWorkspacePath(…)` count. Counted per file, so upstream sync line drift does not
// churn the baseline.
//
// Known limits, accepted so the gate stays cheap and unambiguous:
// - Only probes are counted, not `mkdirSync`/`writeFileSync`/`openSync`/`rmSync`. A write to a stalled
//   volume blocks just as long, but write sites are rarely on a workspace path and the baseline for
//   them would be noise rather than a ratchet.
// - An argument named for something else is invisible: `existsSync(path)`, `statSync(dotGit)`, and
//   the `pathA`/`pathB` pair in `src/main/ipc/filesystem-path-containment.ts` all reach a workspace
//   path this gate cannot see. Those sites are listed in the PR that added this gate, not counted.
// - `const p = repo.path; existsSync(p)` is not traced through the local variable.
// - App-data folders that happen to use one of the words (Orca's managed runtime folder) are
//   grandfathered in the baseline with a note rather than filtered by a word list nobody keeps
//   current.
// - Callbacks run in the daemon or a worker rather than Electron main are counted the same way; they
//   share this source tree. Fixing them is wanted, but not every row blocks a window.

const BASELINE_PATH = 'config/workspace-path-sync-fs-baseline.txt'
const SCAN_DIRECTORIES = ['src/main']
const SCAN_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs']

/** Synchronous fs calls that probe a path and return before the volume answers. */
export const GATED_CALLS = new Set([
  'existsSync',
  'statSync',
  'lstatSync',
  'realpathSync',
  'accessSync',
  'readdirSync',
  'opendirSync',
  'readFileSync'
])

/** Words that name a workspace or repository in this codebase, in every spelling it uses. */
const WORKSPACE_SEGMENTS = new Set([
  'worktree',
  'worktrees',
  'workspace',
  'workspaces',
  'repo',
  'repos',
  'repository',
  'repositories',
  'project',
  'projects',
  'folder',
  'folders',
  'checkout',
  'checkouts',
  'clone',
  'clones',
  'cwd'
])

/** A camelCase segment that turns the word before it into a path: `worktreePath`, `reposDir`. */
const PATH_SEGMENTS = new Set([
  'path',
  'paths',
  'root',
  'roots',
  'dir',
  'dirs',
  'directory',
  'directories',
  'file',
  'files',
  'location',
  'locations'
])

const FIX = [
  'A synchronous fs probe on a workspace path freezes every Orca window while the volume answers.',
  'Use the async probe (`node:fs/promises`) and await it, or have the caller pass a resolved value.',
  'If the call genuinely cannot await, memoize the answer for the session instead of re-probing.',
  `With reviewer sign-off for an unavoidable exception, add the row to ${BASELINE_PATH}.`
]

function isScannedSource(file) {
  return (
    /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) &&
    SCAN_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`)) &&
    !file.endsWith('.d.ts') &&
    !isTestOnlySourcePath(file)
  )
}

function segmentsOf(identifier) {
  return identifier.split(/(?<=[a-z0-9])(?=[A-Z])|_/)
}

/**
 * Whether an argument expression names a workspace or repository path: a workspace word that stands
 * on its own (`repo.path`, `cwd`) or heads a path segment (`worktreePath`, `plan.validationCwd`).
 * Record ids and config maps (`workspaceId`, `projectMap`) do not count.
 */
export function mentionsWorkspacePath(argumentText) {
  for (const identifier of argumentText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    const segments = segmentsOf(identifier)
    for (let index = 0; index < segments.length; index += 1) {
      if (!WORKSPACE_SEGMENTS.has(segments[index].toLowerCase())) {
        continue
      }
      const next = segments[index + 1]?.toLowerCase()
      if (next === undefined || PATH_SEGMENTS.has(next)) {
        return true
      }
    }
  }
  return false
}

/** The callee name when `node` is one of the gated fs probes, including `realpathSync.native`. */
function gatedCallee(node) {
  const callee = node.expression
  if (ts.isIdentifier(callee)) {
    return GATED_CALLS.has(callee.text) ? callee.text : null
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text
    if (GATED_CALLS.has(name)) {
      return name
    }
    // Why: `realpathSync.native(path)` names the probe one level out.
    if (name === 'native' && ts.isIdentifier(callee.expression)) {
      return GATED_CALLS.has(callee.expression.text) ? callee.expression.text : null
    }
  }
  return null
}

/**
 * Gated calls in one file whose first argument spells a workspace or repository path.
 * Returns `[{ line, call, argument }]`, so callers can report and count them.
 */
export function collectWorkspacePathSyncFsCalls(file, contents) {
  // A file whose text never spells a gated name cannot call one; skipping the full parse is what
  // keeps this gate under a second over src/main. A name written only as an escape is not scanned.
  const analyze = [...GATED_CALLS].some((name) => contents.includes(name))
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, analyze)
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`Cannot parse ${file}; the workspace-path sync-fs ratchet must not skip it.`)
  }
  if (!analyze) {
    return []
  }
  const found = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const call = gatedCallee(node)
      const argument = node.arguments[0]
      if (call && argument) {
        const text = argument.getText(source)
        if (mentionsWorkspacePath(text)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          found.push({ line: line + 1, call, argument: text })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Per-file count of gated calls, for the shared count-ratchet gate. */
export function collectWorkspacePathSyncFsCounts(sources) {
  const counts = new Map()
  for (const [file, contents] of sources) {
    const calls = collectWorkspacePathSyncFsCalls(file, contents)
    if (calls.length > 0) {
      counts.set(file, calls.length)
    }
  }
  return counts
}

export function collectWorkspacePathSyncFsBaseline(root = process.cwd()) {
  return collectWorkspacePathSyncFsCounts(
    // Why both spellings: git's `**/` needs at least one directory level, so a module that sits
    // directly in a scanned directory would otherwise never be read.
    readTrackedSources(
      root,
      SCAN_DIRECTORIES.flatMap((directory) =>
        SCAN_EXTENSIONS.flatMap((extension) => [
          `${directory}/*.${extension}`,
          `${directory}/**/*.${extension}`
        ])
      ),
      isScannedSource
    )
  )
}

export const BASELINE_HEADER = [
  '# Synchronous fs probes on a workspace or repository path, per file, in production src/main.',
  '# Each one blocks the main event loop for as long as the repo volume takes to answer: on a',
  '# stalled external drive or network mount every Orca window freezes until it does (issue #157).',
  '# This is a RATCHET: counts may only go DOWN. Remove the sync probe, do not raise the row.',
  '# Prune after fixing one: pnpm check:workspace-path-sync-fs-ratchet --prune',
  '# Detection is lexical (see the script): an argument named something else is invisible to it, and',
  '# sync writes are out of scope. Rows below that say "app data" are not workspace paths at all.'
]

const RATCHET = {
  name: 'workspace-path-sync-fs',
  baselinePath: BASELINE_PATH,
  header: BASELINE_HEADER,
  collect: collectWorkspacePathSyncFsBaseline,
  fix: FIX,
  unit: 'sync workspace-path fs probe(s)'
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(RATCHET, root, arg)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
