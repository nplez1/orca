import { expect, it, vi } from 'vitest'
import { SetupRunnerAnnouncements } from './orca-runtime-setup-runner-state'

// One announcement per worktree, cleared only after its last runner: a second runner must not
// un-announce the first, and a repeated end signal must not clear a worktree that still has one.
it('announces a worktree once however many setup runners it has, and clears after the last', () => {
  const announce = vi.fn()
  const announcements = new SetupRunnerAnnouncements(announce)
  const stopped: string[] = []

  announcements.start('pty-a', 'wt', () => stopped.push('pty-a'))
  announcements.start('pty-b', 'wt', () => stopped.push('pty-b'))
  expect(announce.mock.calls).toEqual([['wt', true]])
  expect(announcements.runningWorktreeIdsSnapshot()).toEqual(['wt'])

  announcements.end('pty-a')
  announcements.end('pty-a')
  expect(announce.mock.calls).toEqual([['wt', true]])
  expect(stopped).toEqual(['pty-a'])

  announcements.end('pty-b')
  expect(announce.mock.calls).toEqual([
    ['wt', true],
    ['wt', false]
  ])
  expect(announcements.runningWorktreeIdsSnapshot()).toEqual([])
})

it('reports the PTY it is already watching, so a second arm cannot double-count it', () => {
  const announcements = new SetupRunnerAnnouncements(() => {})

  announcements.start('pty-a', 'wt', () => {})

  expect(announcements.isObserving('pty-a')).toBe(true)
  expect(announcements.isObserving('pty-b')).toBe(false)
})

it('ends nothing for a PTY it never watched', () => {
  const announce = vi.fn()
  const announcements = new SetupRunnerAnnouncements(announce)

  announcements.end('pty-unknown')

  expect(announce).not.toHaveBeenCalled()
})
