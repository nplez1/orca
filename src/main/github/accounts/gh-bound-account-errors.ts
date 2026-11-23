// The two fail-closed answers a bound account can give. They live apart from the token module so the App
// path can raise them without importing it back.
import type { GhAccountBinding } from '../../../shared/github/accounts/account-binding'

export function createGhBoundAccountUnavailableError(
  binding: GhAccountBinding,
  /** What the caller should do about it; the default names the binding and nothing else. */
  reason?: string
): Error & { code: 'gh_bound_account_unavailable'; stderr: string } {
  const message =
    reason ?? `Bound GitHub account ${binding.user}@${binding.host} is unavailable on this runtime.`
  return Object.assign(new Error(message), {
    code: 'gh_bound_account_unavailable' as const,
    stderr: message
  })
}

export function createGhBoundAccountHostMismatchError(
  binding: GhAccountBinding,
  host: string | undefined
): Error & { code: 'gh_bound_account_host_mismatch'; stderr: string } {
  const message = host
    ? `Bound GitHub account host ${binding.host} does not match request host ${host}.`
    : `Bound GitHub account ${binding.user}@${binding.host} requires an explicit matching host.`
  return Object.assign(new Error(message), {
    code: 'gh_bound_account_host_mismatch' as const,
    stderr: message
  })
}
