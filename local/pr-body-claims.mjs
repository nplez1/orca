// What a PR body has to claim before it may be opened: the review line gate 2 reads, and the waiver
// line a `--waive-gate` run used to leave only in a terminal. Kept apart from `open-pr.mjs` because
// that file is at its line budget and this is the part a test can drive without a git repository.

/**
 * Gate 2's reviewer — the ONE place a reviewer swap happens. Everything that has to agree with it is
 * derived from here: the claim regex below, `REVIEW_CLAIM_EXAMPLE`, the refusal message, and the tests
 * that pin accepted shapes. Why a constant rather than a settings file: `open-pr.mjs` refuses a body on
 * the regex built from it, so a value in a file nothing loads would be unenforced.
 *
 * Why the token check at all: without it the gate accepts a review by anyone, which is not the claim
 * the gate exists to verify.
 */
export const REVIEWER = {
  /** The `claude/*` Claude Code CLI backend; `alias` reaches the CLI as `--model <alias>`. */
  provider: 'claude',
  alias: 'fable',
  /** How the reviewer reads in a PR body. The version is dotted: `Fable 4` is not this reviewer. */
  name: 'Fable 5.2',
  /** pi thinking level, which the CLI receives as `--effort`. The claim line has to name it. */
  thinking: 'medium'
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The claim shape, built from `REVIEWER`: the backend spelling (`claude/fable`) or the body spelling
 * with a dotted version (`Fable 5.2`), followed by the reasoning level it ran at. Both spellings are
 * accepted because both are how the reviewer is invoked and how a body reports it.
 */
export const REVIEWER_CLAIM = new RegExp(
  `^(?:${REVIEWER.provider}[-/]${escapeRegExp(REVIEWER.alias)}|` +
    `${escapeRegExp(REVIEWER.name.split(/\s+/)[0])}\\s+\\d+\\.\\d+)\\b[\\s\\S]*\\b` +
    `${escapeRegExp(REVIEWER.thinking)}\\b`,
  'i'
)

/** The line a PR body is expected to carry, and the one `open-pr.mjs` prints when it refuses one. */
export const REVIEW_CLAIM_EXAMPLE = `Reviewed by ${REVIEWER.name}, ${REVIEWER.thinking}: R1 (2 blocking fixed), delta clean on R2`

/** Wording that names a finding without claiming it was closed. */
export const OPEN_VERDICT_WORDS =
  /\b(?:not\s+yet|not\s+(?:clean|fixed|addressed|resolved)|will\s+be|to\s+be\s+(?:fixed|addressed|resolved)|later|todo|tbd|unresolved|outstanding|pending|unfixed|still\s+open|open|deferred|won'?t\s+fix|skipped|follow-?up)\b/i

/** One `R<n>` (or `round <n>`) naming the round a verdict belongs to. */
const ROUND_REF = /\bR(\d+)\b|\bround\s*(\d+)\b/gi

/**
 * A closed verdict, in the two shapes AGENTS.md allows: the round came back clean, or a counted set
 * of blocking findings was fixed. Why the verb has to sit next to the count: "found 2 BLOCKERs" is a
 * finding, not a resolution, and `R1 (3 blocking: 1 fixed)` closes one of three — #210 G4 asks for an
 * *adjacent* `fixed`, which is also what refuses "2 blockers found and 1 fixed".
 */
const CLOSED_COUNT =
  /\b\d+\s+(?:blocking|blockers?)\s*(?:[,:-]\s*)?(?:all\s+)?(?:were\s+|are\s+)?(?:fixed|resolved|addressed)\b/gi
const CLOSED_VERDICT =
  /\bclean\b|\b\d+\s+(?:blocking|blockers?)\s*(?:[,:-]\s*)?(?:all\s+)?(?:were\s+|are\s+)?(?:fixed|resolved|addressed)\b|\bno\s+(?:blocking|blockers?)\b/gi

/** Every count of blocking findings, whether or not the same place closes it. */
const BLOCKER_COUNT = /\b\d+\s+(?:blocking|blockers?)\b/gi
/** Markdown emphasis, headings and bullets are noise around the claim, not a different claim. */
function normaliseBodyLine(line) {
  return String(line)
    .replace(/^[\s>*_#-]+/, '')
    .replace(/[*_]/g, '')
    .trim()
}

export function reviewClaim(body) {
  let fenced = false
  for (const raw of String(body ?? '').split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      continue
    }
    const line = normaliseBodyLine(raw)
    const match = /^reviewed by\s+(.+)$/i.exec(line)
    if (!match) {
      continue
    }
    const claim = match[1].trim()
    const colon = claim.indexOf(':')
    const reviewer = (colon === -1 ? claim : claim.slice(0, colon)).trim()
    const roundsText = colon === -1 ? '' : claim.slice(colon + 1).trim()
    // Why the reviewer first: a claim nobody AGENTS.md names is not a review, whatever verdicts it
    // lists, and checking this last let `Reviewed by nobody: R1 clean` through the whole gate.
    if (!REVIEWER_CLAIM.test(reviewer)) {
      return {
        ok: false,
        reason: `the review line names "${reviewer}" as the reviewer, and AGENTS.md § PR gate 2 requires ${REVIEWER.name} at ${REVIEWER.thinking} reasoning (\`${REVIEWER.name}, ${REVIEWER.thinking}\` or \`${REVIEWER.provider}/${REVIEWER.alias}, ${REVIEWER.thinking}\`)`
      }
    }
    // Why the whole claim: "not yet fixed" does not contain "not fixed", and that one gap accepted
    // `R1 (3 blocking, not yet fixed)`.
    if (OPEN_VERDICT_WORDS.test(roundsText)) {
      return {
        ok: false,
        reason: `the review line records an open finding: "${claim}"`
      }
    }
    const rounds = new Set([...roundsText.matchAll(ROUND_REF)].map((match) => match[1] ?? match[2]))
      .size
    if (rounds === 0) {
      return {
        ok: false,
        reason: `the review line names no review round (R1, round 1): "${claim}"`
      }
    }
    // Why every blocker count: a count of findings is a finding until the same clause says they were
    // fixed, and `clean` elsewhere in the line must not close them.
    const closedCounts = new Set([...roundsText.matchAll(CLOSED_COUNT)].map((match) => match.index))
    for (const count of roundsText.matchAll(BLOCKER_COUNT)) {
      if (!closedCounts.has(count.index)) {
        return {
          ok: false,
          reason: `the review line counts ${count[0].trim()} without the closing verb beside it: "${claim}"`
        }
      }
    }
    const closed = [...roundsText.matchAll(CLOSED_VERDICT)].length
    if (closed === 0) {
      return {
        ok: false,
        reason: `the review line states no closed verdict (R1 clean, or R1 N blocking fixed): "${claim}"`
      }
    }
    // Why a count per round rather than one verdict anywhere: `R1 found 2 BLOCKERs; nits fixed` has a
    // verdict word in it and closes nothing, and a round nobody reported on is not a reviewed round.
    if (closed < rounds) {
      return {
        ok: false,
        reason: `the review line names ${rounds} review round(s) but only ${closed} closed verdict(s); every round needs its own: "${claim}"`
      }
    }
    return { ok: true, line: `Reviewed by ${reviewer}: ${roundsText}` }
  }
  return { ok: false, reason: 'the body has no "Reviewed by" line' }
}

/**
 * The waiver, written into the body it belongs to: the script used to print it to a terminal nobody
 * reads later, so the one place a reader would look was the one place it was guaranteed absent.
 */
export function waiverDisclosure(body, waivers = new Map()) {
  const text = String(body ?? '')
  const present = new Set(text.split('\n').map((line) => line.trim()))
  const lines = []
  for (const [gate, reason] of waivers) {
    const line = `Gate ${gate} waived: ${reason}`
    if (!present.has(line)) {
      lines.push(line)
    }
  }
  if (lines.length === 0) {
    return { body: text, lines }
  }
  const trimmed = text.replace(/\s*$/, '')
  return { body: trimmed ? `${trimmed}\n\n${lines.join('\n')}\n` : `${lines.join('\n')}\n`, lines }
}
