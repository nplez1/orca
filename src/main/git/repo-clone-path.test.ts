import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveValidatedClonePath, resolveCloneDestination } from './repo-clone-path'

const HOME = '/home/me'

describe('resolveCloneDestination', () => {
  it('expands a home-prefixed destination against the home of the machine that owns it', () => {
    expect(resolveCloneDestination('~/src', HOME)).toBe(join(HOME, 'src'))
  })

  it('treats a bare ~ as the whole home folder', () => {
    expect(resolveCloneDestination('~', HOME)).toBe(HOME)
  })

  it('trims padding around an absolute destination', () => {
    expect(resolveCloneDestination('  /data/checkouts  ', HOME)).toBe('/data/checkouts')
  })

  it('refuses a relative destination, which would land in the process cwd', () => {
    expect(() => resolveCloneDestination('src', HOME)).toThrow(
      'Clone destination must be an absolute path'
    )
  })

  it('refuses an empty destination', () => {
    expect(() => resolveCloneDestination('', HOME)).toThrow(
      'Clone destination must be an absolute path'
    )
  })
})

describe('deriveValidatedClonePath', () => {
  it('derives a home-prefixed destination into this machine’s home', () => {
    expect(
      deriveValidatedClonePath({ url: 'https://github.com/o/r.git', destination: '~/src' })
    ).toBe(join(homedir(), 'src', 'r'))
  })
})
