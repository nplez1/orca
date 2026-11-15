import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRANSCRIPT_WHOLE_FILE_READ_MAX_BYTES } from '../../../native-chat/wsl-transcript-gated-fs'
import { withFullFirstUserPromptCapture } from '../../prompts/session-scanner-first-user-prompt-capture'
import { parseGrokSessionFile } from './session-scanner-grok-parser'
import { parseSessionCandidate } from '../../parsing/session-scanner-candidate-parse'
import { createSessionParseStats } from '../../parse-cache/session-scanner-parse-cache'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

// Why fixed: the parser only carries a file's mtime through, so the wall clock dates the fixture.
const FIXTURE_MTIME_MS = 1_777_634_000_000
const FIXTURE_MODIFIED_AT = new Date(FIXTURE_MTIME_MS).toISOString()

describe('AI Vault Grok session parser', () => {
  it('stores the unwrapped user_query as firstUserPrompt under full capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-grok-first-'))
    tempRoots.push(root)
    const sessionDir = join(root, 'session-1')
    await mkdir(sessionDir, { recursive: true })
    const summaryPath = join(sessionDir, 'summary.json')
    await writeFile(
      summaryPath,
      JSON.stringify({
        info: { id: 'session-1', cwd: '/repo/app' },
        generated_title: 'Grok title',
        created_at: '2026-05-01T10:00:00.000Z',
        updated_at: '2026-05-01T10:05:00.000Z'
      })
    )
    const realAsk = 'fix i18n keep ko workspace worktree and primary'
    await writeFile(
      join(sessionDir, 'chat_history.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          content: [
            {
              type: 'text',
              text: [
                '<user_info>',
                'OS Version: macos',
                'Shell: /opt/homebrew/bin/bash',
                'Workspace Path: /Users/ada/repo',
                "Today's date: 2026-08-01",
                'Note: Prefer using relative paths over absolute paths as tool call args when possible.',
                '</user_info>',
                `<user_query>\n${realAsk}\n</user_query>`
              ].join('\n')
            }
          ],
          timestamp: '2026-05-01T10:00:01.000Z'
        }),
        JSON.stringify({
          type: 'assistant',
          content: 'On it.',
          timestamp: '2026-05-01T10:00:02.000Z'
        })
      ].join('\n')
    )

    const session = await withFullFirstUserPromptCapture(() =>
      parseGrokSessionFile({
        path: summaryPath,
        mtimeMs: FIXTURE_MTIME_MS,
        modifiedAt: FIXTURE_MODIFIED_AT
      })
    )

    expect(session?.firstUserPrompt).toBe(realAsk)
    expect(session?.firstUserPrompt).not.toContain('user_info')
    expect(session?.firstUserPrompt).not.toContain('OS Version')
  })

  it('refuses a summary over the whole-file limit instead of parsing it', async () => {
    // Why: this parser read the whole file into the 384 MB scanner child with no size check, so one
    // oversized summary with inline images took the History list down with it.
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-grok-oversized-'))
    tempRoots.push(root)
    const summaryPath = join(root, 'summary.json')
    // Sparse on purpose: the cap reads the size, so the payload never has to exist.
    const handle = await open(summaryPath, 'w')
    await handle.truncate(TRANSCRIPT_WHOLE_FILE_READ_MAX_BYTES + 1)
    await handle.close()

    await expect(
      parseGrokSessionFile(
        { path: summaryPath, mtimeMs: FIXTURE_MTIME_MS, modifiedAt: FIXTURE_MODIFIED_AT },
        'linux'
      )
    ).rejects.toThrow(/too large/i)
  })

  it('reports an oversized session file as its own scan issue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-grok-issue-'))
    tempRoots.push(root)
    const summaryPath = join(root, 'summary.json')
    const handle = await open(summaryPath, 'w')
    await handle.truncate(TRANSCRIPT_WHOLE_FILE_READ_MAX_BYTES + 1)
    await handle.close()

    const result = await parseSessionCandidate(
      {
        agent: 'grok',
        file: { path: summaryPath, mtimeMs: FIXTURE_MTIME_MS, modifiedAt: FIXTURE_MODIFIED_AT },
        codexHome: null
      },
      {
        platform: 'linux',
        executionHostId: 'local',
        parseStats: createSessionParseStats(),
        listed: true
      }
    )

    expect(result.session).toBeNull()
    expect(result.issue?.path).toBe(summaryPath)
    expect(result.issue?.message).toMatch(/too large/i)
  })
})
