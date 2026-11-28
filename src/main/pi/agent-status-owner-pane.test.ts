import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_EXTENSION_SELF_PID,
  createAgentStatusExtensionHarness
} from './managed-extensions/agent-status/agent-status-extension-test-harness'

/** The PID an inherited marker names, and the pane the harness's own env reports for. */
const OWNER_PID = 9001
const PANE_KEY = 'pane-1'

const ownerKeyFor = (kind: 'pi' | 'omp' | 'prime-agent'): string =>
  kind === 'prime-agent' ? 'ORCA_PRIME_AGENT_STATUS_OWNED' : 'ORCA_PI_STATUS_OWNED'

const ownerGone = (): never => {
  throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
}

type Case = {
  name: string
  ownerPane: string | undefined
  ownerAlive: boolean
  keepsPane: boolean
  paneless?: boolean
}

/** One owner marker, five inherited states: the pane record is what separates a subagent of this
 *  pane (#8545) from a session reporting for another one, which the PID alone could not (#480). */
const CASES: Case[] = [
  {
    name: 'mutes for a live owner with no pane record',
    ownerPane: undefined,
    ownerAlive: true,
    keepsPane: true
  },
  {
    name: 'mutes for a live owner recorded for this pane',
    ownerPane: PANE_KEY,
    ownerAlive: true,
    keepsPane: true
  },
  {
    name: 'reports when the owner is recorded for another pane',
    ownerPane: 'pane-2',
    ownerAlive: true,
    keepsPane: false
  },
  {
    name: 'reports when the owner is gone',
    ownerPane: PANE_KEY,
    ownerAlive: false,
    keepsPane: false
  },
  {
    name: 'claims without a pane record of its own',
    ownerPane: undefined,
    ownerAlive: false,
    keepsPane: false,
    paneless: true
  }
]

describe.each(['pi', 'omp', 'prime-agent'] as const)('%s pane ownership', (kind) => {
  const ownerKey = ownerKeyFor(kind)

  it.each(CASES)('$name', ({ ownerPane, ownerAlive, keepsPane, paneless }) => {
    const harness = createAgentStatusExtensionHarness({
      kind,
      env: {
        [ownerKey]: String(OWNER_PID),
        [`${ownerKey}_PANE`]: ownerPane,
        ORCA_PANE_KEY: paneless ? undefined : PANE_KEY
      },
      ...(ownerAlive ? {} : { killImpl: ownerGone })
    })

    if (keepsPane) {
      // Standing down is the whole factory returning: no handler, no marker rewrite.
      expect(harness.handlers).toEqual({})
      expect(harness.processEnv[ownerKey]).toBe(String(OWNER_PID))
      return
    }

    expect(harness.handlers.agent_start).toBeTypeOf('function')
    expect(harness.processEnv[ownerKey]).toBe(String(AGENT_STATUS_EXTENSION_SELF_PID))
    // A claim carries its pane, so the next reader can tell this owner from a stale one.
    expect(harness.processEnv[`${ownerKey}_PANE`]).toBe(paneless ? undefined : PANE_KEY)
  })
})
