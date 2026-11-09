import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { APP_DISPLAY_NAME } from '../../shared/app-display-name'
import {
  LOCAL_BUILD_COMPATIBILITY_FILENAME,
  type LocalBuildCompatibility
} from '../../shared/local-build-compatibility'
import { loadLocalBuildCandidate } from './local-build-candidate'
import { startLocalBuildFeed } from './local-build-feed-server'

const run = promisify(execFile)

const tempDirectories: string[] = []

function compatibility(): LocalBuildCompatibility {
  return {
    formatVersion: 1,
    appId: 'com.nplez1.orca',
    buildId: '1.2.3-local.1-abc-arm64',
    version: '1.2.3-local.1',
    commit: 'abc',
    stateSchemaVersion: 1,
    readableStateSchemaVersions: [1],
    daemonProtocolVersion: 28,
    attachableDaemonProtocolVersions: [28],
    platform: 'darwin',
    architecture: 'arm64'
  }
}

async function fixture(options: { sha512?: string; url?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-local-build-'))
  tempDirectories.push(directory)
  const artifactName = 'orca-macos-arm64.zip'
  const artifactPath = join(directory, artifactName)
  const content = Buffer.from('signed-zip-placeholder')
  await writeFile(artifactPath, content)
  const manifestPath = join(directory, 'latest-mac.yml')
  await writeFile(
    manifestPath,
    stringify({
      version: compatibility().version,
      files: [
        {
          url: options.url ?? artifactName,
          sha512: options.sha512 ?? createHash('sha512').update(content).digest('base64'),
          size: content.length
        },
        {
          url: 'orca-macos-arm64.dmg',
          sha512: Buffer.alloc(64).toString('base64'),
          size: 1
        }
      ]
    })
  )
  return { artifactPath, directory, manifestPath }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('loadLocalBuildCandidate', () => {
  it('rejects symlinked artifacts', async () => {
    const { artifactPath, directory, manifestPath } = await fixture()
    const realArtifact = join(directory, 'real.zip')
    await writeFile(realArtifact, 'signed-zip-placeholder')
    await rm(artifactPath)
    await symlink(realArtifact, artifactPath)

    await expect(
      loadLocalBuildCandidate(manifestPath, 'arm64', {
        readCompatibility: async () => compatibility()
      })
    ).rejects.toThrow('regular files, not links')
  })

  // Why: the zip is rooted at the bundle name, so a path naming upstream's bundle reads nothing and
  // every local build is rejected as "predates local switching".
  it.skipIf(process.platform !== 'darwin')(
    'reads the compatibility file out of a zip rooted at this build’s bundle',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'orca-local-build-zip-'))
      tempDirectories.push(directory)
      const resources = join(directory, 'stage', `${APP_DISPLAY_NAME}.app`, 'Contents', 'Resources')
      await mkdir(resources, { recursive: true })
      await writeFile(
        join(resources, LOCAL_BUILD_COMPATIBILITY_FILENAME),
        JSON.stringify(compatibility())
      )
      const artifactPath = join(directory, 'orca-macos-arm64.zip')
      await run('zip', ['-qr', artifactPath, `${APP_DISPLAY_NAME}.app`], {
        cwd: join(directory, 'stage')
      })
      const content = await readFile(artifactPath)
      const manifestPath = join(directory, 'latest-mac.yml')
      await writeFile(
        manifestPath,
        stringify({
          version: compatibility().version,
          files: [
            {
              url: 'orca-macos-arm64.zip',
              sha512: createHash('sha512').update(content).digest('base64'),
              size: content.length
            }
          ]
        })
      )

      const candidate = await loadLocalBuildCandidate(manifestPath, 'arm64')
      await candidate.close()

      expect(candidate.version).toBe(compatibility().version)
    }
  )

  it('serves the same artifact descriptor that passed validation', async () => {
    const { artifactPath, directory, manifestPath } = await fixture()
    const movedArtifactPath = join(directory, 'validated.zip')
    const candidate = await loadLocalBuildCandidate(manifestPath, 'arm64', {
      readCompatibility: async () => {
        await rename(artifactPath, movedArtifactPath)
        await writeFile(artifactPath, 'replacement')
        return compatibility()
      }
    })
    const feed = await startLocalBuildFeed(candidate)
    try {
      await expect(
        fetch(`${feed.url}orca-macos-arm64.zip`).then((response) => response.text())
      ).resolves.toBe('signed-zip-placeholder')
    } finally {
      await feed.close()
    }
  })
})
