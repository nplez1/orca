import { describe, expect, it } from 'vitest'
import { lookStartFailureWords } from './bot-look-around-start-failure'
import { AgentCliInstallationError } from '../native-chat/agent-launch/agent-cli-installation-error'

const couldNotStart = "The last look couldn't start."
const tooOldPi = (version: string, minimumVersion: string) =>
  AgentCliInstallationError.tooOld('pi', { version, minimumVersion })

describe('what a look records when it could not start', () => {
  it('keeps a too-old agent CLI’s cause beside the generic line', () => {
    expect(lookStartFailureWords(tooOldPi('1.0.3', '1.0.4'), couldNotStart)).toMatch(
      /^The last look couldn't start\. .*1\.0\.3.*1\.0\.4/
    )
  })

  it('finds the cause through the wrappers a launch puts around it', () => {
    const wrapped = new Error('provider start failed', {
      cause: new AggregateError(
        [new Error('spawn failed'), tooOldPi('1.0.2', '1.0.4')],
        'provider start failed'
      )
    })
    expect(lookStartFailureWords(wrapped, couldNotStart)).toMatch(
      /^The last look couldn't start\. .*1\.0\.2.*1\.0\.4/
    )
  })

  it('records the generic line for a failure that is not about the install', () => {
    expect(
      lookStartFailureWords(new Error('tab visibility could not be saved'), couldNotStart)
    ).toBe("The last look couldn't start.")
    expect(lookStartFailureWords('not an error', couldNotStart)).toBe(
      "The last look couldn't start."
    )
  })
})
