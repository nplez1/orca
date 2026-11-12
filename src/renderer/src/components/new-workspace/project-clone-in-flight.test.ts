import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getProjectCloneKey,
  isProjectCloneInFlight,
  resetProjectCloneInFlightForTests,
  trackProjectClone,
  type ProjectCloneOutcome
} from './project-clone-in-flight'

const KEY = getProjectCloneKey('github:acme/app', 'runtime:env-b')
const FAILED: ProjectCloneOutcome = { kind: 'failed', message: 'Repository not found' }

function deferred() {
  let resolve: (outcome: ProjectCloneOutcome) => void = () => {}
  const promise = new Promise<ProjectCloneOutcome>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

beforeEach(() => {
  resetProjectCloneInFlightForTests()
})

describe('trackProjectClone', () => {
  it('reports an outcome no watcher showed, once, however many joined', async () => {
    const clone = deferred()
    const reportUnseen = vi.fn()
    const joinedReport = vi.fn()

    trackProjectClone(KEY, () => clone.promise, { watch: () => false, reportUnseen })
    trackProjectClone(KEY, () => clone.promise, { watch: () => false, reportUnseen: joinedReport })
    trackProjectClone(KEY, () => clone.promise, { watch: () => false, reportUnseen: joinedReport })

    clone.resolve(FAILED)
    await Promise.resolve()

    // Why once: one clone failing is one event, and the composer that started it owns the report.
    expect(reportUnseen).toHaveBeenCalledExactlyOnceWith(FAILED)
    expect(joinedReport).not.toHaveBeenCalled()
  })

  it('reports nothing when any watcher showed the outcome', async () => {
    const clone = deferred()
    const reportUnseen = vi.fn()
    const shown = vi.fn(() => true)

    trackProjectClone(KEY, () => clone.promise, { watch: () => false, reportUnseen })
    trackProjectClone(KEY, () => clone.promise, { watch: shown, reportUnseen })

    clone.resolve(FAILED)
    await Promise.resolve()

    expect(shown).toHaveBeenCalledWith(FAILED)
    expect(reportUnseen).not.toHaveBeenCalled()
  })

  it('still asks every watcher after one of them showed the outcome', async () => {
    const clone = deferred()
    const later = vi.fn(() => false)

    trackProjectClone(KEY, () => clone.promise, { watch: () => true, reportUnseen: vi.fn() })
    trackProjectClone(KEY, () => clone.promise, { watch: later, reportUnseen: vi.fn() })

    clone.resolve(FAILED)
    await Promise.resolve()

    // Why: a composer that could have shown it must not be left blank because another one did.
    expect(later).toHaveBeenCalledWith(FAILED)
  })

  it('keeps a throwing watcher from starving the ones after it', async () => {
    const clone = deferred()
    const shown = vi.fn(() => true)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    trackProjectClone(KEY, () => clone.promise, {
      watch: () => {
        throw new Error('onProvisioned blew up')
      },
      reportUnseen: vi.fn()
    })
    trackProjectClone(KEY, () => clone.promise, { watch: shown, reportUnseen: vi.fn() })

    clone.resolve(FAILED)
    await Promise.resolve()

    expect(shown).toHaveBeenCalledWith(FAILED)
    consoleError.mockRestore()
  })

  it('releases the key before the watchers run, so a watcher that clones gets a fresh entry', async () => {
    const clone = deferred()
    const retried = vi.fn()

    trackProjectClone(KEY, () => clone.promise, {
      watch: () => {
        // Why: a composer that re-clones from inside its watcher must not join the settled entry.
        expect(isProjectCloneInFlight(KEY)).toBe(false)
        void trackProjectClone(KEY, () => Promise.resolve({ kind: 'abandoned' }), {
          watch: retried,
          reportUnseen: vi.fn()
        })
        return true
      },
      reportUnseen: vi.fn()
    })

    clone.resolve(FAILED)
    await Promise.resolve()
    await Promise.resolve()

    expect(retried).toHaveBeenCalledWith({ kind: 'abandoned' })
  })
})
