import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOME_DIRECTORY_NAME,
  LEGACY_HOME_DIRECTORY_NAME
} from '../../src/shared/app-directory-names'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Files `git grep -l` matched, with a non-0/1 exit reported instead of read as "no match". */
function gitGrep(args) {
  const result = spawnSync('git', ['grep', '-l', ...args], { cwd: ROOT, encoding: 'utf8' })
  // Why not catch: 1 is "no match" and anything else is a broken run, which must not look green.
  if (result.status === 1) {
    return []
  }
  if (result.status !== 0) {
    throw new Error(`git grep ${args.join(' ')} failed: ${result.stderr || result.status}`)
  }
  return result.stdout.split('\n').filter(Boolean)
}

/**
 * Resolved by search, not by path: upstream relocates these modules (`getSharedManagedScriptPath` is
 * due to move into `installation/scripts/`, the TCC watch already moved into `macos-permissions/`), so
 * a hardcoded import would fail on the move instead of on the behaviour. A re-export does not count —
 * the definition is what the fork has to own.
 */
async function definingModule(exportName, ...roots) {
  const pattern = `^export (async )?(function|const|let) ${exportName}[ (:=<]`
  const found = gitGrep(['-E', pattern, '--', ...roots])
  expect(
    found,
    `expected exactly one module under ${roots.join(', ')} to define ${exportName}`
  ).toHaveLength(1)
  return import(pathToFileURL(join(ROOT, found[0])).href)
}

const source = (path) => readFileSync(join(ROOT, path), 'utf8')

afterEach(() => {
  vi.doUnmock('electron')
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('this build home', () => {
  it('writes the shared managed-hook script under this build home, not the official ~/.orca', async () => {
    const { getSharedManagedScriptPath } = await definingModule(
      'getSharedManagedScriptPath',
      'src/main/agent-hooks'
    )
    const scriptFileName = 'claude-hook.sh'
    const resolved = getSharedManagedScriptPath(scriptFileName)

    expect(resolved).toBe(join(homedir(), HOME_DIRECTORY_NAME, 'agent-hooks', scriptFileName))
    // Why: the assertion above follows HOME_DIRECTORY_NAME, so a revert of that constant would satisfy
    // it. The legacy name is the official install's home, and must never be the one this build writes.
    expect(resolved.split(/[\\/]+/)).not.toContain(LEGACY_HOME_DIRECTORY_NAME)
  })

  it('runs the managed hook from this build home, not the official ~/.orca', async () => {
    const { wrapRuntimeHomeHookCommand } = await definingModule(
      'wrapRuntimeHomeHookCommand',
      'src/main/agent-hooks'
    )
    const command = wrapRuntimeHomeHookCommand('claude-hook')
    // The PowerShell branch travels base64/UTF-16, so it is decoded rather than pattern-matched.
    const encoded = command.match(/-EncodedCommand (\S+)/)?.[1]
    expect(encoded, 'expected the PowerShell branch to be encoded in the command').toBeTruthy()

    for (const [branch, separator] of [
      [command, '/'],
      [Buffer.from(encoded, 'base64').toString('utf16le'), '\\']
    ]) {
      expect(branch).toContain(`${HOME_DIRECTORY_NAME}${separator}agent-hooks${separator}`)
      expect(branch).not.toContain(
        `${LEGACY_HOME_DIRECTORY_NAME}${separator}agent-hooks${separator}`
      )
    }
  })

  it('keeps the managed-hook install lock on the shared ~/.orca', () => {
    const lock = source('src/main/agent-hooks/managed-hook-install-lock.ts')
    // Why not HOME_DIRECTORY_NAME: this is a cross-install mutex over the shared `~/.claude` hooks, so
    // it stays where an official install's installer looks. Moving it to `.orca-np` lets the two
    // installers rewrite one another's hook entries concurrently.
    expect(lock).toContain("const lockParent = join(home, '.orca')")
    expect(lock).not.toContain('HOME_DIRECTORY_NAME')
  })
})

describe('bundle id com.nplez1.orca', () => {
  it('links macOS notification settings to this bundle', async () => {
    const openExternal = vi.fn()
    vi.doMock('electron', () => ({ shell: { openExternal } }))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.stubEnv('ORCA_DEV_MACOS_BUNDLE_ID', undefined)

    const { openNotificationSystemSettings } = await definingModule(
      'openNotificationSystemSettings',
      'src/main/ipc'
    )
    openNotificationSystemSettings()

    // Why the id: System Settings keys the notification pane on the bundle id, so an upstream literal
    // here opens the official install's row and the user never finds this build's toggle.
    expect(openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.nplez1.orca'
    )
  })

  it('attributes TCC prompts for every bundle id this build signs', async () => {
    const { isOrcaAttributedPrompt } = await definingModule(
      'isOrcaAttributedPrompt',
      'src/main/macos-permissions'
    )
    const trusted = (responsibleIdentifier) =>
      isOrcaAttributedPrompt({
        service: 'kTCCServiceSystemPolicyAllFiles',
        accessingIdentifier: 'com.example.probe',
        responsibleIdentifier
      })

    for (const suffix of ['', '.helper', '.dev', '.dev.helper', '.local', '.local.helper']) {
      expect(trusted(`com.nplez1.orca${suffix}`), suffix || '<main>').toBe(true)
    }
    // Why: this set decides whether a consent dialog belongs to this build, so an official install's
    // prompts must stay out of it — otherwise this build pops its own UI for someone else's access.
    expect(trusted('com.stablyai.orca')).toBe(false)
  })

  it('names the app and its AppUserModelId Orca NP', async () => {
    const { getDevInstanceIdentity } = await definingModule(
      'getDevInstanceIdentity',
      'src/main/startup'
    )
    const packaged = getDevInstanceIdentity(false)

    expect(packaged.appName).toBe('Orca NP')
    expect(packaged.name).toBe('Orca NP')
    expect(packaged.appUserModelId).toBe('com.nplez1.orca')
    // Why: app.setName runs before `ready` and macOS fixes the safeStorage Keychain item then, so a
    // per-worktree dev name would mint a new key per branch.
    expect(getDevInstanceIdentity(true, {}).appName).toBe('Orca NP Dev')
  })

  it('keeps the two app-name constants in step', async () => {
    const { getDevInstanceIdentity } = await definingModule(
      'getDevInstanceIdentity',
      'src/main/startup'
    )
    const { getDevBundlePlistPatches } = await definingModule(
      'getDevBundlePlistPatches',
      'config/scripts'
    )
    const names = await definingModule('APP_DISPLAY_NAME', 'src/shared')

    // Why the equality as well as the literals above: renaming one constant and missing the other is
    // the failure this pins, and the two literals alone stay green through a partial rename.
    expect(names.APP_DISPLAY_NAME).toBe('Orca NP')
    expect(getDevInstanceIdentity(false).appName).toBe(names.APP_DISPLAY_NAME)
    const plist = Object.fromEntries(
      getDevBundlePlistPatches().map(({ key, value }) => [key, value])
    )
    expect(plist.CFBundleDisplayName).toBe(names.APP_DEV_DISPLAY_NAME)
  })

  it('ships one appId in both copies of the compatibility contract', () => {
    const contract = JSON.parse(source('src/shared/local-build-compatibility-contract.json'))
    const declared = /appId: '([^']+)'/.exec(
      source('src/shared/local-build-compatibility-contract.ts')
    )

    // Why: the build scripts read the JSON and the app reads the TypeScript copy, so an edit to one
    // leaves the other disagreeing about which bundle id a local build is compatible with.
    expect(contract.appId).toBe('com.nplez1.orca')
    expect(declared?.[1]).toBe(contract.appId)
  })

  it('stamps the dev bundle Orca NP Dev under com.nplez1.orca.dev', async () => {
    const { getDevBundlePlistPatches, getDevHelperPlistPatches } = await definingModule(
      'getDevBundlePlistPatches',
      'config/scripts'
    )
    const patches = Object.fromEntries(
      getDevBundlePlistPatches().map(({ key, value }) => [key, value])
    )

    expect(patches).toMatchObject({
      CFBundleIdentifier: 'com.nplez1.orca.dev',
      CFBundleName: 'Orca NP Dev',
      CFBundleDisplayName: 'Orca NP Dev'
    })
    expect(getDevHelperPlistPatches()).toEqual([
      { key: 'CFBundleIdentifier', value: 'com.nplez1.orca.dev.helper' }
    ])
  })
})

describe('repository nplez1/orca', () => {
  it('resolves the release feed to the fork on every channel it offers', async () => {
    const { getReleaseRepoForChannel } = await definingModule(
      'getReleaseRepoForChannel',
      'src/shared'
    )

    // Why every channel: a dev channel persisted by an older build still reaches this map, and
    // resolving it to upstream's repo updates an Orca NP install into an official Orca.
    for (const channel of ['stable', 'rc', 'hourly', 'daily', 'adhoc']) {
      expect(getReleaseRepoForChannel(channel), channel).toBe('nplez1/orca')
    }
  })

  it('installs skills from the fork tree at the build commit', async () => {
    const { buildAgentFeatureSkillInstallArgs } = await definingModule(
      'buildAgentFeatureSkillInstallArgs',
      'src/shared'
    )
    const args = buildAgentFeatureSkillInstallArgs(['electron'], { sourceCommit: 'c0ffee1' })

    // Why the pair: the pinned commit only exists in this fork, so a tree URL at upstream is a 404 —
    // and the fork's own commit under upstream's repository installs an incoherent pair.
    expect(args).toContain('https://github.com/nplez1/orca/tree/c0ffee1')
  })

  it('downloads release assets from the fork', async () => {
    const { getReleaseAssetUrl } = await definingModule('getReleaseAssetUrl', 'src/main')

    // Why: the base URL is built from RELEASES_REPO, so the source never spells upstream's feed and
    // the leak scan below cannot see a revert here. This is the assertion that can.
    expect(getReleaseAssetUrl('v1.2.3', 'Orca-NP-1.2.3-arm64-mac.zip')).toBe(
      'https://github.com/nplez1/orca/releases/download/v1.2.3/Orca-NP-1.2.3-arm64-mac.zip'
    )
  })

  it('names no upstream release feed in product source', () => {
    // Why this fragment and not the bare slug: the product's own updater URL is the one place a sync
    // can silently re-point this build at upstream's releases. The bare slug also names CLI examples,
    // fixtures and plugin URLs, which are legitimate and would red the nightly on every sync.
    expect(
      gitGrep([
        '-F',
        'stablyai/orca/releases',
        '--',
        'src',
        ':(exclude)*.test.*',
        ':(exclude)*.spec.*'
      ])
    ).toEqual([])
  })

  it('checks the mac helper against APPLE_TEAM_ID when it is set', () => {
    const config = source('config/electron-builder.config.cjs')
    const declaration = /^const ORCA_MAC_TEAM_ID = (.+)$/m.exec(config)

    expect(declaration, 'expected one `const ORCA_MAC_TEAM_ID = …` line').toBeTruthy()
    // Why evaluate rather than pattern-match: the invariant is that the env wins, and only running the
    // expression proves it. Upstream's bare '6CX3WHS9HZ' fails here, and so does a reversed `??`.
    const team = runInNewContext(declaration[1], {
      process: { env: { APPLE_TEAM_ID: 'TEAM000000' } }
    })
    expect(team).toBe('TEAM000000')
    // Why: a notarized helper is verified only under the release flag, and it must read this constant
    // rather than carrying an inlined literal of its own.
    expect(config).toContain('expectedTeamId: isMacRelease ? ORCA_MAC_TEAM_ID : null')
  })
})

describe('install-owned names', () => {
  const serveInput = (platform) => ({
    platform,
    homeDir: '/Users/probe',
    command: '/usr/local/bin/orca-np',
    userDataPath: '/Users/probe/Library/Application Support/orca-np',
    defaultUserDataPath: '/Users/probe/Library/Application Support/orca-np',
    path: '/usr/bin:/bin'
  })

  it('names the serve unit and its log after this build', async () => {
    const { renderServeService } = await definingModule('renderServeService', 'src/cli')

    // Why: launchd and systemd units are per-user singletons, so installing under upstream's label
    // replaced the official install's supervisor on every `serve service install`.
    const launchd = renderServeService(serveInput('darwin'))
    expect(launchd.name).toBe('com.nplez1.orca.serve')
    expect(launchd.unitPath).toBe('/Users/probe/Library/LaunchAgents/com.nplez1.orca.serve.plist')
    expect(launchd.logPath).toBe('/Users/probe/Library/Logs/orca-np/com.nplez1.orca.serve.log')

    const systemd = renderServeService(serveInput('linux'))
    expect(systemd.name).toBe('orca-np-serve.service')
    expect(systemd.unitPath).toBe('/Users/probe/.config/systemd/user/orca-np-serve.service')
  })

  it('falls back to an orca-np-dev profile for a dev launch', async () => {
    const { resolveLaunchUserDataPath } = await definingModule(
      'resolveLaunchUserDataPath',
      'src/cli'
    )
    const resolved = resolveLaunchUserDataPath({ ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT: '1' })

    // Why: a dev launch that fell back to upstream's `orca-dev` profile would read and rewrite the
    // official install's settings, sessions and provider credentials.
    expect(resolved.split(/[\\/]+/).pop()).toBe('orca-np-dev')
  })

  it('links /usr/bin/orca-np after a Linux install', () => {
    const afterInstall = source('resources/linux/packaging/after-install.sh')

    // Why: an official install owns `orca-ide`, and a headless host has no in-app installer to fall
    // back on, so this symlink is the only thing that puts this build's CLI on PATH there.
    expect(afterInstall).toMatch(/^link="\/usr\/bin\/orca-np"$/m)
    expect(afterInstall).toContain('ln -sfn -- "$shim" "$link"')
  })

  it('routes pane URLs to this build launcher, not a bare orca', async () => {
    const { buildPtyHostEnv } = await definingModule('buildPtyHostEnv', 'src/main/ipc')
    // Why: the branch is skipped when the pane or the test host already exports BROWSER, which VS Code
    // devcontainers and Codespaces do — that would turn this into a silent no-op.
    vi.stubEnv('BROWSER', undefined)
    const env = buildPtyHostEnv(
      'fork-invariants',
      {},
      {
        isPackaged: false,
        userDataPath: join(ROOT, '.probe-userdata'),
        selectedCodexHomePath: null,
        agentStatusHooksEnabled: false,
        routeBrowserOpensToClient: true,
        networkProxySettings: { mode: 'none' }
      }
    )

    // Why the basename: BROWSER is word-split by its consumers, so the bundle path this resolves from
    // would break on the space in "Orca NP.app". A bare `orca` is GNOME's screen reader on Linux and
    // an official install's CLI elsewhere, so a URL opened from a pane would never reach this build.
    const launcher = process.platform === 'win32' ? 'orca-np-dev.cmd' : 'orca-np-dev'
    expect(env.BROWSER).toBe(`${launcher} open-url --url %s`)
  })
})

describe('LOCAL-PATCHES guards', () => {
  it('cites only guard files that exist in the install-owned names table', () => {
    const lines = source('LOCAL-PATCHES.md').split('\n')
    const start = lines.findIndex((line) =>
      line.startsWith('#### The names one install owns below the bundle id')
    )
    expect(start, 'missing the install-owned names section').toBeGreaterThan(-1)
    const end = lines.findIndex((line, index) => index > start && line.startsWith('#### '))
    const rows = lines
      .slice(start, end === -1 ? undefined : end)
      .filter((line) => line.startsWith('|'))

    const cited = rows.flatMap((row) => [
      ...row.matchAll(/`([^`]*\.(?:test|spec)\.[cm]?[jt]sx?)`/g)
    ])
    expect(cited.length, 'expected the table to cite guard files').toBeGreaterThan(5)

    // Why: this is the failure mode of #312 — upstream deleted the cited guard files and nothing
    // noticed until a fork review weeks later. A deleted guard has to red here instead.
    const missing = [...new Set(cited.map((match) => match[1]))].filter(
      (path) => !existsSync(join(ROOT, path))
    )
    expect(missing).toEqual([])
  })
})
