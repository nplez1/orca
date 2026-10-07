// Why its own file: vitest hoists `vi.mock` per test file, so proving the harness guard means
// importing the harness WITHOUT mocking any provider module. Every other suite in this
// directory mocks them, which is what the guard is there to require.
import { describe, expect, it } from 'vitest'
import { resetRateLimitProviderMocks } from './rate-limit-service-test-harness'

describe('resetRateLimitProviderMocks without provider mocks', () => {
  it('names the modules the suite must mock, instead of failing on a real fetcher', () => {
    expect(() => resetRateLimitProviderMocks()).toThrow(
      /rate-limit-service-test-harness: this suite must vi\.mock .*deepseek\/deepseek-fetcher/
    )
  })
})
