import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const APP_DATA_PATH = '/tmp/app-data'

vi.mock('electron', () => {
  const paths = new Map<string, string>([['appData', APP_DATA_PATH]])
  return {
    app: {
      getPath: vi.fn((name: string) => paths.get(name) ?? ''),
      setPath: vi.fn((name: string, value: string) => {
        paths.set(name, value)
      }),
      getName: vi.fn(() => 'orca'),
      getVersion: vi.fn(() => '0.0.0'),
      isPackaged: false,
      quit: vi.fn(),
      exit: vi.fn(),
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        getSwitchValue: vi.fn(() => '')
      }
    },
    shell: { openExternal: vi.fn() }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Why (fork): `package.json`'s name is still `orca`, so Electron's default userData would resolve
// `appData/orca` — the official install's profile. Pinning is what keeps this build's state, its
// safeStorage Keychain item, and its CLI runtime pointer out of the other app's directory.
describe('configureDevUserDataPath', () => {
  it('pins packaged runs to the orca-np userData path', async () => {
    const { app } = await import('electron')
    const { configureDevUserDataPath } = await import('./configure-process')

    vi.mocked(app.setPath).mockClear()
    configureDevUserDataPath(false)

    expect(app.setPath).toHaveBeenCalledWith('userData', join(APP_DATA_PATH, 'orca-np'))
  })

  it('pins dev runs to the orca-np-dev userData path', async () => {
    const { app } = await import('electron')
    const { configureDevUserDataPath } = await import('./configure-process')

    vi.stubEnv('ORCA_DEV_USER_DATA_PATH', '')
    vi.mocked(app.setPath).mockClear()
    configureDevUserDataPath(true)

    expect(app.setPath).toHaveBeenCalledWith('userData', join(APP_DATA_PATH, 'orca-np-dev'))
  })
})
