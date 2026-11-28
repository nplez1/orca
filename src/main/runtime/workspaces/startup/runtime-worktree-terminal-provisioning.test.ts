import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSequencedSetupAgentCommands } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { createSetupCompletionScanner } from '../../orchestration/workers/launch/setup-completion-signal'
import {
  provisionWorktreeTerminals,
  type WorktreeProvisionTerminalOptions,
  type WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'

type RecordedSetupHost = {
  created: WorktreeProvisionTerminalOptions[]
  recorded: Map<string, string>
  armed: string[]
}

function recordingHost(host: RecordedSetupHost): WorktreeTerminalProvisioningHost {
  return {
    canSpawn: () => true,
    createTerminal: async (_selector, options) => {
      host.created.push(options)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provisioning reads only the handle.
      return { handle: 'term_setup' } as never
    },
    setTabTitle: async () => {},
    setTabColor: async () => {},
    getPtyId: (handle) => `pty_${handle}`,
    recordSetupCompletionToken: (ptyId, token) => host.recorded.set(ptyId, token),
    armWorktreeSetupRunner: (_handle, _worktreeId, token) => host.armed.push(token)
  }
}

function printedSetupStatus(
  command: string,
  env: Record<string, string> | undefined,
  token: string
) {
  const output = execFileSync('bash', ['-c', `${command} || true`], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
  let exitCode: number | null = null
  createSetupCompletionScanner(token, (code) => {
    exitCode = code
  }).scan(output)
  return exitCode
}

// A terminal worker on a wait-for-setup repo runs setup through the sequenced wrapper; the runtime
// must still see that setup end, or stopping the worker reads it as finished and closes it mid-run.
it.skipIf(process.platform === 'win32')(
  'a wait-for-setup wrapped setup records its completion token and prints it when it ends',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-wrapped-setup-'))
    try {
      const runnerScriptPath = join(directory, 'setup.sh')
      writeFileSync(runnerScriptPath, 'echo installing\nexit 3\n')
      const sequenced = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: 'claude',
        platform: 'posix',
        completionToken: 'token-wrapped'
      })
      const host: RecordedSetupHost = {
        created: [],
        recorded: new Map<string, string>(),
        armed: []
      }
      await provisionWorktreeTerminals(recordingHost(host), {
        worktreeSelector: 'id:wt',
        worktreeId: 'wt',
        worktreePath: directory,
        setup: { runnerScriptPath, envVars: sequenced.setupEnv ?? {}, waitForAgentStartup: true },
        hasStartupTerminal: true,
        primaryTerminalHandle: 'term_agent',
        setupCommandPlatform: 'posix',
        wrappedSetup: { command: sequenced.setupCommand, completionToken: 'token-wrapped' }
      })
      expect(host.recorded.get('pty_term_setup')).toBe('token-wrapped')
      expect(host.armed).toEqual(['token-wrapped'])
      const setup = host.created.find((options) => options.command === sequenced.setupCommand)!
      expect(printedSetupStatus(setup.command!, setup.env, 'token-wrapped')).toBe(3)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'an unwrapped setup is observed and announced, and the token it was armed with is the one it prints',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-observed-setup-'))
    try {
      const runnerScriptPath = join(directory, 'setup.sh')
      writeFileSync(runnerScriptPath, 'echo installing\nexit 0\n')
      const host: RecordedSetupHost = {
        created: [],
        recorded: new Map<string, string>(),
        armed: []
      }
      await provisionWorktreeTerminals(recordingHost(host), {
        worktreeSelector: 'id:wt',
        worktreeId: 'wt',
        worktreePath: directory,
        setup: { runnerScriptPath, envVars: {} },
        hasStartupTerminal: false,
        setupCommandPlatform: 'posix'
      })
      expect(host.armed).toHaveLength(1)
      const [token] = host.armed
      expect(host.recorded.get('pty_term_setup')).toBe(token)
      const setup = host.created.find((options) => options.command)!
      expect(printedSetupStatus(setup.command!, setup.env, token!)).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
