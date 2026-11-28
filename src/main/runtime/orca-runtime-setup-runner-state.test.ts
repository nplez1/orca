import { expect, it, vi } from 'vitest'
import { observeSetupRunnerEnd, SetupRunnerAnnouncements } from './orca-runtime-setup-runner-state'

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

const setupMarker = (token: string): string => `__ORCA_SETUP_COMPLETE__:${token}:0\n`

function observationPorts(recentOutput: string) {
  const listeners = new Set<(data: string) => void>()
  return {
    listeners,
    ports: {
      subscribeToTerminalData: (_ptyId: string, listener: (data: string) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      readRecentOutput: () => recentOutput,
      onEnd: vi.fn()
    }
  }
}

// Whether the marker arrived before or after the observer attached, the arm ends on its own
// token — and only once, so a replayed buffer cannot clear a later runner's state.
it('detaches its own scanner when the replayed output ends the runner first', () => {
  const { listeners, ports } = observationPorts(`installing\n${setupMarker('tok')}`)

  const unsubscribe = observeSetupRunnerEnd('pty-1', 'tok', ports)

  expect(ports.onEnd).toHaveBeenCalledTimes(1)
  expect(listeners.size).toBe(0)
  unsubscribe()
})

it('ends on a setup marker that arrived before the observer attached, and only once', () => {
  const { listeners, ports } = observationPorts(`installing\n${setupMarker('tok')}`)

  const unsubscribe = observeSetupRunnerEnd('pty-1', 'tok', ports)
  expect(ports.onEnd).toHaveBeenCalledTimes(1)

  for (const listener of listeners) {
    listener(setupMarker('tok'))
  }
  expect(ports.onEnd).toHaveBeenCalledTimes(1)

  unsubscribe()
  expect(listeners.size).toBe(0)
})

it('ends on a setup marker that arrives after the observer attached', () => {
  const { listeners, ports } = observationPorts('installing')

  observeSetupRunnerEnd('pty-1', 'tok', ports)
  expect(ports.onEnd).not.toHaveBeenCalled()

  for (const listener of listeners) {
    listener(setupMarker('a-different-token'))
    listener(setupMarker('tok'))
  }

  expect(ports.onEnd).toHaveBeenCalledTimes(1)
})

it('ends when an interrupted runner returns to its prompt (OSC 133;D)', () => {
  const { listeners, ports } = observationPorts('')

  observeSetupRunnerEnd('pty-1', 'tok', ports)
  for (const listener of listeners) {
    listener('\x1b]133;C\x07installing\n\x1b]133;D;130\x07')
  }

  expect(ports.onEnd).toHaveBeenCalledTimes(1)
})
