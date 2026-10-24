/**
 * Pull the first JSON object out of a model reply (tolerates code fences and prose).
 *
 * Shared by both phases of the fold — the chunk extract and the report rewrite — so it lives
 * apart from either rather than being imported across them.
 */
export function extractSessionSummaryJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  if (start === -1) {
    return null
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
