// Why a module of its own: renderer-reachable contracts (bots/bot-package) validate skill names,
// and the manifest module imports node:crypto, which Vite externalizes to a throwing stub in the browser.
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export function validateSkillPackageName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name) || WINDOWS_RESERVED_SEGMENT.test(name)) {
    throw new Error('skill-package-skill-name-invalid')
  }
}
