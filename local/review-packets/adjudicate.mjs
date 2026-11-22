// The adjudication round: REVIEWER's judgment on what the cheap sweep found, and on what it missed.
//
// Why this is a round of its own rather than "more Opus slices". The sweep reads small and reads
// everything, so it finds; what it cannot do is judge — on 2026-11-21 it called a dropped
// `clearPendingClone` correct in one packet while calling the same code an actual bug in a per-file
// one, and it downgraded a real mobile merge regression to NIT. Judgment is the expensive, scarce
// thing, and it belongs on the findings and the code they touch, not on 3 MB of patch.
//
// So an adjudication packet is small by construction: N findings, plus the resolution hunks of the
// files they name. REVIEWER answers, for every finding, real-or-not and at what severity — silence on
// one finding is a `no-report`, and the gate refuses the release on it — and is then asked the question
// the sweep structurally cannot answer: what did the sweep miss in these files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEWER } from '../pr-body-claims.mjs'
import { DIFF_CONFIG, DIFF_OPTIONS, git, renderTemplate } from './packet.mjs'
import { parsePatch } from './slices.mjs'
import { outputPaths } from './verdict.mjs'

/** Why 12: one answer has to hold every judgment plus a fresh look at their files, and a packet that
 * outgrows a single read stops being a judgment and becomes the 380 KB slice that missed the bug. */
export const ADJUDICATE_GROUP = 12

const TEMPLATES = join(import.meta.dirname, 'templates')
const short = (sha) => String(sha).slice(0, 12)

/** The adjudication lives inside the sync packet, beside the sweep whose findings it judges. */
export const adjudicateDirOf = (syncDir) => join(syncDir, 'adjudicate')

const findingLine = (finding) =>
  [
    `- [${finding.id}] ${finding.severity ?? 'UNRATED'} ${finding.file ?? '(no file)'}: ${finding.summary ?? ''}`,
    finding.why ? `  why: ${finding.why}` : null
  ]
    .filter(Boolean)
    .join('\n')

/**
 * The hunks of the files these findings name, from the merge's own remerge diff. Why the diff and not
 * the merged text: the question is what the RESOLUTION wrote, and a file that reads fine can still be a
 * resolution that dropped one side.
 */
function hunksFor(entries, paths) {
  const wanted = new Set(paths)
  return entries.filter(
    (entry) =>
      wanted.has(entry.path) || [...wanted].some((path) => entry.path.startsWith(`${path}/`))
  )
}

export function prepareAdjudication({ root, syncDir, merge, findings, dir: into = null }) {
  if (!findings.length) {
    throw new Error('there is nothing to adjudicate: no findings were passed in')
  }
  const sha = git(root, ['rev-parse', '--verify', `${merge}^{commit}`]).trim()
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1)
  if (parents.length < 2) {
    throw new Error(`${short(sha)} is not a merge commit`)
  }
  const entries = parsePatch(
    git(root, [...DIFF_CONFIG, 'show', ...DIFF_OPTIONS, '--remerge-diff', '--format=', sha])
  )
  if (!into && !syncDir) {
    throw new Error('prepareAdjudication needs the sync packet dir: { syncDir }')
  }
  const dir = into ?? adjudicateDirOf(syncDir)
  const existing = existsSync(dir) ? readFileSync(join(dir, 'packet.json'), 'utf8') : null
  if (existing) {
    // Why refuse: a re-plan renumbers groups under answers that were paid for, and the manifest would
    // then credit a group with another group's judgment.
    const prior = JSON.parse(existing)
    if (prior.slices?.some((slice) => existsSync(outputPaths(dir, slice.id).run))) {
      throw new Error(`${dir} already holds adjudication output; move it aside first`)
    }
  }
  mkdirSync(dir, { recursive: true })
  const text = readFileSync(join(TEMPLATES, 'adjudicate.txt'), 'utf8')
  const groups = []
  for (let index = 0; index < findings.length; index += ADJUDICATE_GROUP) {
    groups.push(findings.slice(index, index + ADJUDICATE_GROUP))
  }
  const slices = groups.map((group, index) => {
    const id = `adj-${index + 1}`
    const paths = [...new Set(group.map((finding) => finding.file).filter(Boolean))]
    const hunks = hunksFor(entries, paths)
    const patch = join(dir, `adj-${index + 1}.patch`)
    writeFileSync(patch, hunks.map((entry) => entry.text).join(''))
    writeFileSync(
      outputPaths(dir, id).prompt,
      renderTemplate(text, {
        REPO: root,
        REVISION: git(root, ['rev-parse', 'HEAD']).trim(),
        MERGE: sha,
        BASE: parents[0],
        UPSTREAM: parents[1],
        SLICE_ID: id,
        GROUP_COUNT: groups.length,
        FINDING_COUNT: group.length,
        FINDINGS: group.map(findingLine).join('\n'),
        PATCH: patch,
        PATCH_FILES: hunks.length,
        PATCH_BYTES: hunks.reduce((total, entry) => total + entry.bytes, 0)
      })
    )
    return {
      id,
      scope: `adjudication ${index + 1} of ${groups.length}`,
      files: paths.length,
      bytes: hunks.reduce((total, entry) => total + entry.bytes, 0),
      paths,
      findings: group.map((finding) => finding.id)
    }
  })
  const packet = {
    kind: 'adjudicate',
    merge: sha,
    base: parents[0],
    upstream: parents[1],
    revision: git(root, ['rev-parse', 'HEAD']).trim(),
    reviewer: REVIEWER,
    findings: findings.map((finding) => finding.id),
    slices
  }
  writeFileSync(join(dir, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`)
  return { dir, packet }
}

/** Which finding ids a reported adjudication answered, from its `judged` list. */
export const judgedIds = (verdict) =>
  new Set(
    (Array.isArray(verdict?.judged) ? verdict.judged : [])
      .map((entry) => String(entry?.id ?? ''))
      .filter(Boolean)
  )
