// Skills from places that are not a linked project: the bot's own home folder, which it can write to,
// and the folders of skills this computer shares with every bot.
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'
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

/** A settings folder as main reads it: `~` expanded, normalised, and null for what is not a path at
 *  all — main's cwd is nobody's home, so a relative one names a different folder per chat. */
export function resolveSkillRoot(root: string): string | null {
  const trimmed = root.trim()
  const expanded = /^~[\\/]/.test(trimmed) ? join(homedir(), trimmed.slice(2)) : trimmed
  if (!isAbsolute(expanded)) {
    return null
  }
  const path = resolve(expanded)
  // A bare root or home would walk every folder below it and load every SKILL.md it found; comparing
  // resolved paths is what makes `~/.`, `/Users/me/` and `C:\\` fail like the bare form does.
  const tooBroad = new Set([parse(path).root, resolve(homedir())])
  return tooBroad.has(path) ? null : path
}

/** The bot's own folder of skills: where it writes one, and where the owner drops one. */
export async function scanOwnSkills(
  bot: Pick<Bot, 'folder'>,
  botsRoot?: string
): Promise<{ name: string; path: string; skills: ScannedSkill[]; kind: 'own' }[]> {
  // No bots root means no home to read: a host with none has nowhere a bot could have written one.
  const home = botsRoot ?? botsRootFolder()
  if (!home || !bot.folder) {
    return []
  }
  // Both folders, merged: a bot created for one agent and run under another keeps what it wrote in the
  // folder its old agent used, and picking one would hide the other.
  const scanned = await Promise.all(
    SKILL_FOLDERS.map(async (skillFolder) => {
      const path = join(home, bot.folder, skillFolder, 'skills')
      return { path, skills: await scanSkillsFolder(path) }
    })
  )
  const withSkills = scanned.filter((entry) => entry.skills.length > 0)
  return withSkills.length === 0
    ? []
    : [
        {
          name: bot.folder,
          path: withSkills[0].path,
          skills: withSkills.flatMap((entry) => entry.skills),
          kind: 'own' as const
        }
      ]
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
