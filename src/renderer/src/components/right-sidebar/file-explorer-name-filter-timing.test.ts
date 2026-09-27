// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  markRendererPathSearchProjectionReady,
  recordRendererPathSearchCommit,
  recordRendererPathSearchDuration
} from './file-explorer-name-filter-timing'

describe('file explorer name-filter renderer timing', () => {
  it('exposes correlated numeric renderer stages through the development hook', async () => {
    const correlationId = 'timing-test-correlation'
    recordRendererPathSearchDuration(correlationId, 'input-to-dispatch', 7)
    recordRendererPathSearchDuration(correlationId, 'projection', 5)
    markRendererPathSearchProjectionReady(correlationId)
    recordRendererPathSearchCommit(correlationId)
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
    })

    const readTimings = window.__orcaWorkspacePathSearchTimings
    if (!readTimings) {
      throw new Error('Renderer search timing hook was not installed in development mode')
    }
    const records = await readTimings()
    const correlationRecords = records.filter((record) => record.correlationId === correlationId)

    expect(correlationRecords.map((record) => record.stage)).toEqual([
      'input-to-dispatch',
      'projection',
      'commit',
      'query-tagged-paint'
    ])
    expect(
      correlationRecords.every((record) => typeof record.duration.milliseconds === 'number')
    ).toBe(true)
    expect(JSON.stringify(correlationRecords)).not.toContain('private/filename.ts')
  })
})
