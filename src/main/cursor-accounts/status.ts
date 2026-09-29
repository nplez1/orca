import type { CursorAccountStatus } from '../../shared/rate-limit-types'
import { readCursorAuthSession } from '../rate-limits/cursor-auth'
import { isCursorSessionTokenExpired } from '../rate-limits/cursor-session-token'

function signedOut(error: string | null): CursorAccountStatus {
  return {
    signedIn: false,
    email: null,
    displayName: null,
    credentialSource: null,
    planType: null,
    tokenFresh: false,
    error
  }
}

/** Status reported without touching the Keychain when the user disabled Cursor. */
export function disabledCursorAccountStatus(): CursorAccountStatus {
  return signedOut(null)
}

export async function getCursorAccountStatus(): Promise<CursorAccountStatus> {
  const readResult = await readCursorAuthSession()
  if (readResult.status !== 'ok') {
    return signedOut(readResult.status === 'error' ? readResult.error : null)
  }
  const session = readResult.session
  return {
    signedIn: true,
    email: session.email,
    displayName: session.displayName,
    credentialSource: session.source,
    planType: session.membershipType,
    tokenFresh: !isCursorSessionTokenExpired(session.token),
    error: null
  }
}
