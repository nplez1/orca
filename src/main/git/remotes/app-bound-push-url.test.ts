import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

const { APP_BOUND_GIT_ENV_MARKER } = await import('../../github/app/github-app-git-credential-env')
const { assertAppBoundPushUrl } = await import('./app-bound-push-url')

/** The env `appBoundGitEnv` builds, as far as this reads it: git's config keys plus the marker. */
function appEnv(): NodeJS.ProcessEnv {
  return { [APP_BOUND_GIT_ENV_MARKER]: '1', GIT_TERMINAL_PROMPT: '0' }
}

function pushUrlIs(url: string): void {
  gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: `${url}\n`, stderr: '' })
}

/** The message a refusal carried; a resolution is a failed expectation, not an empty message. */
async function refusal(push: Promise<void>): Promise<string> {
  const error = await push.then(
    () => {
      throw new Error('expected the push to be refused')
    },
    (caught: unknown) => caught
  )
  return error instanceof Error ? error.message : String(error)
}

describe('assertAppBoundPushUrl', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })
  it('reads back the URL git would push to, under the App’s own environment', async () => {
    pushUrlIs('https://github.com/nplez1/orca.git')
    await expect(
      assertAppBoundPushUrl('/repo', 'origin', { env: appEnv() })
    ).resolves.toBeUndefined()
  })

  it('refuses when a second push URL is not the App’s, which a first-only read would miss', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://github.com/nplez1/orca.git\ngh-work:nplez1/orca.git\n',
      stderr: ''
    })
    const message = await refusal(assertAppBoundPushUrl('/repo', 'origin', { env: appEnv() }))
    expect(message).toContain('gh-work:nplez1/orca.git')
  })

  it('refuses a push URL the App’s rewrite never reached, so it cannot act as the user', async () => {
    pushUrlIs('git@github.com:nplez1/orca.git')
    const message = await refusal(assertAppBoundPushUrl('/repo', 'origin', { env: appEnv() }))
    expect(message).toContain('git@github.com:nplez1/orca.git')
    expect(message).toContain('origin')
  })

  it('refuses another host, which the App’s token does not act on', async () => {
    pushUrlIs('https://ghe.example.com/o/r.git')
    await expect(assertAppBoundPushUrl('/repo', 'origin', { env: appEnv() })).rejects.toThrow(
      /ghe\.example\.com/
    )
  })

  it('shows the URL without any credentials it may carry', async () => {
    pushUrlIs('https://x-access-token:ghs_secret@ghe.example.com/o/r.git')
    const message = await refusal(assertAppBoundPushUrl('/repo', 'origin', { env: appEnv() }))
    expect(message).toContain('https://ghe.example.com/o/r.git')
    expect(message).not.toContain('ghs_secret')
  })

  it('leaves a repository that is not bound to an App alone', async () => {
    await expect(assertAppBoundPushUrl('/repo', 'origin', {})).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
