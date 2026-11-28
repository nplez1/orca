// Where the channel's files live, and the one rule about them that matters: every provider id becomes a
// path segment, so an id that could escape its directory is refused rather than joined.
import { join } from 'node:path'
import { PHOTON_CONSUMER_PURPOSE } from './photon-contract'

export const PHOTON_DIR = 'local-photon'
export const RECORD_FILE = 'photon.json'
export const SECRET_FILE = 'photon-secrets.json'

/** An existing Spectrum project's secret, per bot: its own file, because it is neither the account key nor
 *  a project key Orca minted. */
export const SPECTRUM_SECRET_FILE = 'photon-spectrum-secrets.json'

/**
 * One path segment built from a provider id.
 *
 * A `:` is **encoded**, not refused: on NTFS `a:b.json` opens an alternate data stream that `readdir`
 * never lists, so the file would be written somewhere the store cannot find again and the cursor would
 * stop at `not-in-inbox`. Photon's id alphabet is unpublished, so this encodes the one character that is
 * unsafe on a supported filesystem rather than assuming it never appears. Percent-encoding is reversible
 * and `%` is encoded first, so two ids can never collide on one name.
 */
export function photonPathSegment(id: string): string {
  if (!/^[A-Za-z0-9._:%-]{1,400}$/.test(id) || id === '.' || id === '..') {
    throw new Error(`Photon id is not usable as a path segment: ${id.slice(0, 80)}`)
  }
  return id.replaceAll('%', '%25').replaceAll(':', '%3A')
}

/** A file name back to the id it was made from: the other half of `photonPathSegment`, decoded in the
 *  opposite order, so a literal `%` written as `%25` survives the round trip. */
export function photonPathSegmentId(segment: string): string {
  return segment.replaceAll('%3A', ':').replaceAll('%25', '%')
}

const inDir = (userDataPath: string, ...parts: string[]): string =>
  join(userDataPath, PHOTON_DIR, ...parts)

export const photonRecordPath = (userDataPath: string): string => inDir(userDataPath, RECORD_FILE)

export const photonSecretsPath = (userDataPath: string): string => inDir(userDataPath, SECRET_FILE)

export const photonSpectrumSecretsPath = (userDataPath: string): string =>
  inDir(userDataPath, SPECTRUM_SECRET_FILE)

/** Per project, and per consumer purpose, so an independent integration cannot overwrite this one. */
export const photonCursorPath = (
  userDataPath: string,
  projectId: string,
  purpose: string = PHOTON_CONSUMER_PURPOSE
): string => inDir(userDataPath, 'cursors', photonPathSegment(projectId), `${purpose}.json`)

export const photonInboxDir = (userDataPath: string, projectId: string): string =>
  inDir(userDataPath, 'inbox', photonPathSegment(projectId))

export const photonInboxPath = (
  userDataPath: string,
  projectId: string,
  messageId: string
): string => join(photonInboxDir(userDataPath, projectId), `${photonPathSegment(messageId)}.json`)

export const photonThreadPath = (userDataPath: string, botId: string): string =>
  inDir(userDataPath, 'threads', `${photonPathSegment(botId)}.json`)

export const photonOutboxPath = (userDataPath: string): string =>
  inDir(userDataPath, 'photon-outbox.json')
