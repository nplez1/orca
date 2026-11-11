import { isUnresolvedSshHostAlias, normalizeForgeWebHost } from './git-remote-host-alias'

/** The two transports a remote URL can be written in and still name the same repository. */
export type GitRemoteTransport = 'ssh' | 'https'

type ParsedRemote = {
  transport: GitRemoteTransport
  host: string
  path: string
}

const SCP_FORM = /^(?:([^@/\\:]+)@)?([^@/\\:]+):(?!\/\/)(.+)$/
const SSH_URL = /^ssh:\/\/(?:([^@/]+)@)?([^/]+)\/(.+)$/
const HTTPS_URL = /^https?:\/\/(?:([^@/]+)@)?([^/]+)\/(.+)$/
/** Remotes whose path is not the same string on both transports, or that no transport switch helps. */
const UNSUPPORTED_HOST = /(^|\.)(?:visualstudio|azure)\.com$/i
/** Bitbucket Server and friends serve `https://host/scm/<project>/<repo>` against `ssh://host:7999/<project>/<repo>`. */
const PATH_DIFFERS_PER_TRANSPORT = /(^|[:/])scm\//i
const UNSUPPORTED_PREFIX = /^(?:git|file|ext|ftp|ftps|rsync|svn):/i

/** A query or fragment means this is a browsable link, not the remote's own path. */
function cleanPath(path: string): string | null {
  if (/[?#]/.test(path)) {
    return null
  }
  const cut = path.replace(/\/+$/, '')
  if (!cut || cut.startsWith('~') || cut.startsWith('/')) {
    return null
  }
  return cut
}

function parseRemote(url: string): ParsedRemote | null {
  const trimmed = url.trim()
  if (!trimmed || UNSUPPORTED_PREFIX.test(trimmed)) {
    return null
  }
  if (PATH_DIFFERS_PER_TRANSPORT.test(trimmed)) {
    return null
  }
  // A local checkout path is not a remote, whatever it looks like on either platform.
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('.') || trimmed.startsWith('/')) {
    return null
  }
  const scp = SCP_FORM.exec(trimmed)
  if (scp) {
    const path = cleanPath(scp[3])
    return path ? { transport: 'ssh', host: scp[2], path } : null
  }
  const sshUrl = SSH_URL.exec(trimmed)
  if (sshUrl) {
    const path = cleanPath(sshUrl[3])
    return path ? { transport: 'ssh', host: sshUrl[2], path } : null
  }
  const httpsUrl = HTTPS_URL.exec(trimmed)
  if (httpsUrl) {
    const path = cleanPath(httpsUrl[3])
    return path ? { transport: 'https', host: httpsUrl[2], path } : null
  }
  return null
}

/** A host we can rewrite for: a dotless name is an unresolved `~/.ssh/config` alias, not a forge. */
function rewritableHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, '')
  return (
    hostname.includes('.') &&
    !isUnresolvedSshHostAlias(hostname) &&
    !UNSUPPORTED_HOST.test(hostname)
  )
}

/**
 * Which transport a remote URL is written in, or null when it has no counterpart.
 *
 * Only a forge-shaped remote has one: a local path, a `git://` remote and an SSH host alias that
 * resolves nowhere we can name are all left alone, because rewriting them would invent a host.
 */
export function detectGitRemoteTransport(url: string): GitRemoteTransport | null {
  const parsed = parseRemote(url)
  return parsed && rewritableHost(parsed.host) ? parsed.transport : null
}

/**
 * The same repository in the other transport's spelling, or null when it has no counterpart.
 *
 * Credentials and ports are dropped in both directions: the ssh form is scp-shaped (which cannot
 * carry a port), and a persisted clone URL must never hold a token the user did not type here.
 */
export function rewriteGitRemoteTransport(url: string, to: GitRemoteTransport): string | null {
  const parsed = parseRemote(url)
  if (!parsed || !rewritableHost(parsed.host)) {
    return null
  }
  // Why unchanged: a rewrite through the scp form would drop a port the user picked on purpose
  // (ssh-over-443, a self-hosted server on 2222), so asking for the transport already in use is a no-op.
  if (parsed.transport === to) {
    return url.trim()
  }
  // Why folded both ways: GitHub serves SSH-over-443 from ssh.github.com and GitLab from
  // altssh.gitlab.com, so the alias names the same forge under either transport.
  const host = normalizeForgeWebHost(parsed.host.replace(/:\d+$/, ''))
  return to === 'https' ? `https://${host}/${parsed.path}` : `git@${host}:${parsed.path}`
}
