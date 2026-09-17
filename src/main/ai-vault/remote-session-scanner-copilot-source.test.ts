import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'

/**
 * Copilot's layout on a remote host: one directory per session whose transcript
 * sits at a fixed child path, beside artifact trees that hold no sessions. The
 * source is its own module, so its discovery rules are asserted here rather than
 * inside the shared scanner suite.
 */
describe('remote Copilot session sources', () => {
  it('lists only Copilot session dirs when a session carries artifact transcripts', async () => {
    const provider = new MemoryRemoteProvider()
    const sessionId = 'c3d4e5f6-3333-4444-8555-666677778888'
    const sessionDir = `/home/ada/.copilot/session-state/${sessionId}`
    provider.addFile(
      `${sessionDir}/events.jsonl`,
      jsonLines([
        {
          type: 'session.start',
          data: {
            sessionId,
            startTime: '2026-05-01T10:00:00.000Z',
            context: { cwd: '/home/ada/repo' }
          },
          timestamp: '2026-05-01T10:00:00.000Z'
        },
        {
          type: 'session.info',
          data: {
            infoType: 'folder_trust',
            message: 'Folder /home/ada/other has been added to trusted folders.'
          },
          timestamp: '2026-05-01T10:00:05.000Z'
        },
        {
          type: 'user.message',
          data: { transformedContent: 'Remote Copilot session' },
          timestamp: '2026-05-01T10:00:10.000Z'
        }
      ]),
      40
    )
    // Artifact trees sit beside events.jsonl and hold no sessions.
    provider.addFile(
      `${sessionDir}/files/artifact.jsonl`,
      jsonLines([
        {
          type: 'user.message',
          data: { transformedContent: 'Not a session' },
          timestamp: '2026-05-01T10:00:20.000Z'
        }
      ]),
      41
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual([sessionId])
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'ssh:dev-box',
      executionHostPlatform: 'linux',
      agent: 'copilot',
      cwd: '/home/ada/repo',
      filePath: `${sessionDir}/events.jsonl`
    })
  })
})
