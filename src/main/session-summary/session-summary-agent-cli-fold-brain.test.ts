import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { createAgentCliSessionFoldBrain } from './session-summary-agent-cli-fold-brain'

function brain(resolveParams: () => ResolvedSourceControlAiGenerationParams | null, cwd: string) {
  return createAgentCliSessionFoldBrain({ resolveParams, cwd })
}

const SIGNAL = new AbortController().signal

describe('session-summary fold brain', () => {
  // The transcript is the user's; an unusable choice must not become a different provider.
  it('refuses to fold when no agent is usable instead of substituting one', async () => {
    await expect(
      brain(() => null, join(tmpdir(), 'orca-session-summary-unused')).complete({
        prompt: 'summarize',
        signal: SIGNAL
      })
    ).rejects.toThrow(/Choose one in Settings/)
  })

  it('creates its scratch directory before spawning', async () => {
    const cwd = join(tmpdir(), `orca-session-summary-brain-test-${process.pid}`)

    await expect(
      brain(
        () => ({
          agentId: 'custom',
          model: '',
          customAgentCommand: 'orca-nonexistent-binary-for-test'
        }),
        cwd
      ).complete({ prompt: 'summarize', signal: SIGNAL })
    ).rejects.toThrow()

    expect(existsSync(cwd)).toBe(true)
  })
})
