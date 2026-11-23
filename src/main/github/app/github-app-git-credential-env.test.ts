import { describe, expect, it } from 'vitest'
import { appBoundGitEnv, appGitConfigFile } from './github-app-git-credential-env'

const REPO = '/Users/someone/Code/orca'

/** An env with no launcher override, so the helper names the plain CLI command. */
function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin', HOME: '/Users/someone' }
}

/** The indexed-config protocol as git reads it: count, then one key and one value per index. */
function entries(env: NodeJS.ProcessEnv): [string, string][] {
  const count = Number(env.GIT_CONFIG_COUNT)
  return Array.from({ length: count }, (_, index) => [
    String(env[`GIT_CONFIG_KEY_${index}`]),
    String(env[`GIT_CONFIG_VALUE_${index}`])
  ])
}

describe('appBoundGitEnv', () => {
  it('empties any configured helper before naming Orca’s, so nothing else can answer first', () => {
    const env = appBoundGitEnv({ repoFolder: REPO, baseEnv: baseEnv() })
    expect(entries(env).slice(0, 2)).toEqual([
      ['credential.helper', ''],
      ['credential.helper', expect.stringContaining('git-credential --repo')]
    ])
  })

  it('rewrites both SSH spellings of a github.com remote to HTTPS for this child only', () => {
    const env = appBoundGitEnv({ repoFolder: REPO, baseEnv: baseEnv() })
    expect(
      entries(env)
        .filter(([key]) => key === 'url.https://github.com/.insteadOf')
        .map(([, v]) => v)
    ).toEqual(['git@github.com:', 'ssh://git@github.com/'])
  })

  it('never prompts, and carries no token of its own', () => {
    const env = appBoundGitEnv({ repoFolder: REPO, baseEnv: baseEnv() })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(JSON.stringify(entries(env))).not.toMatch(/ghs_|ghu_|token=/)
  })

  it('replaces a caller’s indexed config rather than leaving a count its keys do not match', () => {
    const env = appBoundGitEnv({
      repoFolder: REPO,
      baseEnv: { ...baseEnv(), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name' }
    })
    expect(entries(env)).toHaveLength(4)
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper')
    expect(env.GIT_CONFIG_KEY_4).toBeUndefined()
  })

  it('quotes a repository folder with a space, so the helper still runs one argument', () => {
    const env = appBoundGitEnv({ repoFolder: '/Users/a b/repo', baseEnv: baseEnv() })
    expect(env.GIT_CONFIG_VALUE_1).toBe("!orca-np git-credential --repo '/Users/a b/repo'")
  })
})

describe('appGitConfigFile', () => {
  it('carries the same directives, and includes the global config so the user keeps their own', () => {
    const text = appGitConfigFile({ repoFolder: REPO, baseEnv: baseEnv() })
    expect(text).toContain('[include]')
    expect(text).toContain('path = /Users/someone/.config/git/config')
    expect(text).toContain('\thelper =\n')
    expect(text).toContain('insteadOf = git@github.com:')
    expect(text).toContain('insteadOf = ssh://git@github.com/')
  })

  it('honours GIT_CONFIG_GLOBAL=/dev/null instead of re-including a global config the user disabled', () => {
    const text = appGitConfigFile({
      repoFolder: REPO,
      baseEnv: { ...baseEnv(), GIT_CONFIG_GLOBAL: '/dev/null' }
    })
    expect(text).not.toContain('[include]')
  })
})
