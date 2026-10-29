import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appImageNamespaceKey,
  resolveAppImageGenerationOfExecutable
} from './appimage-cache-identity'

const cacheRoot = '/home/me/.cache/orca/appimage'
const namespaceKey = appImageNamespaceKey('/home/me/Applications/Orca NP.AppImage')
const generationKey = 'a'.repeat(24)
const generationRoot = join(cacheRoot, namespaceKey, generationKey)

describe('resolveAppImageGenerationOfExecutable', () => {
  // Why both: electron-builder.np.config.cjs renames this fork's Linux executable to `orca-np`,
  // while a generation cached by an earlier build still runs as upstream's `orca-ide`.
  it.each(['orca-np', 'orca-ide'])('finds the generation an %s executable runs from', (name) => {
    expect(resolveAppImageGenerationOfExecutable(join(generationRoot, name))).toEqual({
      cacheRootPath: cacheRoot,
      namespaceKey,
      generationKey,
      rootPath: generationRoot
    })
  })

  it('finds the generation from the bundled Node runtime the daemon runs on', () => {
    expect(
      resolveAppImageGenerationOfExecutable(
        join(generationRoot, 'resources', 'node-runtime', 'bin', 'node')
      )
    ).toMatchObject({ rootPath: generationRoot })
  })

  it('ignores an executable outside a generation root', () => {
    expect(resolveAppImageGenerationOfExecutable('/usr/bin/orca-np')).toBeNull()
    expect(resolveAppImageGenerationOfExecutable(join(generationRoot, 'orca'))).toBeNull()
  })
})
