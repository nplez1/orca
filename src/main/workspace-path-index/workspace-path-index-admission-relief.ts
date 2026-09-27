import type {
  WorkspacePathIndexAdmission,
  WorkspacePathIndexAdmissionResult
} from './workspace-path-index-admission'
import type { WorkspacePathIndexEntry } from './workspace-path-index-lease'

/** Reclaims optional structures, then inactive roots, before failing a build over budget. */
export async function relieveWorkspacePathIndexAdmission(args: {
  key: string
  entry: WorkspacePathIndexEntry
  initialReservation: WorkspacePathIndexAdmissionResult
  buildReservationBytes: number
  peakBuildBytes: number
  entries: Map<string, WorkspacePathIndexEntry>
  admission: WorkspacePathIndexAdmission
  reclaimOptionalStructures?: (key: string, generationId: string) => Promise<number>
  spillResidentCatalog?: (key: string, generationId: string) => Promise<number>
  disposeEntry: (entry: WorkspacePathIndexEntry) => void
}): Promise<WorkspacePathIndexAdmissionResult> {
  const { key, entry, admission, entries } = args
  let reservation = args.initialReservation
  if (!reservation.admitted && args.reclaimOptionalStructures) {
    const reclaim = args.reclaimOptionalStructures
    const candidates = [...entries.values()]
      .filter((candidate) => candidate.generationId !== null && candidate.retainedBytes > 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    for (const candidate of candidates) {
      if (!candidate.generationId) {
        continue
      }
      const releasedBytes = await reclaim(candidate.key, candidate.generationId).catch(() => 0)
      if (releasedBytes > 0) {
        const retainedBytes = Math.max(0, candidate.retainedBytes - releasedBytes)
        if (admission.updateRetainedRoot(candidate.key, retainedBytes)) {
          candidate.retainedBytes = retainedBytes
        }
        reservation = admission.reserveBuild(key, args.buildReservationBytes, args.peakBuildBytes)
        if (reservation.admitted) {
          break
        }
      }
    }
  }
  if (!reservation.admitted && args.spillResidentCatalog) {
    const spill = args.spillResidentCatalog
    const spillCandidates = [...entries.values()]
      .filter((candidate) => candidate.generationId !== null && candidate.retainedBytes > 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    for (const candidate of spillCandidates) {
      if (!candidate.generationId) {
        continue
      }
      const releasedBytes = await spill(candidate.key, candidate.generationId).catch(() => 0)
      if (releasedBytes > 0) {
        const retainedBytes = Math.max(0, candidate.retainedBytes - releasedBytes)
        if (admission.updateRetainedRoot(candidate.key, retainedBytes)) {
          candidate.retainedBytes = retainedBytes
        }
        reservation = admission.reserveBuild(key, args.buildReservationBytes, args.peakBuildBytes)
        if (reservation.admitted) {
          break
        }
      }
    }
  }
  if (!reservation.admitted) {
    const inactive = [...entries.values()]
      .filter(
        (candidate) =>
          candidate.key !== key && candidate.leases.size === 0 && candidate.generationId === null
      )
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    for (const candidate of inactive) {
      args.disposeEntry(candidate)
      reservation = admission.reserveBuild(key, args.buildReservationBytes, args.peakBuildBytes)
      if (reservation.admitted) {
        break
      }
    }
  }
  if (!reservation.admitted && entry.servingLastKnown) {
    // A provisional restore must never block its own reconciliation: drop it and retry once.
    admission.releaseRoot(key)
    entry.generationId = null
    entry.publishedScope = null
    entry.retainedBytes = 0
    entry.servingLastKnown = false
    entry.freshness = 'no-known-gap'
    reservation = admission.reserveBuild(key, args.buildReservationBytes, args.peakBuildBytes)
  }
  return reservation
}
