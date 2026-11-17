// The release review manifest, generated from the packets instead of written by hand.
//
// Why generated: in the 2026-11-15 release the manifest's counts, scopes and "resolved" notes were
// copied out of six JSON outputs and two delta answers by hand. `release-review-gate.mjs` validates
// whatever it is given, so a copying slip is a slip the gate cannot see. Here every number comes
// from a slice's own verdict block, and `release-review-gate.mjs` stays the authority on whether
// the result clears.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEWER } from '../pr-body-claims.mjs'
import { loadPacket } from './packet.mjs'
import { BLOCKING, readReport } from './verdict.mjs'

/** The sync packet and every delta prepared under it, in round order. */
export function loadRounds(syncDir) {
  const deltas = readdirSync(syncDir)
    .map((name) => /^delta-(\d+)-/.exec(name))
    .filter((match) => match && existsSync(join(syncDir, match.input, 'packet.json')))
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => join(syncDir, match.input))
  return [syncDir, ...deltas].map((dir) => ({ dir, packet: loadPacket(dir) }))
}

/**
 * Every slice of every round with its report and its findings (each given a stable id, `A-1`), plus
 * what the delta rounds said about earlier findings. A later round's answer replaces an earlier one.
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
  return { rounds, slices, resolutions }
}

const isResolved = (state, finding) => state.resolutions.get(finding.id)?.resolved === true

/** Findings no later round has marked resolved — the input a delta round re-checks by default. */
export function openFindings(state) {
  return state.slices.flatMap((entry) => entry.findings.filter((f) => !isResolved(state, f)))
}

function countLine(slices) {
  const total = { blockers: 0, shouldFix: 0, minors: 0, nits: 0 }
  for (const entry of slices) {
    for (const key of Object.keys(total)) {
      total[key] += entry.report.counts?.[key] ?? 0
    }
  }
  return `${total.blockers} BLOCKER, ${total.shouldFix} SHOULD-FIX, ${total.minors} MINOR, ${total.nits} NIT`
}

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
  const round1 = state.slices.filter((entry) => entry.kind === 'sync')
  const deltas = state.slices.filter((entry) => entry.kind === 'delta')
  const cost = state.slices.reduce((total, entry) => total + (entry.report.cost ?? 0), 0)
  const reported = slices.filter((slice) => slice.verdict === 'reported').length
  const deltaNote = deltas.length
    ? `${deltas.length} delta round(s) (${deltas.map((entry) => entry.slice.scope).join('; ')}): ${countLine(deltas)}. `
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
    note: `${round1.length} slice(s) over the remerge diff of ${sync.merge.slice(0, 11)}, ${sync.reviewed.bytes} of ${sync.artifact.bytes} bytes reviewed (${sync.excluded.bytes} bytes in ${sync.excluded.files} files left to their verifying checks). Round 1: ${countLine(round1)}. ${deltaNote}${reported}/${slices.length} slices reported; $${cost.toFixed(2)} total.`,
    slices,
    waiver: null
  }
}
