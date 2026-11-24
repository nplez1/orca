// The projects a bot links for skills: which skills each has, read on this host, and the bot's one
// skill-only folder its chats load them from.
import { mkdir, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import type { BotSkillProjectView } from '../../shared/bots/bot-skill-projects'
import type { Repo } from '../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import {
  SKILL_FOLDERS,
  scanSkillsFolder,
  type ScannedProject,
  type ScannedSkill
} from './bot-skill-folder-scan'
import { scanOwnSkills, scanSkillRoots } from './bot-skill-roots'
import type { LinkedSkillListing, LinkedSkills } from '../native-chat/native-chat-skill-roots'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { retireAtRestCommandContext } from '../native-chat/agent-session-wire/options/at-rest-command-context'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

export { linkedSkillKeys, resolveSkillRoot } from './bot-skill-roots'

/** The project's skills from .agents/skills, else .claude/skills; null when it has none. */
export async function scanSkillProject(repoPath: string): Promise<ScannedProject | null> {
  for (const folder of SKILL_FOLDERS) {
    const skillsDir = join(repoPath, folder, 'skills')
    const skills = await scanSkillsFolder(skillsDir)
    if (skills.length > 0) {
      return { skillsDir, skills }
    }
  }
  return null
}

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'project'

/** A bot's one linked-skills folder, outside its home: every chat of the bot loads it at launch. */
export function botLinkedSkillsFolder(botId: string): string {
  return join(getProfileUserDataPath(), 'bot-linked-skills', safeName(botId))
}

/** Each skills folder's link name for every skill, unique across the bot's projects even where
 *  the filesystem ignores case (macOS, Windows), so `deploy` and `Deploy` both get a link. */
function skillLinks(skills: readonly ScannedSkill[]): Map<string, string> {
  const links = new Map<string, string>()
  const taken = new Set<string>()
  const linked = new Set<string>()
  for (const skill of skills) {
    if (linked.has(skill.folder)) {
      continue
    }
    linked.add(skill.folder)
    const base = safeName(basename(skill.folder))
    let link = base
    for (let n = 2; taken.has(link.toLowerCase()); n += 1) {
      link = `${base}-${n}`
    }
    taken.add(link.toLowerCase())
    links.set(link, skill.folder)
  }
  return links
}

/** Makes one skills folder hold exactly these links, in place, so an agent watching it sees the
 *  change; anything there that isn't a link is left alone. */
async function syncLinks(skillsDir: string, links: ReadonlyMap<string, string>): Promise<void> {
  await mkdir(skillsDir, { recursive: true })
  const present = new Set<string>()
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) {
      continue
    }
    const path = join(skillsDir, entry.name)
    const target = links.get(entry.name)
    if (target !== undefined && (await realpath(path).catch(() => null)) === target) {
      present.add(entry.name)
    } else {
      await rm(path, { force: true })
    }
  }
  for (const [link, target] of links) {
    if (present.has(link)) {
      continue
    }
    const path = join(skillsDir, link)
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir').catch(
      async (error: NodeJS.ErrnoException) => {
        // Taken counts only when it is this link (another Orca process made it); anything else
        // there is left alone, and the sync fails so the chat gets the list instead.
        if (error.code !== 'EEXIST' || (await realpath(path).catch(() => null)) !== target) {
          throw error
        }
      }
    )
  }
}

const syncing = new Map<string, Promise<unknown>>()

/** One scan-and-sync per folder at a time, in call order, so an older scan never lands over a
 *  newer one's links. */
function serialized<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const next = (syncing.get(folder) ?? Promise.resolve()).catch(() => {}).then(run)
  syncing.set(folder, next)
  return next.finally(() => {
    if (syncing.get(folder) === next) {
      syncing.delete(folder)
    }
  })
}

function withoutRepeatedSkills<
  T extends { name: string; skills: readonly ScannedSkill[]; kind?: 'project' | 'folder' | 'own' }
>(entries: readonly T[]): T[] {
  // One link per skill and one entry per declared name: a second skill calling itself `pdf` would be
  // two folders the agent cannot tell apart, so the first source wins (own, then projects, then folders).
  const seen = new Set<string>()
  const named = new Set<string>()
  return entries.map((entry) => {
    const skills = entry.skills.filter((skill) => {
      const fresh = !seen.has(skill.folder) && !named.has(skill.name)
      seen.add(skill.folder)
      named.add(skill.name)
      return fresh
    })
    return { ...entry, skills }
  })
}

function isLocalRepo(repo: Repo): boolean {
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

/** These linked projects on this host that have skills, scanned in place. */
async function scanLinkedProjects(
  ids: readonly string[],
  repos: readonly Repo[]
): Promise<{ repo: Repo; skills: ScannedSkill[] }[]> {
  const linked = ids.flatMap((id) => {
    const repo = repos.find((entry) => entry.id === id)
    return repo && isLocalRepo(repo) ? [repo] : []
  })
  const scanned = await Promise.all(
    linked.map(async (repo) => {
      const project = await scanSkillProject(repo.path)
      return project ? [{ repo, skills: project.skills }] : []
    })
  )
  return scanned.flat()
}

/** These linked projects' skills, read in place for a running chat's list; no folder is touched. */
export async function linkedSkillListing(
  ids: readonly string[],
  repos: readonly Repo[],
  roots: readonly string[] = [],
  bot?: Pick<Bot, 'folder'>,
  botsRoot?: string
): Promise<LinkedSkillListing[]> {
  const scanned = [
    ...(bot ? await scanOwnSkills(bot, botsRoot) : []),
    ...(await scanLinkedProjects(ids, repos)).map(({ repo, skills }) => ({
      name: repo.displayName,
      skills,
      kind: 'project' as const
    })),
    ...(await scanSkillRoots(roots))
  ]
  return withoutRepeatedSkills(scanned).map(({ name, skills, kind }) => ({
    name,
    kind,
    skills: skills.map(({ folder: _folder, ...skill }) => skill)
  }))
}

/**
 * The bot's linked projects on this host that have skills, with its folder brought up to date: a
 * link per admitted skill under skills/ (plugin-folder agents, Codex, OpenCode) and .claude/skills/
 * (Claude, as an added directory), and none of the projects' settings, plugins, commands or
 * instructions. Kept in place, so a running Claude or Codex loads a linked project's skills, and
 * drops an unlinked one's, without a restart.
 */
export async function linkedSkillProjects(
  bot: Pick<Bot, 'folder' | 'skillProjects'>,
  repos: readonly Repo[],
  folder: string,
  roots: readonly string[] = [],
  botsRoot?: string
): Promise<LinkedSkills> {
  // Rejects when the folder can't be brought up to date, so no caller takes a partial list.
  const scanned = await serialized(folder, async () => {
    const scanned = [
      ...(await scanOwnSkills(bot, botsRoot)),
      ...(await scanLinkedProjects(bot.skillProjects ?? [], repos)).map(({ repo, skills }) => ({
        name: repo.displayName,
        path: repo.path,
        skills,
        kind: 'project' as const
      })),
      ...(await scanSkillRoots(roots))
    ]
    const unique = withoutRepeatedSkills(scanned)
    const links = skillLinks(unique.flatMap((project) => project.skills))
    await syncLinks(join(folder, 'skills'), links)
    await syncLinks(join(folder, '.claude', 'skills'), links)
    return unique
  })
  return {
    root: { skillsRoot: join(folder, 'skills'), pluginDir: folder, linksOut: true },
    projects: scanned.map(({ name, path, skills, kind }) => ({
      name,
      kind,
      repoPath: path,
      skills: skills.map(({ folder: _folder, ...skill }) => skill)
    }))
  }
}

/** The bot's links changed: its open chats load the skills before their next turn, and its resting
 *  chats' `/` menus reread them. */
export function relinkBotSkills(
  bot: Pick<Bot, 'id' | 'folder' | 'skillProjects' | 'folderWorkspaceId'>,
  repos: readonly Repo[],
  roots: readonly string[] = []
): void {
  void linkedSkillProjects(bot, repos, botLinkedSkillsFolder(bot.id), roots)
    .catch(() => {})
    .finally(() => retireAtRestCommandContext(folderWorkspaceKey(bot.folderWorkspaceId)))
}

/** Projects as Settings shows them, from the same scan a chat's launch uses. */
export async function botSkillProjectViews(
  repoIds: readonly string[],
  repos: readonly Repo[]
): Promise<BotSkillProjectView[]> {
  return Promise.all(
    repoIds.map(async (repoId): Promise<BotSkillProjectView> => {
      const repo = repos.find((entry) => entry.id === repoId)
      if (!repo) {
        return { repoId, name: repoId, status: 'missing', skillsDir: null, skills: [] }
      }
      if (!isLocalRepo(repo)) {
        return { repoId, name: repo.displayName, status: 'remote', skillsDir: null, skills: [] }
      }
      const scanned = await scanSkillProject(repo.path)
      return {
        repoId,
        name: repo.displayName,
        status: 'local',
        skillsDir: scanned?.skillsDir ?? null,
        skills: (scanned?.skills ?? []).map(({ name, description }) => ({ name, description }))
      }
    })
  )
}
