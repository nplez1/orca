// Refuse a release body with no change summary, in the two places that decide whether one is ever
// published: the notes the macos job writes into the draft, and the body of the release the linux job
// is about to undraft.
//
// Why a guard and not the shell test it replaces: the runbook promises no release goes public without
// `## What changed` for the range, and the workflow published a minimal `Built from <sha>` body
// instead whenever the generator could not produce one — so the promise was kept by whoever
// remembered to read the draft. A stub is a silent install-instructions-only release, which is the
// exact failure the generator was introduced to remove.
//
// usage: fork-release-notes-guard.mjs <path|-> [--label <what>]
// exit: 0 the body carries a change summary, 1 refuse, 2 usage
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// The generator emits `## What changed` for a first release and `## What changed since <tag>` otherwise.
const SUMMARY_HEADING = /^## What changed/m
// Its own last-resort body when history is unusable. It carries the heading, so only its text says so.
const FALLBACK_MARKER = /A change summary could not be generated/
export const MIN_SUMMARY_BYTES = 400

/** `ok` with the reason, so the caller only has to decide how to fail. */
export function checkReleaseNotesBody(body) {
  const text = typeof body === 'string' ? body : ''
  if (!SUMMARY_HEADING.test(text)) {
    return {
      ok: false,
      reason: 'it has no "## What changed" section, so it says nothing about what changed'
    }
  }
  if (FALLBACK_MARKER.test(text)) {
    return {
      ok: false,
      reason:
        'it is the generator\'s fallback ("A change summary could not be generated"), which means git history for the range was unusable'
    }
  }
  const bytes = Buffer.byteLength(text)
  if (bytes < MIN_SUMMARY_BYTES) {
    return {
      ok: false,
      reason: `it is ${bytes} bytes, under the ${MIN_SUMMARY_BYTES} a real summary needs, so it is a fragment rather than the whole body`
    }
  }
  return { ok: true, reason: `${bytes} bytes with a change summary` }
}

function main(argv) {
  const args = [...argv]
  let label = 'the release body'
  const labelIndex = args.indexOf('--label')
  if (labelIndex !== -1) {
    label = args.splice(labelIndex, 2)[1] ?? label
  }
  const [path, ...rest] = args
  if (!path || rest.length > 0) {
    process.stderr.write('usage: fork-release-notes-guard.mjs <path|-> [--label <what>]\n')
    return 2
  }
  let body
  try {
    body = readFileSync(path === '-' ? 0 : path, 'utf8')
  } catch (error) {
    process.stderr.write(`::error::cannot read ${label} (${path}): ${error.message}\n`)
    return 1
  }
  const result = checkReleaseNotesBody(body)
  if (!result.ok) {
    process.stderr.write(
      `::error::refusing to publish: ${label} has no usable change summary — ${result.reason}. ` +
        "Nothing has gone public. Read the step's warning or the generator's output, fix the cause and " +
        're-run, or write the notes by hand with `gh release edit <tag> --notes-file notes.md`.\n'
    )
    return 1
  }
  process.stdout.write(`${label}: ${result.reason}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
