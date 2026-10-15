/** Jira's own reason for a refused board action, or the board's own wording when the
 *  failure carries none. Shared by the board and the two hooks that move issues on it,
 *  so the three report the same thing. */
export function jiraBoardErrorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Jira board update failed.'
}
