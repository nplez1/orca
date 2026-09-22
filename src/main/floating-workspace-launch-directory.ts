import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * The Floating Workspace's own directory: where its terminals and agents start.
 *
 * It lives beside Orca's config (`.orca`) rather than in app data so it is easy to find and edit,
 * and outside every repository so instructions written there reach floating launches only.
 */
const FLOATING_WORKSPACE_DIRECTORY_NAME = 'floating-workspace'

const STARTER_AGENT_INSTRUCTIONS_FILE_NAME = 'AGENTS.md'
/** Any of these already carrying content means the user owns this folder's agent context. */
const EXISTING_AGENT_INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const

// Why: agent CLIs read this file as context, so the seeded copy must add nothing until the user
// writes their own rules — hence comment-only.
const STARTER_AGENT_INSTRUCTIONS = `<!--
Orca's Floating Workspace.

This is the directory floating terminals and agents start in. It is not a repository, so anything
written here is context for launches from the floating panel only — a good place for orchestration
conventions and cross-project setup steps.

Add your instructions outside this comment, then delete the comment.
-->
`

const seededDirectories = new Set<string>()

export function resolveFloatingWorkspaceLaunchDirectory(homeDir: string = homedir()): string {
  return path.join(homeDir, '.orca', FLOATING_WORKSPACE_DIRECTORY_NAME)
}

export function ensureFloatingWorkspaceLaunchDirectorySync(homeDir?: string): string {
  const directory = resolveFloatingWorkspaceLaunchDirectory(homeDir)
  mkdirSync(directory, { recursive: true })
  seedAgentInstructionsOnce(directory)
  return directory
}

export async function ensureFloatingWorkspaceLaunchDirectory(homeDir?: string): Promise<string> {
  const directory = resolveFloatingWorkspaceLaunchDirectory(homeDir)
  await mkdir(directory, { recursive: true })
  seedAgentInstructionsOnce(directory)
  return directory
}

// Why sync: callers include the synchronous PTY spawn-cwd resolver, and this is one small write per
// folder per process.
function seedAgentInstructionsOnce(directory: string): void {
  if (seededDirectories.has(directory)) {
    return
  }
  seededDirectories.add(directory)
  if (
    EXISTING_AGENT_INSTRUCTION_FILE_NAMES.some((fileName) =>
      existsSync(path.join(directory, fileName))
    )
  ) {
    return
  }
  try {
    // Why `wx`: two launches can seed at once, and the loser must not clobber a file the user wrote.
    writeFileSync(
      path.join(directory, STARTER_AGENT_INSTRUCTIONS_FILE_NAME),
      STARTER_AGENT_INSTRUCTIONS,
      {
        flag: 'wx'
      }
    )
  } catch {
    // An unwritable folder is not fatal for a terminal launch.
  }
}
