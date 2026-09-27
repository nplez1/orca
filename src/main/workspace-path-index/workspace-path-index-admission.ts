import {
  WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES,
  WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
} from '../../shared/__fixtures__/workspace-path-memory-measurement'

export type WorkspacePathIndexAdmissionFailure = 'root-budget' | 'over-budget'

export type WorkspacePathIndexReservation = {
  id: string
  rootKey: string
  bytes: number
  peakBytes: number
}

export type WorkspacePathIndexAdmissionResult =
  | { admitted: true; reservation: WorkspacePathIndexReservation }
  | { admitted: false; reason: WorkspacePathIndexAdmissionFailure }

/** Accounts retained generations and replacement reservations before build allocation. */
export class WorkspacePathIndexAdmission {
  private readonly retained = new Map<string, number>()
  private readonly reservations = new Map<string, WorkspacePathIndexReservation>()
  private nextReservationId = 1

  constructor(
    private readonly rootBudgetBytes = WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES,
    private readonly hostBudgetBytes = WORKSPACE_PATH_INDEX_HOST_MEMORY_BUDGET_BYTES
  ) {}

  get retainedBytes(): number {
    return [...this.retained.values()].reduce((sum, bytes) => sum + bytes, 0)
  }

  get reservedBytes(): number {
    return [...this.reservations.values()].reduce(
      (sum, reservation) => sum + reservation.peakBytes,
      0
    )
  }

  reserveBuild(
    rootKey: string,
    replacementBytes: number,
    peakBytes = replacementBytes
  ): WorkspacePathIndexAdmissionResult {
    const bytes = safeBytes(replacementBytes)
    const peakReservationBytes = safeBytes(peakBytes)
    if (bytes > this.rootBudgetBytes) {
      return { admitted: false, reason: 'root-budget' }
    }
    if (this.retainedBytes + this.reservedBytes + peakReservationBytes > this.hostBudgetBytes) {
      return { admitted: false, reason: 'over-budget' }
    }
    const reservation = {
      id: String(this.nextReservationId++),
      rootKey,
      bytes,
      peakBytes: peakReservationBytes
    }
    this.reservations.set(reservation.id, reservation)
    return { admitted: true, reservation }
  }

  /** Non-destructive twin of publish(): callers gate a generation's exposure on this. */
  admitsRetained(reservation: WorkspacePathIndexReservation, retainedBytes: number): boolean {
    if (this.reservations.get(reservation.id) !== reservation) {
      return false
    }
    const bytes = safeBytes(retainedBytes)
    return bytes <= reservation.bytes && bytes <= this.rootBudgetBytes
  }

  publish(reservation: WorkspacePathIndexReservation, retainedBytes: number): boolean {
    if (!this.admitsRetained(reservation, retainedBytes)) {
      this.releaseReservation(reservation)
      return false
    }
    const bytes = safeBytes(retainedBytes)
    this.reservations.delete(reservation.id)
    this.retained.set(reservation.rootKey, bytes)
    return true
  }

  releaseReservation(reservation: WorkspacePathIndexReservation): void {
    this.reservations.delete(reservation.id)
  }

  releaseRoot(rootKey: string): void {
    this.retained.delete(rootKey)
    for (const [id, reservation] of this.reservations) {
      if (reservation.rootKey === rootKey) {
        this.reservations.delete(id)
      }
    }
  }

  updateRetainedRoot(rootKey: string, retainedBytes: number): boolean {
    const bytes = safeBytes(retainedBytes)
    if (bytes > this.rootBudgetBytes) {
      return false
    }
    const otherRootsBytes = [...this.retained.entries()]
      .filter(([key]) => key !== rootKey)
      .reduce((sum, [, value]) => sum + value, 0)
    if (otherRootsBytes + this.reservedBytes + bytes > this.hostBudgetBytes) {
      return false
    }
    this.retained.set(rootKey, bytes)
    return true
  }

  evictRetainedRoot(rootKey: string): void {
    this.retained.delete(rootKey)
  }
}

function safeBytes(bytes: number): number {
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : Number.POSITIVE_INFINITY
}
