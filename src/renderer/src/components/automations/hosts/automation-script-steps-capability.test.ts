import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_SCRIPT_STEPS_RUNTIME_CAPABILITY } from '../../../../../shared/automations/automation-runtime-capabilities'

const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  getRuntimeEnvironmentStatus: async () => ({ capabilities: status.capabilities })
}))

import {
  assertScriptStepsSupported,
  resetAutomationCapabilityProbes
} from './automation-capability-probe'

const host = { kind: 'runtime' as const, environmentId: 'env', pairingRevision: 1 }
const steps = [
  {
    kind: 'script' as const,
    id: 'a',
    script: 'a.sh',
    timeoutSeconds: 5,
    onFailure: 'stop' as const
  }
]

describe('assertScriptStepsSupported', () => {
  beforeEach(() => {
    resetAutomationCapabilityProbes()
  })

  it('refuses to send script steps to an older host, which would run the agent without them', async () => {
    status.capabilities = []
    await expect(assertScriptStepsSupported(host, steps)).rejects.toThrow(/newer Orca/)
    status.capabilities = [AUTOMATION_SCRIPT_STEPS_RUNTIME_CAPABILITY]
    resetAutomationCapabilityProbes()
    await expect(assertScriptStepsSupported(host, steps)).resolves.toBeUndefined()
  })

  it('lets agent-only writes reach any host', async () => {
    status.capabilities = []
    await expect(assertScriptStepsSupported(host, null)).resolves.toBeUndefined()
    await expect(assertScriptStepsSupported(host, undefined)).resolves.toBeUndefined()
  })
})
