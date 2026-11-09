// Fold brain v1: runs the user's configured text-generation agent CLI in
// one-shot mode. The app has no direct model client (see docs/reference/
// session-summary.md); a direct-model brain can replace this without touching
// the fold protocol — it only needs `complete(prompt) -> raw text`.
import {
  getCommitMessageAgentSpec,
  isCustomAgentId
} from '../../shared/source-control/ai/generation/commit-message-agent-spec'
import { planCommitMessageGeneration } from '../../shared/source-control/ai/generation/commit-message-plan'
import type {
  CommitMessagePlan,
  CommitMessagePlanInput
} from '../../shared/source-control/ai/generation/commit-message-plan'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { spawnSourceControlAgent } from '../text-generation/source-control-agent-launch'
import { killSourceControlAgentProcess } from '../text-generation/source-control-local-process'
import type { SpawnSourceControlAgent } from '../text-generation/source-control-text-generation-types'
import { createSessionSummaryScratchDir } from './session-summary-scratch'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from '../text-generation/source-control-generation-limits'
import type { SessionFoldBrain } from './session-summary-fold'

export type AgentCliFoldBrainDeps = {
  /** The configured fold agent; null means nothing usable is selected, which fails the
   *  fold rather than substituting an agent the user did not choose. */
  resolveParams: () => ResolvedSourceControlAiGenerationParams | null
  /** Parent for the per-call scratch cwd; tests point it at their own root. */
  tmpRoot?: string
  /** Test seam: the agent CLI spawn, observed to assert the cwd it runs in. */
  spawnAgent?: SpawnSourceControlAgent
}

export function createAgentCliSessionFoldBrain(deps: AgentCliFoldBrainDeps): SessionFoldBrain {
  return {
    async complete({ prompt, signal }): Promise<string> {
      const params = deps.resolveParams()
      // Why: the summary is the user's transcript. Running an agent they did not pick —
      // or disabled — because their choice was unusable would send it to that provider.
      if (!params) {
        throw new Error('No session-summary agent is configured. Choose one in Settings → Agents.')
      }
      const agentId = params.agentId
      const defaultModel = isCustomAgentId(agentId)
        ? 'default'
        : (getCommitMessageAgentSpec(agentId)?.defaultModelId ?? 'default')
      const input: CommitMessagePlanInput = {
        agentId,
        model: params.model || defaultModel,
        ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
        ...(params.customAgentCommand ? { customAgentCommand: params.customAgentCommand } : {}),
        ...(params.agentCommandOverride
          ? { agentCommandOverride: params.agentCommandOverride }
          : {}),
        ...(params.agentArgs ? { agentArgs: params.agentArgs } : {})
      }
      const planned = planCommitMessageGeneration(input, prompt)
      if (!planned.ok) {
        throw new Error(planned.error)
      }
      const plan = planned.plan
      // Why a directory per call: the CLI loads hooks and project instructions from its cwd, so a
      // fixed path under a shared temp root lets another local user plant them.
      const cwd = createSessionSummaryScratchDir(deps.tmpRoot)
      try {
        return await runAgent({ plan, cwd, signal, spawnAgent: deps.spawnAgent })
      } finally {
        await removeTree(cwd).catch((error: unknown) => {
          console.error('[session-summary] Failed to remove fold scratch dir:', error)
        })
      }
    }
  }
}

async function runAgent(args: {
  plan: CommitMessagePlan
  cwd: string
  signal: AbortSignal
  spawnAgent?: SpawnSourceControlAgent
}): Promise<string> {
  const { plan, cwd, signal } = args
  const spawnAgent = args.spawnAgent ?? spawnSourceControlAgent
  return await new Promise<string>((resolve, reject) => {
    let child
    try {
      child = spawnAgent({
        binary: plan.binary,
        args: plan.args,
        cwd,
        stdinMode: plan.stdinPayload === null ? 'ignore' : 'pipe',
        useCwdForNative: true
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let stdout = ''
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      fn()
    }
    const fail = (message: string): void => {
      settle(() => {
        void killSourceControlAgentProcess(child)
        reject(new Error(message))
      })
    }
    const timer = setTimeout(
      () => fail('session summary fold timed out'),
      SOURCE_CONTROL_GENERATION_TIMEOUT_MS
    )
    const onAbort = (): void => fail('session summary fold canceled')
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (data: Buffer) => {
      if (stdout.length < MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
        stdout += data.toString('utf8')
      }
    })
    child.stderr?.on('data', () => {})
    child.on('error', (error) => fail(error.message))
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      const trimmed = stdout.trim()
      settle(() => {
        if (trimmed) {
          resolve(trimmed)
        } else {
          reject(new Error(`agent CLI produced no output (exit ${code})`))
        }
      })
    })
    if (plan.stdinPayload !== null) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(plan.stdinPayload)
    }
  })
}
