import { expect, it } from 'vitest'
import { aiVaultLocalScanKey } from './ai-vault-local-scan-key'

// Why: the key decides which cached listing a request is served from, so a scope it
// does not use would either split one answer in two or, worse, unite two answers.
it('keys an unbounded read without the scope it does not use', () => {
  const unbounded = { includeAntigravityIdeSessions: true, unlimited: true as const }

  expect(aiVaultLocalScanKey({ ...unbounded, scopePaths: ['/repo/app'] })).toBe(
    aiVaultLocalScanKey({ ...unbounded, scopePaths: ['/repo/other'] })
  )
})

it('keeps the scope in a bounded read, whose answer depends on it', () => {
  expect(aiVaultLocalScanKey({ scopePaths: ['/repo/app'], limit: 250 })).not.toBe(
    aiVaultLocalScanKey({ scopePaths: ['/repo/other'], limit: 250 })
  )
})
