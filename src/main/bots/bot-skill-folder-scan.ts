// Reading one folder of skills: the SKILL.md files under it, admitted only when they declare a name and a
// description and are real files. Shared by a linked project, the bot's own folder, and a computer folder.
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LinkedProjectSkill } from '../native-chat/native-chat-skill-roots'
import { skillDirectoryMaxDepth } from '../../shared/skills/discovery/skill-discovery-depth'
import { declaredSkillMetadata } from '../../shared/skills/discovery/skill-metadata'
import { findSkillFiles } from '../skills/discovery/skill-root-file-walk'

/** Where a project keeps skills for every agent, then Claude's own folder. */
export const SKILL_FOLDERS = ['.agents', '.claude'] as const
const MAX_SKILL_FILE_BYTES = 256 * 1024

/** An admitted skill, with the real folder its link in Orca's folder points to. */
export type ScannedSkill = LinkedProjectSkill & { folder: string }

export type ScannedProject = { skillsDir: string; skills: ScannedSkill[] }

/** A file's text, up to the cap; null when it can't be read. */
async function readCapped(path: string): Promise<string | null> {
  try {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min((await file.stat()).size, MAX_SKILL_FILE_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/** A skill folder (team setup scripts link them in) holding a real SKILL.md that declares its name
 *  and description. A SKILL.md that is itself a link could be any file, so it never counts. */
export async function admittedSkill(skillFile: string): Promise<ScannedSkill | null> {
  const entry = await lstat(skillFile).catch(() => null)
  if (!entry?.isFile()) {
    return null
  }
  const folder = await realpath(dirname(skillFile)).catch(() => null)
  const text = folder ? await readCapped(join(folder, 'SKILL.md')) : null
  const declared = text === null ? null : declaredSkillMetadata(text)
  if (!folder || !declared) {
    return null
  }
  const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()
  return {
    name: oneLine(declared.name),
    description: oneLine(declared.description),
    skillFile: join(folder, 'SKILL.md'),
    folder
  }
}

export async function scanSkillsFolder(
  skillsDir: string,
  signal?: AbortSignal
): Promise<ScannedSkill[]> {
  const files = await findSkillFiles(skillsDir, skillDirectoryMaxDepth('repo'), signal)
  const admitted = await Promise.all(files.map(admittedSkill))
  const byFolder = new Map<string, ScannedSkill>()
  for (const skill of admitted) {
    if (skill && !byFolder.has(skill.folder)) {
      byFolder.set(skill.folder, skill)
    }
  }
  return [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name))
}
