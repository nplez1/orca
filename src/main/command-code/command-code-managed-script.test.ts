import { afterEach, describe, expect, it } from 'vitest'
import { buildCommandCodeManagedScript } from './command-code-managed-script'

const originalPlatform = process.platform

function onPlatform(platform: NodeJS.Platform, run: () => void): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('buildCommandCodeManagedScript', () => {
  it('recovers this build’s own agent-hook endpoints, never an official install’s', () => {
    const script = buildCommandCodeManagedScript('posix')

    expect(script).toContain('Application Support/orca-np/agent-hooks')
    expect(script).toContain('Application Support/orca-np-dev/agent-hooks')
    expect(script).toContain('Application Support/orca-dev-wt')
    expect(script).not.toContain('Application Support/orca/agent-hooks')
  })

  it('recovers the same endpoints from %APPDATA% on Windows', () => {
    onPlatform('win32', () => {
      const script = buildCommandCodeManagedScript('local')

      expect(script).toContain('%APPDATA%\\orca-np\\agent-hooks')
      expect(script).toContain('%APPDATA%\\orca-np-dev\\agent-hooks')
      expect(script).not.toContain('%APPDATA%\\orca\\agent-hooks')
    })
  })
})
