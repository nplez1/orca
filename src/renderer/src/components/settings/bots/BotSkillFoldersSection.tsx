// Settings › Bots: folders of skills this computer's bots load, so a skills tree kept outside Orca
// (such as `~/.agents/skills`) reaches every bot here instead of being linked project by project.
import React, { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'

/** Whether a folder here is a path main can resolve: absolute, or `~`-rooted, which it expands. */
export function isSkillFolderPath(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('~/') || (trimmed.length > 1 && trimmed.startsWith('/'))
}

export function BotSkillFoldersSection(): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const folders = Array.isArray(settings?.botSkillFolders) ? settings.botSkillFolders : []
  const [draft, setDraft] = useState('')
  const folder = draft.trim()
  const duplicate = folders.includes(folder)
  const valid = isSkillFolderPath(folder) && !duplicate
  const add = (): void => {
    if (!valid) {
      return
    }
    void updateSettings({ botSkillFolders: [...folders, folder] })
    setDraft('')
  }
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('settings.bots.skillFolders', 'Skill folders')}
        description={t(
          'settings.bots.skillFoldersDescription',
          'Folders on this computer whose children are skills. Every bot here loads them beside the projects it links, so a skill can carry its tools with it.'
        )}
      />
      {folders.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {folders.map((entry) => (
            <li key={entry} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 break-all">{entry}</span>
              <Button
                size="xs"
                variant="ghost"
                aria-label={t('settings.bots.skillFoldersRemoveOne', 'Stop loading {{folder}}', {
                  folder: entry
                })}
                onClick={() =>
                  void updateSettings({
                    botSkillFolders: folders.filter((kept) => kept !== entry)
                  })
                }
              >
                {t('settings.bots.skillFoldersRemove', 'Remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <Label htmlFor={inputId} className="sr-only">
          {t('settings.bots.skillFoldersAddLabel', 'Folder of skills')}
        </Label>
        <Input
          id={inputId}
          autoComplete="off"
          spellCheck={false}
          className="h-7 max-w-80"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('settings.bots.skillFoldersPlaceholder', '~/.agents/skills')}
          aria-invalid={folder.length > 0 && !valid}
          aria-describedby={`${inputId}-hint`}
        />
        <Button type="submit" size="xs" variant="outline" disabled={!valid}>
          {t('settings.bots.skillFoldersAdd', 'Add folder')}
        </Button>
      </form>
      <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
        {duplicate
          ? t('settings.bots.skillFoldersDuplicate', 'That folder is already listed.')
          : folder.length > 0 && !valid && !duplicate
            ? t(
                'settings.bots.skillFoldersMustBeAbsolute',
                'Give a full path, or one that starts with ~/. A relative path means a different folder per chat.'
              )
            : t(
                'settings.bots.skillFoldersWhen',
                'A change reaches a bot with its next message. Each child must hold a SKILL.md that names the skill; a folder with none loads nothing and is dropped silently.'
              )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          'settings.bots.skillFoldersShared',
          'Whatever is in these folders is loaded by every bot on this computer, including bots other people can message. Keep a shared folder to tools you would hand them anyway.'
        )}
      </p>
    </section>
  )
}
