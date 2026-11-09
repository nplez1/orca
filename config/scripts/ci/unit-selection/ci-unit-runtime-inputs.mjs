// Why one definition: "this file loads before every unit test" decides both which CI shards run and
// whether `local/open-pr.mjs` demands the full suite. Two answers to it is how a change to
// `src/main/runtime/rpc/orcad-feature-readiness.ts` — imported by a setup file, so loaded by every
// test worker — was classified targeted and skipped the gate (#316).
//
// Why a walk and not `buildUnitDependencyGraph`: the graph reads 34k sources (~8 s) and only this
// direction is needed, which is 46 files. Two edges of the graph are deliberately not walked, and
// neither can hide a file today: ownership-declared inputs (no record belongs to an entry point) and
// workspace `manifest` edges (those manifests live under `src/packages`, global by path already).
import { globSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkspaceSourceResolver } from '../../workspace/source-exports/workspace-source-exports.mjs'
import { isUnitRuntimeEntryPoint, RUNTIME_ENTRY_POINTS } from './ci-unit-selection.mjs'
import {
  unitImportCandidatePaths,
  unitLocalImportPath,
  unitSourceImports
} from './dependency-graph/ci-unit-dependency-graph.mjs'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

function toPosix(file) {
  return file.replaceAll('\\', '/')
}

// Why the glob on top of the constant: the entry-point pattern accepts harness files the constant
// does not list, and those load first too.
function runtimeEntryFiles({ root, has }) {
  const entries = new Set([
    ...RUNTIME_ENTRY_POINTS,
    ...globSync('config/scripts/**/vitest*.{ts,mjs}', { cwd: root }).map(toPosix)
  ])
  return [...entries].filter((file) => isUnitRuntimeEntryPoint(file) && has(file))
}

function walkRuntimeInputs({ root, has, read, entries }) {
  const workspace = createWorkspaceSourceResolver(root)
  const inputs = new Set()
  const queue = [...(entries ?? runtimeEntryFiles({ root, has }))]
  while (queue.length > 0) {
    const file = queue.pop()
    for (const specifier of unitSourceImports(read(file))) {
      const path = workspace.resolve(specifier)?.file ?? unitLocalImportPath(file, specifier)
      if (path === null) {
        continue
      }
      for (const candidate of unitImportCandidatePaths(path)) {
        if (!inputs.has(candidate) && has(candidate)) {
          inputs.add(candidate)
          queue.push(candidate)
        }
      }
    }
  }
  return inputs
}

// Why isFile: the empty resolution suffix makes a bare path a candidate, so a directory would
// otherwise be queued and then read as a file.
function isReadableFile(root, file) {
  try {
    return statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true
  } catch {
    // A candidate below a file (`x.mjs/index.ts`) is ENOTDIR, which `throwIfNoEntry` does not suppress.
    return false
  }
}

let defaultInputs = null

/**
 * Every source file a unit test worker loads before the test file: the transitive imports of the
 * runtime entry points. A change to any of them can break any test, so it is a global input.
 */
export function unitRuntimeInputs(options) {
  if (options === undefined) {
    defaultInputs ??= walkRuntimeInputs({
      root: ROOT,
      has: (file) => isReadableFile(ROOT, file),
      read: (file) => readFileSync(join(ROOT, file), 'utf8')
    })
    return defaultInputs
  }
  const root = options.root ?? ROOT
  return walkRuntimeInputs({
    root,
    entries: options.entries,
    has: options.has ?? ((file) => isReadableFile(root, file)),
    read: options.read ?? ((file) => readFileSync(join(root, file), 'utf8'))
  })
}
