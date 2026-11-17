// Writing a review packet: the patch, the slices, and one rendered prompt per slice.
//
// Why the git dir and never /tmp: in the 2026-11-15 review four of six slices failed first time
// because the reviewer's sandbox refused /tmp, and /tmp is shared by every agent on the machine
// (AGENTS.md § unique /tmp names). The packet lives under this worktree's own git dir, which nothing
// else writes and which the runner hands the reviewer with `--add-dir`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { REVIEWER } from '../pr-body-claims.mjs'
import { EXCLUSIONS, partitionEntries } from './exclusions.mjs'
import { parsePatch, planSlices } from './slices.mjs'
import { outputPaths } from './verdict.mjs'

const TEMPLATES = join(import.meta.dirname, 'templates')
/** ~100k tokens of patch: one slice a reviewer can read whole, with room left to read the tree. */
export const DEFAULT_BUDGET_KB = 384

export const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 })

export function renderTemplate(text, vars) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    // Why a throw: a prompt that reaches the reviewer with a literal `{{SLICE_PATCH}}` costs a
    // slice run and reads as a real answer about nothing.
    if (!(key in vars)) {
      throw new Error(`template placeholder {{${key}}} has no value`)
    }
    return String(vars[key])
  })
}

const template = (name) => readFileSync(join(TEMPLATES, name), 'utf8')
const full = (root, ref) => git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
const short = (sha) => sha.slice(0, 12)
const shown = (root, path) => {
  const rel = relative(root, path)
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

export const packetRoot = (root) =>
  join(git(root, ['rev-parse', '--absolute-git-dir']).trim(), 'orca-review')

/** HEAD's sync: the newest merge on HEAD's first-parent line. */
export function headSyncMerge(root) {
  return git(root, ['rev-list', '--first-parent', '--merges', '-n', '1', 'HEAD']).trim() || null
}

export const syncPacketDir = (root, merge) => join(packetRoot(root), `sync-${short(merge)}`)

export const loadPacket = (dir) => JSON.parse(readFileSync(join(dir, 'packet.json'), 'utf8'))

function refuseIfRun(dir) {
  if (existsSync(dir) && readdirSync(dir).some((name) => /^run-.+\.json$/.test(name))) {
    // Why refuse rather than overwrite: a re-plan can renumber slices under outputs that were paid
    // for, and the manifest would then credit a slice with another slice's review.
    throw new Error(`${dir} already holds review output; move it aside before re-preparing`)
  }
}

function excludedSummary(excluded) {
  const rules = EXCLUSIONS.map((rule) => {
    const hits = excluded.filter((entry) => entry.rule === rule.id)
    return {
      id: rule.id,
      covers: [...new Set(hits.flatMap((entry) => entry.covers))],
      files: hits.length,
      bytes: hits.reduce((total, entry) => total + entry.bytes, 0),
      why: rule.why,
      residual: rule.residual
    }
  }).filter((rule) => rule.files)
  return {
    files: excluded.length,
    bytes: excluded.reduce((total, entry) => total + entry.bytes, 0),
    rules,
    entries: excluded.map(({ path, status, bytes, added, removed, rule, covers }) => ({
      path,
      status,
      bytes,
      added,
      removed,
      rule,
      covers
    }))
  }
}

export function excludedList(summary) {
  if (!summary.entries.length) {
    return '  (nothing)'
  }
  const residuals = summary.rules
    .filter((rule) => rule.residual)
    .map((rule) => `  [${rule.id}] what that check does not verify: ${rule.residual}`)
  const lines = summary.entries.map(
    (entry) =>
      `  - ${entry.path}: ${entry.status}, ${entry.bytes} bytes (+${entry.added}/-${entry.removed}); ${entry.rule}, verified by ${entry.covers.join(' + ')}`
  )
  return [...lines, ...residuals].join('\n')
}

const writePatch = (dir, name, entries) => {
  writeFileSync(join(dir, name), entries.map((entry) => entry.text).join(''))
  return join(dir, name)
}

/** Round 1: the remerge diff of a sync merge, sliced, with a prompt per slice. */
export function prepareSync({ root, merge, budgetBytes, context, dir: into = null }) {
  const sha = full(root, merge)
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1)
  if (parents.length < 2) {
    throw new Error(`${short(sha)} is not a merge commit`)
  }
  const dir = into ?? syncPacketDir(root, sha)
  refuseIfRun(dir)
  mkdirSync(dir, { recursive: true })
  const patch = git(root, ['show', '--remerge-diff', '--format=', sha])
  writeFileSync(join(dir, 'remerge-diff.patch'), patch)
  const entries = parsePatch(patch)
  const { reviewed, excluded, uncovered } = partitionEntries(entries, context)
  const slices = planSlices(reviewed, budgetBytes)
  const excludedPatch = writePatch(dir, 'excluded.patch', excluded)
  const summary = excludedSummary(excluded)
  const revision = full(root, 'HEAD')
  const vars = {
    REPO: root,
    REVISION: revision,
    MERGE: sha,
    BASE: parents[0],
    UPSTREAM: parents[1],
    SLICE_COUNT: slices.length,
    EXCLUDED_FILES: summary.files,
    EXCLUDED_BYTES: summary.bytes,
    EXCLUDED_LIST: excludedList(summary),
    EXCLUDED_PATCH: excludedPatch
  }
  const text = template('slice.txt')
  for (const slice of slices) {
    const slicePatch = writePatch(dir, `slice-${slice.id}.patch`, slice.entries)
    const prompt = renderTemplate(text, {
      ...vars,
      SLICE_ID: slice.id,
      SLICE_SCOPE: slice.scope,
      SLICE_FILES: slice.files,
      SLICE_BYTES: slice.bytes,
      SLICE_PATCH: slicePatch
    })
    writeFileSync(outputPaths(dir, slice.id).prompt, prompt)
  }
  const packet = {
    kind: 'sync',
    merge: sha,
    base: parents[0],
    upstream: parents[1],
    revision,
    reviewer: REVIEWER,
    budgetBytes,
    artifact: {
      kind: 'remerge-diff',
      path: shown(root, join(dir, 'remerge-diff.patch')),
      bytes: Buffer.byteLength(patch),
      files: entries.length
    },
    reviewed: { files: reviewed.length, bytes: reviewed.reduce((t, e) => t + e.bytes, 0) },
    excluded: summary,
    uncovered,
    slices: slices.map(({ id, scope, files, bytes, entries: sliceEntries }) => ({
      id,
      scope,
      files,
      bytes,
      paths: [...new Set(sliceEntries.map((entry) => entry.path))]
    }))
  }
  writeFileSync(join(dir, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`)
  return { dir, packet }
}

const findingLine = (finding) =>
  `  - [${finding.id}] ${finding.severity} ${finding.file ?? '(no file)'}: ${finding.summary ?? ''}${finding.why ? ` ${finding.why}` : ''}`

/** A delta round: `git diff R1..R2` against the findings it is meant to resolve. */
export function prepareDelta({ root, range, findings, parentDir, context }) {
  const match = /^([^.\s]+)\.\.([^.\s]+)$/.exec(range)
  if (!match) {
    throw new Error(`--delta takes <R1>..<R2>, got ${JSON.stringify(range)}`)
  }
  const [r1, r2] = [full(root, match[1]), full(root, match[2])]
  const existing = existsSync(parentDir)
    ? readdirSync(parentDir).filter((name) => /^delta-\d+-/.test(name))
    : []
  const same = existing.find((name) => name.endsWith(`-${short(r1)}-${short(r2)}`))
  const name = same ?? `delta-${existing.length + 1}-${short(r1)}-${short(r2)}`
  const id = name.split('-').slice(0, 2).join('-')
  const dir = join(parentDir, name)
  refuseIfRun(dir)
  mkdirSync(dir, { recursive: true })
  const entries = parsePatch(git(root, ['diff', r1, r2]))
  const { reviewed, excluded, uncovered } = partitionEntries(entries, context)
  const deltaPatch = writePatch(dir, 'delta.patch', reviewed)
  const excludedPatch = writePatch(dir, 'excluded.patch', excluded)
  const summary = excludedSummary(excluded)
  const bytes = reviewed.reduce((total, entry) => total + entry.bytes, 0)
  const prompt = renderTemplate(template('delta.txt'), {
    REPO: root,
    REVISION: full(root, 'HEAD'),
    R1: r1,
    R2: r2,
    SLICE_ID: id,
    FINDING_COUNT: findings.length,
    FINDINGS: findings.length ? findings.map(findingLine).join('\n') : '  (none recorded)',
    DELTA_FILES: reviewed.length,
    DELTA_BYTES: bytes,
    DELTA_PATCH: deltaPatch,
    EXCLUDED_NOTE: summary.files
      ? `\nLeft out of the delta, because another gate verifies the content:\n${excludedList(summary)}\nTheir hunks are in ${excludedPatch}.\n`
      : ''
  })
  writeFileSync(outputPaths(dir, id).prompt, prompt)
  const packet = {
    kind: 'delta',
    range: `${r1}..${r2}`,
    r1,
    r2,
    revision: full(root, 'HEAD'),
    reviewer: REVIEWER,
    findings: findings.map((finding) => finding.id),
    excluded: summary,
    uncovered,
    slices: [{ id, scope: `delta ${short(r1)}..${short(r2)}`, files: reviewed.length, bytes }]
  }
  writeFileSync(join(dir, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`)
  return { dir, packet }
}
