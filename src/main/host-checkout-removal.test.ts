import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from './asar-transparent-fs'
import { removeHostCheckout } from './host-tree-removal'
import { leftoverCheckoutFolderOf } from '../shared/worktree/removal'

vi.mock('./asar-transparent-fs', () => ({
  readdir: vi.fn(),
  rm: vi.fn(),
  unlink: vi.fn(),
  rmdir: vi.fn(),
  lstat: vi.fn()
}))
vi.mock('node:timers/promises', () => ({
  // Route promise backoff through the clock installed by vi.useFakeTimers.
  // ast-grep-ignore: test-no-real-time-wait -- Schedules the installed fake clock for production backoff.
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}))
const platform = process.platform
const root = 'C:/checkout-partition'
const busy = Object.assign(new Error('held child'), { code: 'EBUSY' })
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.useFakeTimers()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('settles public child promises before starting another pass or touching the marker', async () => {
  vi.mocked(fs.readdir).mockResolvedValue(['held', 'pending', '.git'])
  const pending = Promise.withResolvers<void>()
  vi.mocked(fs.rm).mockImplementation(async (target) => {
    if (String(target).endsWith('held')) {
      throw busy
    }
    await pending.promise
  })
  const controller = new AbortController()
  const removal = removeHostCheckout(root, async () => true, controller.signal).catch(
    (error: unknown) => error
  )
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fs.unlink).not.toHaveBeenCalled()
  controller.abort()
  pending.resolve()
  await vi.runAllTimersAsync()
  expect(await removal).toMatchObject({ name: 'AbortError' })
  expect(fs.readdir).toHaveBeenCalledOnce()
})

it('reports the locked child once the transient retries are spent', async () => {
  vi.mocked(fs.readdir).mockResolvedValue(['held', '.git'])
  vi.mocked(fs.rm).mockRejectedValue(
    Object.assign(new Error('held child'), { code: 'EBUSY', path: `${root}/held` })
  )

  const removal = removeHostCheckout(root, async () => true).catch((reason: unknown) => reason)
  await vi.runAllTimersAsync()
  const error = await removal

  expect(leftoverCheckoutFolderOf(error)).toEqual({
    path: root,
    blockingFile: `${root}/held`
  })
  // The marker stays so Git can still release the registration for a folder it cannot empty.
  expect(fs.unlink).not.toHaveBeenCalled()
  // A lock that outlives every transient pass is reported, not retried forever.
  expect(fs.readdir).toHaveBeenCalledTimes(5)
})

it('still deletes a lock that clears inside the transient budget', async () => {
  vi.mocked(fs.readdir).mockResolvedValue(['held', '.git'])
  vi.mocked(fs.rm)
    .mockRejectedValueOnce(Object.assign(new Error('held child'), { code: 'EBUSY' }))
    .mockResolvedValue(undefined)
  vi.mocked(fs.rmdir).mockResolvedValue(undefined)
  vi.mocked(fs.unlink).mockResolvedValue(undefined)

  const removal = removeHostCheckout(root, async () => true)
  await vi.runAllTimersAsync()

  await expect(removal).resolves.toBeUndefined()
  expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('.git'))
})

it('leaves a non-lock child failure as a plain removal failure', async () => {
  vi.mocked(fs.readdir).mockResolvedValue(['denied', '.git'])
  vi.mocked(fs.rm).mockRejectedValue(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))

  const error = await removeHostCheckout(root, async () => true).catch((reason: unknown) => reason)

  expect(leftoverCheckoutFolderOf(error)).toBeUndefined()
  expect(error).toMatchObject({ code: 'EIO' })
  expect(fs.readdir).toHaveBeenCalledOnce()
})
