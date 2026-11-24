// Skills from places that are not a linked project: the bot's own home folder, which it can write to,
// and the folders of skills this computer shares with every bot.
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import { botsRootFolder } from './bot-home'
import { SKILL_FOLDERS, scanSkillsFolder, type ScannedSkill } from './bot-skill-folder-scan'

/** A bot's linked-skill keys: its projects and this computer's folders, so a folder change relinks. */
export function linkedSkillKeys(
  ids: readonly string[] | null | undefined,
  folders?: () => readonly string[]
): readonly string[] | null {
  const roots = (folders?.() ?? []).map((root) => `folder:${root}`)
  return ids || roots.length > 0 ? [...(ids ?? []), ...roots] : null
}

/** A settings folder as main reads it: `~` expanded, and null for what is not a path at all — main's
 *  cwd is nobody's home, so a relative one names a different folder per chat and is never guessed at. */
export function resolveSkillRoot(root: string): string | null {
  const trimmed = root.trim()
  const path = /^~[\\/]/.test(trimmed) ? join(homedir(), trimmed.slice(2)) : trimmed
  // A bare home or root would walk every folder below it and load every SKILL.md it found.
  const tooBroad = ['/', homedir(), join(homedir(), '')]
  return isAbsolute(path) && !tooBroad.includes(path) ? path : null
}

/** The bot's own folder of skills: where it writes one, and where the owner drops one. It is scanned
 *  like a skills folder, and listed first so its skill wins a name a project also uses. */
export async function scanOwnSkills(
  bot: Pick<Bot, 'folder'>,
  botsRoot?: string
): Promise<{ name: string; path: string; skills: ScannedSkill[]; kind: 'own' }[]> {
  // No bots root means no home to read: a host with none has nowhere a bot could have written one.
  const home = botsRoot ?? botsRootFolder()
  if (!home || !bot.folder) {
    return []
  }
  // Either folder, because a bot may have been created for one agent and run another.
  for (const skillFolder of SKILL_FOLDERS) {
    const path = join(home, bot.folder, skillFolder, 'skills')
    const skills = await scanSkillsFolder(path)
    if (skills.length > 0) {
      return [{ name: bot.folder, path, skills, kind: 'own' }]
    }
  }
  return []
}

export async function scanSkillRoots(
  roots: readonly string[]
): Promise<{ name: string; path: string; skills: ScannedSkill[]; kind: 'folder' }[]> {
  const scanned = await Promise.all(
    roots.map(
      async (
        root
      ): Promise<{ name: string; path: string; skills: ScannedSkill[]; kind: 'folder' }[]> => {
        const path = resolveSkillRoot(root)
        if (path === null) {
          return []
        }
        const skills = await scanSkillsFolder(path)
        return skills.length > 0 ? [{ name: path, path, skills, kind: 'folder' as const }] : []
      }
    )
  )
  return scanned.flat()
}
