import { describe, expect, it } from 'vitest'
import { RuntimeClientError } from '../runtime-client'
import { assertSinglePlanSource, getStepsFlag } from './automation-steps-flag'

function flags(entries: [string, string | boolean][]): Map<string, string | boolean> {
  return new Map(entries)
}

describe('--steps-json', () => {
  it('is absent unless the caller passed it', () => {
    expect(getStepsFlag(flags([['prompt', 'Tidy the docs']]))).toBeUndefined()
  })

  it('parses a plan, which is how an agent creates a script-only automation', () => {
    expect(
      getStepsFlag(
        flags([
          [
            'steps-json',
            '[{"kind":"script","command":"pnpm build","timeoutSeconds":1800,"onFailure":"stop"}]'
          ]
        ])
      )
    ).toEqual([{ kind: 'script', command: 'pnpm build', timeoutSeconds: 1800, onFailure: 'stop' }])
  })

  it('refuses a flag with no value, invalid JSON, and a plan the executor would refuse', () => {
    expect(() => getStepsFlag(flags([['steps-json', true]]))).toThrow(RuntimeClientError)
    expect(() => getStepsFlag(flags([['steps-json', '{']]))).toThrow(/not valid JSON/)
    expect(() => getStepsFlag(flags([['steps-json', '[{"kind":"agent","prompt":"Hi"}]']]))).toThrow(
      /is invalid: Step 1 is an agent step with no agentId/
    )
    expect(() =>
      getStepsFlag(
        flags([
          [
            'steps-json',
            '[{"kind":"agent","prompt":"One","agentId":"claude"},{"kind":"script","command":"ls"}]'
          ]
        ])
      )
    ).toThrow(/has to be the last step/)
  })

  it('refuses a request that states its plan twice', () => {
    const steps = [
      {
        kind: 'script' as const,
        command: 'pnpm build',
        timeoutSeconds: 900,
        onFailure: 'stop' as const
      }
    ]
    expect(() => assertSinglePlanSource(flags([['steps-json', '[]']]), steps)).not.toThrow()
    expect(() =>
      assertSinglePlanSource(
        flags([
          ['steps-json', '[]'],
          ['prompt', 'x']
        ]),
        steps
      )
    ).toThrow(/Use either --steps-json or --prompt\/--provider/)
    expect(() =>
      assertSinglePlanSource(
        flags([
          ['steps-json', '[]'],
          ['provider', 'claude']
        ]),
        steps
      )
    ).toThrow(RuntimeClientError)
    // Without a plan the flat flags are the whole input, so nothing is refused.
    expect(() =>
      assertSinglePlanSource(
        flags([
          ['prompt', 'x'],
          ['provider', 'claude']
        ]),
        undefined
      )
    ).not.toThrow()
  })
})
