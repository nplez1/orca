import { isClipboardTextByteLengthOverLimit } from './clipboard-text'

/** Query admission limits for path search, shared by the host scan, the relay and the renderer. */

export const QUICK_OPEN_QUERY_MAX_BYTES = 2 * 1024
export const QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS = 256

export function isQuickOpenQueryTooLarge(
  query: string,
  maxBytes = QUICK_OPEN_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function isQuickOpenRemoteQueryTooLarge(query: string): boolean {
  return query.length > QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS || isQuickOpenQueryTooLarge(query)
}
