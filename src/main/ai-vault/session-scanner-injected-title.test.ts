import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import { isolatedScanRoots, jsonLines, writeJsonlFile } from './session-scanner-test-fixtures'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptMessage
} from './transcripts/session-transcript-consumers'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetTranscriptConsumersForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions harness-injected title seeding', () => {
  it('uses Claude last-prompt metadata instead of injected and tool-result user records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-last-prompt-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })

    await writeFile(
      join(roots.claudeProjectsDir, 'project', 'last-prompt.jsonl'),
      jsonLines([
        {
          type: 'user',
          sessionId: 'last-prompt',
          timestamp: '2026-06-11T10:00:00.000Z',
          cwd: '/repo/app',
          isMeta: true,
          message: { role: 'user', content: 'Base directory for this skill: /tmp/skills' }
        },
        {
          type: 'last-prompt',
          sessionId: 'last-prompt',
          lastPrompt: 'Fix the zoom behavior in a separate PR'
        },
        {
          type: 'user',
          sessionId: 'last-prompt',
          timestamp: '2026-06-11T10:00:01.000Z',
          cwd: '/repo/app',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'src/main/window.ts was updated' }]
          }
        }
      ])
    )

    // Enable full capture so an undefined first prompt proves exclusion rather than disabled capture.
    const result = await withFullFirstUserPromptCapture(() =>
      scanAiVaultSessions({
        ...roots,
        platform: 'darwin'
      })
    )

    expect(result.issues).toEqual([])
    expect(result.sessions[0]?.lastUserPrompt).toBe('Fix the zoom behavior in a separate PR')
    expect(result.sessions[0]?.firstUserPrompt).toBeUndefined()
  })

  // #387: the summary skips a harness turn by its `isMeta` as well as by its text, so the flag has to
  // reach the transcript message — an untagged skill body is indistinguishable from a prompt otherwise.
  it('marks a meta Claude turn on the transcript message it publishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-claude-is-meta-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    // Why `writeJsonlFile`: a last line with no terminator is an incomplete write, and the prompt
    // this test asserts on would never be read.
    await writeJsonlFile(join(roots.claudeProjectsDir, 'project', 'meta.jsonl'), [
      {
        type: 'user',
        sessionId: 'meta',
        timestamp: '2026-06-11T10:00:00.000Z',
        cwd: '/repo/app',
        isMeta: true,
        message: { role: 'user', content: 'Base directory for this skill: /tmp/skills' }
      },
      {
        type: 'user',
        sessionId: 'meta',
        timestamp: '2026-06-11T10:00:01.000Z',
        cwd: '/repo/app',
        message: { role: 'user', content: 'fix the zoom behavior' }
      },
      {
        type: 'assistant',
        sessionId: 'meta',
        timestamp: '2026-06-11T10:00:02.000Z',
        cwd: '/repo/app',
        message: { role: 'assistant', content: 'on it' }
      }
    ])

    const messages: TranscriptMessage[] = []
    registerTranscriptConsumer({
      beginRead: () => ({ message: (message) => messages.push(message), finish: () => undefined })
    })
    await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    const meta = messages.find((message) => message.text.startsWith('Base directory'))
    const prompt = messages.find((message) => message.text === 'fix the zoom behavior')
    expect(meta?.isMeta).toBe(true)
    expect(prompt).toBeDefined()
    expect(prompt?.isMeta).toBeUndefined()
  })
})
