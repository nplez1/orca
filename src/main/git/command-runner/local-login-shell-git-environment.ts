import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { isShellStartupEnvProbeSupported } from '../../pty/shell-startup-env'
import { resolveLoginShellEnvironment } from '../../startup/login-shell-environment'
import type { ResolvedCommand } from './wsl-command-resolution'

/**
 * Environment for git children on the local host.
 *
 * Why: a GUI-launched Orca (macOS Dock, Linux desktop entry) inherits launchd's
 * minimal environment, so anything exported from ~/.zprofile, ~/.zshenv or
 * ~/.profile is absent from `process.env`. Only PATH is hydrated elsewhere
 * (startup/hydrate-shell-path.ts); every other export never reached a git
 * child, which is what a commit or push hook notices first: `pre-commit` and
 * `pre-push` run with git's environment, and so does the ssh-agent lookup
 * (`SSH_AUTH_SOCK`) that a push needs.
 *
 * Why the profile-loading shell resolver and not a second probe: it is the same
 * environment PTY panes and structured agent sessions start from, so a git hook
 * now sees what the user's terminal sees.
 *
 * Why POSIX only: native Windows git already inherits the user's registry
 * environment, and WSL git runs inside the distro's own login shell, so on
 * neither host is a Windows-side profile export the environment that command
 * would get.
 *
 * Why opt-in rather than always on: the probe spawns an interactive login
 * shell. A process that never enables it — unit tests, the relay, a Windows
 * host — pays nothing. Startup enables it on a packaged build, the launch shape
 * that actually loses the shell's exports.
 */
type LoginShellEnvironmentResolver = () => Promise<NodeJS.ProcessEnv>

let resolveShellEnvironment: LoginShellEnvironmentResolver | null = null
let shellEnvironmentProbe: Promise<NodeJS.ProcessEnv> | null = null
/** Settled probe result, so the sync spawn paths can read it without awaiting. */
let settledShellEnvironment: NodeJS.ProcessEnv | null = null

function probeShellEnvironment(
  resolver: LoginShellEnvironmentResolver
): Promise<NodeJS.ProcessEnv> {
  // Why memoized here as well as inside the resolver: this promise is what lets
  // the sync callers read a settled result, and one process shares one shell.
  // Why deferred through a microtask: a resolver that throws synchronously must
  // reach the failure path below rather than failing app startup.
  shellEnvironmentProbe ??= Promise.resolve()
    .then(() => resolver())
    .then(
      (environment) => {
        settledShellEnvironment = environment
        return environment
      },
      (error: unknown) => {
        // Why degrade instead of reject: every later git child shares this promise,
        // so one failed probe must not fail them all for the rest of the session.
        console.warn(
          `[shell-env] login-shell probe failed (${String(error)}); git keeps the launch environment`
        )
        settledShellEnvironment = process.env
        return process.env
      }
    )
  return shellEnvironmentProbe
}

/**
 * Enable the probe for this process and start it.
 *
 * Why both at once: enabling without warming makes the first commit pay for an
 * interactive shell spawn, and warming without enabling would waste one. The
 * probe runs while the first window opens, so the first Source Control read
 * does not wait on it.
 */
export function configureLocalLoginShellGitEnvironment(): void {
  if (!isShellStartupEnvProbeSupported()) {
    return
  }
  resolveShellEnvironment = resolveLoginShellEnvironment
  shellEnvironmentProbe = null
  settledShellEnvironment = null
  void probeShellEnvironment(resolveLoginShellEnvironment)
}

/**
 * The environment a local git child must spawn with, or `null` when this host
 * routes its git somewhere the host shell environment does not apply — WSL, or
 * a process that never enabled the probe.
 */
export function prepareLocalLoginShellGitEnvironment(
  resolved: ResolvedCommand,
  env: NodeJS.ProcessEnv | undefined,
  signal?: AbortSignal
): Promise<NodeJS.ProcessEnv> | null {
  const resolver = resolveShellEnvironment
  if (resolver === null || !isShellStartupEnvProbeSupported() || resolved.wsl !== null) {
    return null
  }
  return waitForPromiseWithSignal(probeShellEnvironment(resolver), signal).then(
    (shellEnvironment) => mergeShellEnvironment(shellEnvironment, env)
  )
}

/**
 * Sync counterpart for spawn paths that cannot await: the merged environment
 * once the probe has settled, otherwise `env` unchanged. A git status read that
 * races app startup therefore gets today's environment rather than a stall.
 */
export function localLoginShellGitEnvironmentSnapshot(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return settledShellEnvironment === null
    ? env
    : mergeShellEnvironment(settledShellEnvironment, env)
}

function mergeShellEnvironment(
  shellEnvironment: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv {
  // Why the caller's env last: the shell environment only fills in what a GUI
  // launch dropped. It must not outrank what Orca set deliberately — the
  // hydrated PATH, the untranslated-output locale, the credential guards — all
  // of which are layered on top of this by git-process-env.ts.
  return { ...shellEnvironment, ...(env ?? process.env) }
}

/** @internal - tests substitute the probe; `null` returns the module to inert. */
export function _configureLocalLoginShellGitEnvironmentForTests(
  resolver: LoginShellEnvironmentResolver | null
): void {
  resolveShellEnvironment = resolver
  shellEnvironmentProbe = null
  settledShellEnvironment = null
}
