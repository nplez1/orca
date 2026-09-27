import { describe, expect, it } from 'vitest'
import { WorkspacePathIndexAdmission } from '../workspace-path-index/workspace-path-index-admission'
import { WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES } from '../../shared/__fixtures__/workspace-path-memory-measurement'

describe('Quick Open path-index admission compatibility', () => {
  it('rejects the measured one-million-path build reservation before allocation', () => {
    const admission = new WorkspacePathIndexAdmission()
    expect(admission.reserveBuild('one-million-path-root', 517_371_700)).toEqual({
      admitted: false,
      reason: 'root-budget'
    })
  })

  it('uses the shared steady-state root budget', () => {
    const admission = new WorkspacePathIndexAdmission()
    const reservation = admission.reserveBuild(
      'small-root',
      WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES
    )
    expect(reservation.admitted).toBe(true)
  })
})
