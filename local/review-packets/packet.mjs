// Writing a review packet: the patch, the slices, and one rendered prompt per slice.
//
// Why the git dir and never /tmp: in the 2026-11-15 review four of six slices failed first time
// because the reviewer's sandbox refused /tmp, and /tmp is shared by every agent on the machine
// (AGENTS.md § unique /tmp names). The packet lives under this worktree's own git dir, which nothing
// else writes and which the runner hands the reviewer with `--add-dir`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { REVIEWER } from '../pr-body-claims.mjs'
import { EXCLUSIONS, partitionEntries } from './exclusions.mjs'
import { parsePatch, planSlices } from './slices.mjs'
import { outputPaths } from './verdict.mjs'

const TEMPLATES = join(import.meta.dirname, 'templates')
/** ~100k tokens of patch: one slice a reviewer can read whole, with room left to read the tree. */
export const DEFAULT_BUDGET_KB = 384

export const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 })

/**
 * Why pinned on every patch this module writes: `diff.noprefix`, `core.quotePath` quoting a non-ASCII
 * path, or `color.ui=always` each produce a diff `parsePatch` cannot read, and the failure would land
 * on the release review rather than on the setting.
 */
export const DIFF_CONFIG = ['-c', 'core.quotePath=false']
export const DIFF_OPTIONS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']

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

/**
 * Why not a regex on the dots: a tag like `v1.4.214-np.49..HEAD` carries dots of its own, so the cut
 * is the one whose two sides both resolve.
 */
function resolveRange(root, range) {
  for (const { index } of range.matchAll(/\.\./g)) {
    const [left, right] = [range.slice(0, index), range.slice(index + 2)]
    if (!left || !right) {
      continue
    }
    try {
      return [full(root, left), full(root, right)]
    } catch {
      continue
    }
  }
  throw new Error(`--delta takes <R1>..<R2>, got ${JSON.stringify(range)}`)
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

/**
 * The patch itself, fenced for the prompt. Why inline and not only the path: a reviewer handed a path
 * spends a turn per ~1,500-line Read, each of which re-sends the whole conversation, and a Read the CLI
 * spills to a tool-results file is then read again in pieces. Measured over the 2026-11-13 → 11-27
 * reviews, those packet reads were 110 calls and 2.05M characters, the largest single share of the
 * reviewers' turns. The bytes are the same either way; inline they arrive in the one prompt.
 *
 * The fence is one backtick longer than the longest run inside the patch, so a patch to a Markdown file
 * cannot close it early.
 */
export function inlinePatch(entries) {
  const text = entries.map((entry) => entry.text).join('')
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}diff\n${text.endsWith('\n') ? text : `${text}\n`}${fence}`
}

/** Round 1: the remerge diff of a sync merge, sliced, with a prompt per slice. */
export function prepareSync({
  root,
  merge,
  budgetBytes,
  context,
  kind = 'sync',
  dir: into = null
}) {
  const sha = full(root, merge)
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1)
  if (parents.length < 2) {
    throw new Error(`${short(sha)} is not a merge commit`)
  }
  const dir = into ?? syncPacketDir(root, sha)
  refuseIfRun(dir)
  mkdirSync(dir, { recursive: true })
  const patch = git(root, [
    ...DIFF_CONFIG,
    'show',
    ...DIFF_OPTIONS,
    '--remerge-diff',
    '--format=',
    sha
  ])
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
      SLICE_PATCH: slicePatch,
      SLICE_PATCH_TEXT: inlinePatch(slice.entries)
    })
    writeFileSync(outputPaths(dir, slice.id).prompt, prompt)
  }
  const packet = {
    kind,
    merge: sha,
    base: parents[0],
    upstream: parents[1],
    revision,
    reviewer: REVIEWER,
    budgetBytes,
    artifact: {
      kind: 'remerge-diff',
      // Why relative to the git dir: this manifest is committed, and a packet never lives in one
      // machine's directory twice.
      path: join('orca-review', basename(dir), 'remerge-diff.patch'),
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
export function prepareDelta({ root, range, findings, parentDir, context, budgetBytes = null }) {
  const [r1, r2] = resolveRange(root, range)
  const existing = existsSync(parentDir)
    ? readdirSync(parentDir).filter((name) => /^delta-\d+-/.test(name))
    : []
  const same = existing.find((name) => name.endsWith(`-${short(r1)}-${short(r2)}`))
  const name = same ?? `delta-${existing.length + 1}-${short(r1)}-${short(r2)}`
  const id = name.split('-').slice(0, 2).join('-')
  const dir = join(parentDir, name)
  refuseIfRun(dir)
  const entries = parsePatch(git(root, [...DIFF_CONFIG, 'diff', ...DIFF_OPTIONS, r1, r2]))
  const { reviewed, excluded, uncovered } = partitionEntries(entries, context)
  const bytes = reviewed.reduce((total, entry) => total + entry.bytes, 0)
  // Why refused rather than sliced: a delta is a re-check of a fix, so a range this size is a full
  // review wearing a delta's prompt — one answer over content no reviewer can read, and it would be
  // recorded as a resolution for findings the reviewer only skimmed. Chained ranges stay contiguous.
  if (budgetBytes && bytes > budgetBytes) {
    throw new Error(
      `delta ${short(r1)}..${short(r2)} is ${String(bytes)} bytes, over the ${String(budgetBytes)}-byte budget; narrow the range and chain a second delta round`
    )
  }
  mkdirSync(dir, { recursive: true })
  const deltaPatch = writePatch(dir, 'delta.patch', reviewed)
  const excludedPatch = writePatch(dir, 'excluded.patch', excluded)
  const summary = excludedSummary(excluded)
  const prompt = renderTemplate(template('delta.txt'), {
    REPO: root,
    REVISION: r2,
    R1: r1,
    R2: r2,
    SLICE_ID: id,
    FINDING_COUNT: findings.length,
    FINDINGS: findings.length ? findings.map(findingLine).join('\n') : '  (none recorded)',
    DELTA_FILES: reviewed.length,
    DELTA_BYTES: bytes,
    DELTA_PATCH: deltaPatch,
    DELTA_PATCH_TEXT: inlinePatch(reviewed),
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
