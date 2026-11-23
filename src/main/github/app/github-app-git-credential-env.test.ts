import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** A temp repo with `origin` at `url`, and an env whose HOME holds no global config of its own. */
function repoWithOrigin(url: string): { folder: string; baseEnv: NodeJS.ProcessEnv } {
  const folder = mkdtempSync(join(tmpdir(), 'orca-app-git-'))
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: folder, encoding: 'utf8' })
  git(['init', '-q', '.'])
  git(['remote', 'add', 'origin', url])
  return { folder, baseEnv: { PATH: process.env.PATH ?? '', HOME: folder } }
}

/** The URL git itself says it would push to under `env`, which is the rewrite actually taking effect. */
function pushUrl(folder: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['remote', 'get-url', '--push', 'origin'], {
    cwd: folder,
    env,
    encoding: 'utf8'
  }).trim()
}

/** What git's own config reader gets back out of a written config file. */
function helpersGitReads(text: string): string[] {
  const path = join(mkdtempSync(join(tmpdir(), 'orca-app-config-')), 'config')
  writeFileSync(path, text)
  return execFileSync('git', ['config', '--file', path, '--get-all', 'credential.helper'], {
    encoding: 'utf8'
  })
    .split('\n')
    .filter((line) => line.length > 0)
}

describe('appBoundGitEnv', () => {
  it('empties any configured helper before naming Orca’s, so nothing else can answer first', () => {
    const env = appBoundGitEnv({ repoFolder: REPO, baseEnv: baseEnv() })
    expect(entries(env).slice(0, 2)).toEqual([
      ['credential.helper', ''],
      ['credential.helper', expect.stringContaining('git-credential --repo')]
    ])
  })

  it('asks git to name the repository, so the helper can refuse another one', () => {
    const env = appBoundGitEnv({ repoFolder: REPO, baseEnv: baseEnv() })
    expect(entries(env)).toContainEqual(['credential.https://github.com.useHttpPath', 'true'])
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
    expect(entries(env)).toHaveLength(9)
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper')
    expect(env.GIT_CONFIG_KEY_9).toBeUndefined()
  })

  it('quotes a repository folder with a space, so the helper still runs one argument', () => {
    const env = appBoundGitEnv({ repoFolder: '/Users/a b/repo', baseEnv: baseEnv() })
    expect(env.GIT_CONFIG_VALUE_1).toBe("!orca-np git-credential --repo '/Users/a b/repo'")
  })

  it('rewrites every SSH spelling of github.com, ssh.github.com:443 included, to HTTPS', () => {
    const spellings = [
      'git@github.com:nplez1/orca.git',
      'git@ssh.github.com:nplez1/orca.git',
      'ssh://git@github.com/nplez1/orca.git',
      'ssh://git@github.com:22/nplez1/orca.git',
      'ssh://git@ssh.github.com/nplez1/orca.git',
      'ssh://git@ssh.github.com:443/nplez1/orca.git'
    ]
    for (const url of spellings) {
      const { folder, baseEnv: clean } = repoWithOrigin(url)
      const env = appBoundGitEnv({ repoFolder: folder, baseEnv: clean })
      expect(pushUrl(folder, env)).toBe('https://github.com/nplez1/orca.git')
    }
  })

  it('leaves a user pushInsteadOf winning, which is why Orca reads the push URL back', () => {
    const { folder, baseEnv: clean } = repoWithOrigin('https://github.com/nplez1/orca.git')
    execFileSync('git', ['config', 'url.git@github.com:.pushInsteadOf', 'https://github.com/'], {
      cwd: folder
    })
    // git applies pushInsteadOf to the original URL and never rewrites the result again, so this one wins.
    expect(pushUrl(folder, appBoundGitEnv({ repoFolder: folder, baseEnv: clean }))).toBe(
      'git@github.com:nplez1/orca.git'
    )
  })
})

describe('appGitConfigFile', () => {
  it('carries the same directives, and includes the global config so the user keeps their own', () => {
    const text = appGitConfigFile({ repoFolder: REPO, baseEnv: baseEnv() })
    expect(text).toContain('[include]')
    expect(text).toContain('path = "/Users/someone/.config/git/config"')
    expect(text).toContain('\thelper =\n')
    expect(text).toContain('useHttpPath = true')
    expect(text).toContain('insteadOf = git@ssh.github.com:')
    expect(text).toContain('insteadOf = ssh://git@ssh.github.com:443/')
  })

  it('honours GIT_CONFIG_GLOBAL=/dev/null instead of re-including a global config the user disabled', () => {
    const text = appGitConfigFile({
      repoFolder: REPO,
      baseEnv: { ...baseEnv(), GIT_CONFIG_GLOBAL: '/dev/null' }
    })
    expect(text).not.toContain('[include]')
  })

  it('survives a folder with an apostrophe, which git reads back as the helper it was given', () => {
    const text = appGitConfigFile({
      repoFolder: "/Users/o'neil/Code/orca",
      baseEnv: { ...baseEnv(), GIT_CONFIG_GLOBAL: '/dev/null' }
    })
    expect(helpersGitReads(text)).toEqual([
      "!orca-np git-credential --repo '/Users/o'\\''neil/Code/orca'"
    ])
  })

  it('keeps a folder on one line, so it cannot end the header comment or a directive', () => {
    const text = appGitConfigFile({
      repoFolder: '/Users/a/repo\n[credential]\n\thelper = attacker',
      baseEnv: { ...baseEnv(), GIT_CONFIG_GLOBAL: '/dev/null' }
    })
    expect(text.match(/^\[credential\]$/gm)).toHaveLength(1)
    expect(text).not.toMatch(/^\thelper = attacker$/m)
  })
})
