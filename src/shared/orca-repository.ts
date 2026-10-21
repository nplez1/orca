import { MAIN_RELEASE_REPO } from './release-channel'

/**
 * The GitHub repository this build comes from — what a star request, a bug
 * report or a share link in the desktop app has to point at. (`mobile/` names
 * upstream on purpose: whether this fork ships its own mobile app is a separate
 * product decision, not a link that drifted.)
 *
 * Why derived and not spelled out: every one of those links used to carry a
 * repository slug as its own literal, so a build published from another
 * repository sent its users to the project it did not come from — a star that
 * credited upstream, a bug report filed upstream, a share card naming upstream.
 * The release feed's repo is the same identity and is the one a fork already
 * re-points, so deriving from it leaves no link behind. There is deliberately no
 * fallback: a build that re-points its feed re-points its links with it.
 */
export const ORCA_REPOSITORY = MAIN_RELEASE_REPO

/**
 * No trailing slash, so callers can append a path (`/issues`, `/tree/<sha>`).
 * Star links use the repository root, not `/stargazers`: GitHub 404s that page
 * for anyone without write access to the repo.
 */
export const ORCA_REPOSITORY_URL = `https://github.com/${ORCA_REPOSITORY}`

/** The same repository without a scheme — share text and image footers print this form. */
export const ORCA_REPOSITORY_DISPLAY_URL = `github.com/${ORCA_REPOSITORY}`
