// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
// Why this fork's repository: the pin below names the running build's own commit, which only exists
// here, and this fork is the only place its own skill content (NP CLI names) is published from.
// Pointed at upstream the pair is incoherent — a nplez1/orca commit that stablyai/orca never had.
export const ORCA_SKILLS_REPOSITORY_URL = 'https://github.com/nplez1/orca'

// Why: one skills CLI for every install rail. 1.5.x cannot fetch a commit, and a bare
// `npx skills` can reuse a stale cached copy or another binary (#18687).
export const SKILLS_CLI_VERSION = '1.7.2'

export type AgentFeatureSkillCommandOptions = {
  /** Full commit the running build was made from. */
  sourceCommit: string
  global?: boolean
}

export function buildAgentFeatureSkillInstallArgs(
  skillNames: readonly string[],
  options: AgentFeatureSkillCommandOptions
): string[] {
  if (skillNames.length === 0) {
    throw new Error('At least one skill name is required.')
  }
  const global = options.global ?? true
  // Why: one flag per name remains compatible with both single-value and variadic parsers.
  const skillArgs = skillNames.flatMap((name) => ['--skill', name])
  return [
    `skills@${SKILLS_CLI_VERSION}`,
    'add',
    // Why: pinned to the build's own commit so the installed bytes are the ones its bundled
    // manifest judges freshness against, on every channel (hourly builds have no tag in
    // this repo). `add` always re-copies, so the same command is install and update.
    `${ORCA_SKILLS_REPOSITORY_URL}/tree/${options.sourceCommit}`,
    ...skillArgs,
    ...(global ? ['--global'] : [])
  ]
}

export function buildAgentFeatureSkillInstallCommand(
  skillNames: readonly string[],
  options: AgentFeatureSkillCommandOptions
): string {
  return `npx ${buildAgentFeatureSkillInstallArgs(skillNames, options).join(' ')}`
}
