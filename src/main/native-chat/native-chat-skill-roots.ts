// The skill folders a chat loads beside the agent's own: Orca's visuals skill, then each linked project's.

/** One skills folder, in the shapes the agents take it. */
export type NativeChatSkillRoot = {
  /** Holds <skill>/SKILL.md; Codex and OpenCode take this. */
  skillsRoot: string
  /** A folder whose skills/ is skillsRoot; Grok and OMP plugin folders take this. */
  pluginDir: string
  /** Its skills are links, which Grok plugin folders skip. */
  linksOut?: true
}

export type LinkedProjectSkill = {
  name: string
  description: string
  /** The SKILL.md with links resolved, so an agent that reads it from the index finds it. */
  skillFile: string
}

export type LinkedSkillProject = {
  name: string
  kind?: 'project' | 'folder' | 'own'
  repoPath: string
  skills: readonly LinkedProjectSkill[]
}

/** A bot chat's linked skills: the bot's one folder of links to every linked project's admitted
 *  skills (skills/ for plugin-folder agents and Codex, .claude/skills for Claude as an added
 *  directory), which Orca keeps current so a running Claude or Codex picks changes up; null for a
 *  chat that isn't a bot's. */
export type LinkedSkills = {
  root: (NativeChatSkillRoot & { linksOut: true }) | null
  projects: readonly LinkedSkillProject[]
}

export const NO_LINKED_SKILLS: LinkedSkills = { root: null, projects: [] }

/** A linked project's skills as a list names them. */
export type LinkedSkillListing = Pick<LinkedSkillProject, 'name' | 'skills' | 'kind'>

// Codex budgets its skill list at 2% of context; the whole index stays well under that.
const INDEX_MAX_CHARS = 12_000

function skillIndex(projects: readonly LinkedSkillListing[]): string[] {
  const lines = ['These are not loaded as your skills. When one fits, read its SKILL.md first:']
  let size = lines[0]!.length
  const fits = (line: string): boolean => size + line.length + 1 <= INDEX_MAX_CHARS
  for (const [projectIndex, project] of projects.entries()) {
    const header = `- ${project.name}:`
    if (!fits(header)) {
      lines.push(`- ${projects.length - projectIndex} more projects not listed`)
      break
    }
    lines.push(header)
    size += header.length + 1
    for (const [index, skill] of project.skills.entries()) {
      const line = `  - ${skill.name}: ${skill.description} → ${skill.skillFile}`
      if (!fits(line)) {
        lines.push(`  - ${project.skills.length - index} more not listed`)
        size += 30
        break
      }
      lines.push(line)
      size += line.length + 1
    }
  }
  return lines
}

/** How the bot uses linked skills, with an index of those its agent didn't load (or, `named`, the
 *  names of those it did, which a running agent's own list may not show yet); null without any. */
export function linkedSkillsSection(
  projects: readonly LinkedSkillListing[],
  unloaded: readonly LinkedSkillListing[],
  named = false
): string | null {
  if (projects.length === 0) {
    return null
  }
  const own = projects.filter((project) => project.kind === 'own')
  const linked = projects.filter((project) => project.kind !== 'folder' && project.kind !== 'own')
  const folders = projects.filter((project) => project.kind === 'folder')
  const names = linked.map((project) => project.name).join(', ')
  return [
    folders.length > 0 || own.length > 0 ? '## Skills' : '## Skills from linked projects',
    '',
    ...(own.length > 0
      ? [
          `Your own skills (${own.map((project) => project.name).join(', ')}): read these first; they are yours to change, and a new one in your own skills folder is known from your next turn.`
        ]
      : []),
    ...(linked.length > 0
      ? [
          `Skills from ${names}: use them to plan and drive that project's work; code work still goes to a worker in that project, which has them too; name the skill in the spec.`
        ]
      : []),
    ...(folders.length > 0
      ? [
          `Skills from this computer's own folders (${folders.map((folder) => folder.name).join(', ')}): they document tools installed here, not a project. No worker has them, so run their commands yourself.`
        ]
      : []),
    ...(named
      ? [
          '',
          ...projects
            .filter((project) => !unloaded.includes(project))
            .map(
              (project) =>
                `- ${project.name}: ${project.skills.map((skill) => skill.name).join(', ')}`
            )
        ]
      : []),
    ...(unloaded.length > 0 ? ['', ...skillIndex(unloaded)] : [])
  ].join('\n')
}
