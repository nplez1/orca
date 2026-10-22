/**
 * The comma-joined string a Jira control holds for a multi-value field — option ids,
 * accountIds, or plain strings. One place, so the edit form, the create dialog and the
 * payload builder cannot disagree about the separator or the trimming.
 */
export function splitJiraFieldDraft(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
}

export function joinJiraFieldDraft(tokens: readonly string[]): string {
  return tokens.join(', ')
}
