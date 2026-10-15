/**
 * Matching rule for a cmdk picker whose option order the caller has already decided.
 *
 * Why not cmdk's own scorer: it matches scattered letters ("oct" matches "Project
 * cleanup") and then re-sorts the matches by score, which throws the caller's order
 * away. Substring matching — one score for every match — keeps that order intact.
 *
 * `searchable` is whatever the caller wants matched; a cmdk `value` that is an opaque
 * id stays out of it unless the caller lists it.
 */
export function matchesCommandTerms(search: string, searchable: readonly string[]): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return true
  }
  const haystack = searchable.join(' ').toLowerCase()
  return terms.every((term) => haystack.includes(term))
}
