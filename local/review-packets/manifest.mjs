// The release review manifest, generated from the packets instead of written by hand.
//
// Why generated: in the 2026-11-15 release the manifest's counts, scopes and "resolved" notes were
// copied out of six JSON outputs and two delta answers by hand. `release-review-gate.mjs` validates
// whatever it is given, so a copying slip is a slip the gate cannot see. Here every number comes
// from a slice's own verdict block, and `release-review-gate.mjs` stays the authority on whether
// the result clears.
//
// The review is two tiers since 2026-11-21: a fine sweep on the cheap tier finds, and REVIEWER's
// adjudication judges every finding it raised (`sweep.mjs`, `adjudicate.mjs`). Both are in this
// manifest, because a judgment nobody can find is not a judgment.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEWER } from '../pr-body-claims.mjs'
import { loadPacket } from './packet.mjs'
import { BLOCKING, readReport } from './verdict.mjs'
import { sweepState } from './sweep.mjs'

/** The sync packet and every delta prepared under it, in round order. */
export function loadRounds(syncDir) {
  const deltas = readdirSync(syncDir)
    .map((name) => /^delta-(\d+)-/.exec(name))
    .filter((match) => match && existsSync(join(syncDir, match.input, 'packet.json')))
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => join(syncDir, match.input))
  return [syncDir, ...deltas].map((dir) => ({ dir, packet: loadPacket(dir) }))
}

/** One of the sync packet's own tier directories (`sweep/`, `adjudicate/`), or null when absent. */
function tier(syncDir, name) {
  const dir = join(syncDir, name)
  return existsSync(join(dir, 'packet.json')) ? { dir, packet: loadPacket(dir) } : null
}

/**
 * Every slice of every round with its report and its findings (each given a stable id, `A-1`), plus
 * what the delta rounds said about earlier findings. A later round's answer replaces an earlier one.
 *
 * The sweep's findings carry an `S-` prefix (`S-A-1`) so a sweep slice and a round-1 slice that share an
 * id can never be confused for each other — the sweep is cut finer, so `A` means two different things in
 * the two packets.
 */
export function reviewState(syncDir) {
  const rounds = loadRounds(syncDir)
  const slices = []
  const resolutions = new Map()
  for (const { dir, packet } of rounds) {
    for (const slice of packet.slices) {
      const report = readReport(dir, slice.id)
      const findings =
        report.status === 'reported'
          ? report.verdict.findings.map((finding, index) => ({
              id: `${slice.id}-${index + 1}`,
              ...finding
            }))
          : []
      for (const answer of report.status === 'reported' ? (report.verdict.resolved ?? []) : []) {
        // Why only a delta round, and only its own findings: round 1 reviewed upstream-authored text,
        // and a sync slice that answered `resolved` for another slice's finding would close it with no
        // re-check at all. A delta round is the only thing asked to answer resolutions, and only about
        // the findings it was handed.
        const asked =
          packet.kind === 'delta' && (packet.findings ?? []).includes(String(answer?.id))
        if (answer?.id && asked) {
          resolutions.set(String(answer.id), {
            resolved: answer.resolved === true,
            note: answer.note ?? '',
            by: slice.id
          })
        }
      }
      slices.push({ dir, kind: packet.kind, slice, report, findings })
    }
  }
  const sweepPacket = tier(syncDir, 'sweep')
  const sweep = sweepPacket ? sweepState(sweepPacket.dir, sweepPacket.packet) : null
  const sweepFindings = sweep
    ? sweep.slices.flatMap((entry) =>
        entry.report.status === 'reported'
          ? entry.report.verdict.findings.map((finding, index) => ({
              id: `S-${entry.slice.id}-${index + 1}`,
              slice: entry.slice.id,
              ...finding
            }))
          : []
      )
    : []
  const adjudicatePacket = tier(syncDir, 'adjudicate')
  const adjudication = adjudicatePacket
    ? adjudicatePacket.packet.slices.map((slice) => {
        const report = readReport(adjudicatePacket.dir, slice.id)
        const judged = report.status === 'reported' ? (report.verdict.judged ?? []) : []
        const findings =
          report.status === 'reported'
            ? report.verdict.findings.map((finding, index) => ({
                id: `${slice.id}-${index + 1}`,
                ...finding
              }))
            : []
        return { dir: adjudicatePacket.dir, slice, report, judged, findings }
      })
    : []
  // Why the adjudication is spliced before the deltas: it judges the sweep's findings before anything is
  // fixed, and a manifest that lists it after the fixes reads as though the fixes came first.
  const firstDelta = slices.findIndex((entry) => entry.kind === 'delta')
  const adjudicated = adjudication.map((entry) => ({ ...entry, kind: 'adjudicate' }))
  slices.splice(firstDelta === -1 ? slices.length : firstDelta, 0, ...adjudicated)
  const judged = new Map()
  for (const entry of adjudication) {
    for (const answer of entry.judged) {
      if (answer?.id) {
        judged.set(String(answer.id), { ...answer, by: entry.slice.id })
      }
    }
  }
  return {
    rounds,
    slices,
    resolutions,
    sweepFindings,
    adjudication,
    judged,
    sweepReviewer: sweep?.packet?.reviewer ?? null,
    adjudicateReviewer: adjudicatePacket?.packet?.reviewer ?? null,
    sweepPacket: sweep?.packet ?? null,
    sweepDir: sweep?.dir ?? null,
    sweepSlices: sweep?.slices ?? null,
    adjudicatePacket: adjudicatePacket?.packet ?? null,
    adjudicateDir: adjudicatePacket?.dir ?? null
  }
}

const isResolved = (state, finding) => state.resolutions.get(finding.id)?.resolved === true

/**
 * Blocking after REVIEWER's judgment, not by the sweep's own label: a NIT the adjudication rated
 * SHOULD-FIX blocks, and a SHOULD-FIX it judged not real does not. An unjudged finding keeps the sweep's
 * severity, so nothing gets quieter by going unjudged.
 */
export function blockingAfterJudgement(state, finding) {
  const judged = state.judged.get(finding.id)
  if (judged) {
    return judged.real !== false && BLOCKING.has(judged.severity)
  }
  return BLOCKING.has(finding.severity)
}

/**
 * What happened to one finding: a delta round fixed it, REVIEWER judged it not real, or it is open.
 *
 * Why a dismissed finding is not "open": the gate's job is to see that judgment was applied, and
 * `real: false` with evidence IS that judgment. A dismissal with no reason stays open, so the reason a
 * blocking finding was not fixed is always recorded somewhere the release body can cite.
 */
export function findingStatus(state, finding) {
  if (isResolved(state, finding)) {
    return `resolved (${state.resolutions.get(finding.id).by})`
  }
  const judged = state.judged.get(finding.id)
  if (judged?.real === false) {
    return judged.why?.trim() ? `dismissed (${judged.by})` : 'open'
  }
  return 'open'
}

/** Findings no later round has marked resolved — the input a delta round re-checks by default. */
export function openFindings(state) {
  const fromRounds = state.slices
    .filter((entry) => entry.kind !== 'adjudicate')
    .flatMap((entry) => entry.findings.filter((f) => !isResolved(state, f)))
  const fromSweep = state.sweepFindings.filter(
    (finding) => findingStatus(state, finding) === 'open' && BLOCKING.has(finding.severity)
  )
  return [...fromRounds, ...fromSweep]
}

function countLine(slices) {
  const total = { blockers: 0, shouldFix: 0, minors: 0, nits: 0 }
  for (const entry of slices) {
    for (const key of Object.keys(total)) {
      total[key] += entry.report?.counts?.[key] ?? 0
    }
  }
  return `${total.blockers} BLOCKER, ${total.shouldFix} SHOULD-FIX, ${total.minors} MINOR, ${total.nits} NIT`
}

const judgedShape = (state, entry) => ({
  id: String(entry.id),
  real: entry.real !== false,
  severity: entry.severity ?? null,
  why: entry.why ?? '',
  by: entry.by
})

export function buildManifest(state, { revision }) {
  const sync = state.rounds[0].packet
  const slices = state.slices.map((entry) => {
    const reported = entry.report.status === 'reported'
    const blocking = entry.findings.filter((finding) => BLOCKING.has(finding.severity))
    return {
      id: entry.slice.id,
      round: entry.kind === 'sync' ? 'R1' : entry.slice.id,
      scope: entry.slice.scope,
      files: entry.slice.files,
      bytes: entry.slice.bytes,
      // Why `no-report` for a slice that never ran: the gate refuses it by that name, and an absent
      // verdict must never read as a finished one.
      verdict: reported ? 'reported' : 'no-report',
      ...(reported ? entry.report.counts : { problem: entry.report.problem }),
      unresolved: blocking.filter((finding) => !isResolved(state, finding)).length,
      costUsd: entry.report.cost ?? null,
      ...(entry.report.reviewer ? { reviewer: entry.report.reviewer } : {}),
      ...(entry.report.verdict?.coverage ? { coverage: entry.report.verdict.coverage } : {}),
      findings: entry.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        file: finding.file ?? null,
        summary: finding.summary ?? '',
        status: isResolved(state, finding)
          ? `resolved (${state.resolutions.get(finding.id).by})`
          : 'open'
      }))
    }
  })
  // Why derived from the records and not the packet: the packet was prepared before anyone knew which
  // model would sweep, and every record names the tier that actually answered.
  const sweepNames = [
    ...new Set((state.sweepSlices ?? []).map((entry) => entry.report.reviewer).filter(Boolean))
  ]
  const sweep = state.sweepPacket
    ? {
        reviewer: { name: sweepNames.join(', ') || 'the cheap tier' },
        budgetBytes: state.sweepPacket.budgetBytes,
        slices: state.sweepSlices.map(({ slice, report: read }) => {
          const entry = state.sweepFindings.filter((finding) => finding.slice === slice.id)
          const reported = read.status === 'reported'
          return {
            id: slice.id,
            scope: slice.scope,
            files: slice.files,
            bytes: slice.bytes,
            verdict: reported ? 'reported' : 'no-report',
            ...(reported ? read.counts : { problem: read.problem }),
            reviewer: read.reviewer ?? state.sweepReviewer,
            costUsd: read.cost ?? null,
            unresolved: entry.filter(
              (finding) =>
                findingStatus(state, finding) === 'open' && blockingAfterJudgement(state, finding)
            ).length,
            findings: entry.map((finding) => ({
              id: finding.id,
              severity: finding.severity,
              file: finding.file ?? null,
              summary: finding.summary ?? '',
              status: findingStatus(state, finding)
            }))
          }
        }),
        costUsd: state.sweepSlices.reduce((total, entry) => total + (entry.report.cost ?? 0), 0)
      }
    : null
  const adjudication = state.adjudicatePacket
    ? {
        reviewer: state.adjudicateReviewer,
        slices: state.adjudication.map((entry) => ({
          id: entry.slice.id,
          verdict: entry.report.status === 'reported' ? 'reported' : 'no-report',
          ...(entry.report.status === 'reported'
            ? entry.report.counts
            : { problem: entry.report.problem }),
          costUsd: entry.report.cost ?? null,
          judged: entry.judged.length,
          missing: (state.adjudicatePacket.findings ?? []).filter(
            (id) =>
              state.adjudication
                .flatMap((other) => other.judged.map((answer) => String(answer.id)))
                .includes(id) === false
          ).length
        })),
        judged: [...state.judged.values()].map((entry) => judgedShape(state, entry))
      }
    : null
  const fallback = new Map()
  for (const entry of state.slices) {
    const reviewer = entry.report.reviewer
    if (entry.report.status === 'reported' && reviewer && reviewer !== REVIEWER.name) {
      fallback.set(reviewer, (fallback.get(reviewer) ?? 0) + 1)
    }
  }
  const fallbackNote = fallback.size
    ? `${[...fallback].map(([reviewer, count]) => `${count} by ${reviewer}`).join(', ')} on the same packet prompts and rules, because the ${REVIEWER.name} budget ran out mid-review. `
    : ''
  const round1 = state.slices.filter((entry) => entry.kind === 'sync')
  const deltas = state.slices.filter((entry) => entry.kind === 'delta')
  const adjudicated = state.slices.filter((entry) => entry.kind === 'adjudicate')
  const cost = state.slices.reduce((total, entry) => total + (entry.report.cost ?? 0), 0)
  const reported = slices.filter((slice) => slice.verdict === 'reported').length
  const deltaNote = deltas.length
    ? `${deltas.length} delta round(s) (${deltas.map((entry) => entry.slice.scope).join('; ')}): ${countLine(deltas)}. `
    : ''
  const sweepNote = state.sweepPacket
    ? `Sweep: ${state.sweepPacket.slices.length} fine slice(s) by ${state.sweepReviewer?.name ?? 'the cheap tier'}, ${state.sweepFindings.length} finding(s): ${countLine(state.sweepSlices)}. `
    : 'NO SWEEP RECORDED. '
  const adjudicationNote = state.adjudicatePacket
    ? `Adjudication: ${adjudicated.length} packet(s) by ${state.adjudicateReviewer?.name ?? REVIEWER.name}, ${state.judged.size} judgment(s) and ${countLine(adjudicated)} the sweep missed. `
    : ''
  return {
    revision,
    base: sync.base,
    upstream: sync.upstream,
    mergeCommit: sync.merge,
    // Why the packet's reviewer and not today's constant: the manifest is a record of the review that
    // happened, and `release-review-gate.mjs` refuses it when that is not the reviewer it requires.
    reviewer: sync.reviewer ?? REVIEWER,
    generatedBy: 'node local/release-review-packets.mjs --write',
    artifact: {
      ...sync.artifact,
      reviewedBytes: sync.reviewed.bytes,
      excluded: {
        files: sync.excluded.files,
        bytes: sync.excluded.bytes,
        rules: sync.excluded.rules
      },
      uncovered: sync.uncovered
    },
    note: `${fallbackNote}${round1.length} slice(s) over the remerge diff of ${sync.merge.slice(0, 11)}, ${sync.reviewed.bytes} of ${sync.artifact.bytes} bytes reviewed (${sync.excluded.bytes} bytes in ${sync.excluded.files} files left to their verifying checks). Round 1: ${countLine(round1)}. ${sweepNote}${adjudicationNote}${deltaNote}${reported}/${slices.length} slices reported; $${cost.toFixed(2)} total.`,
    slices,
    sweep,
    adjudication,
    waiver: null
  }
}
