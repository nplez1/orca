import { parseDocument } from 'yaml'
import { isOrcaYamlConversionWithinLimit } from './orca-yaml-merge-expansion'
import type { OrcaDefaultTabTemplate, OrcaHooks } from './orca-yaml-hook-types'
import {
  isOrcaYamlTextWithinLimit,
  MAX_ORCA_YAML_ALIAS_COUNT,
  MAX_ORCA_YAML_COLLECTION_ENTRIES
} from './orca-yaml-file-limit'
import { asRecord, asTrimmedString } from './orca-yaml-fields'
import { normalizeVmRecipes } from './orca-yaml-vm-recipes'

const DEFAULT_TAB_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/

// Bound work requested by one repository file.
const MAX_SHARED_DIRECTORIES = 100

/** Normalize safe repo-relative paths. Reject internal ./ rather than collapsing it: Git reports the collapsed path,
 * so stored comparisons would miss and symlinks would appear permanently untracked. */
function normalizeSharedDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_SHARED_DIRECTORIES)) {
    const raw = asTrimmedString(entry)
    if (!raw) {
      continue
    }
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const segments = normalized.split('/')
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized) ||
      segments.includes('..') ||
      segments.includes('.') ||
      segments.includes('') ||
      segments.includes('.git')
    ) {
      continue
    }
    seen.add(normalized)
  }
  return Array.from(seen)
}

function normalizeDefaultTabs(value: unknown): OrcaDefaultTabTemplate[] {
  if (!Array.isArray(value) || value.length > MAX_ORCA_YAML_COLLECTION_ENTRIES) {
    return []
  }

  return value
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) {
        return null
      }
      const title = asTrimmedString(record.title)
      const command = asTrimmedString(record.command)
      const color = asTrimmedString(record.color)
      const normalizedColor = color && DEFAULT_TAB_COLOR_RE.test(color) ? color : undefined
      if (!title && !command && !normalizedColor) {
        return null
      }
      return {
        ...(title ? { title } : {}),
        ...(normalizedColor ? { color: normalizedColor } : {}),
        ...(command ? { command } : {})
      }
    })
    .filter((entry): entry is OrcaDefaultTabTemplate => entry !== null)
}

/**
 * Parse the supported project defaults from `orca.yaml`.
 */
export function parseOrcaYaml(content: string): OrcaHooks | null {
  if (!isOrcaYamlTextWithinLimit(content)) {
    return null
  }

  let root: unknown
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      merge: true,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (document.errors.length > 0 || !isOrcaYamlConversionWithinLimit(document)) {
      return null
    }
    root = document.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
  } catch {
    return null
  }

  const record = asRecord(root)
  if (!record) {
    return null
  }

  const scriptsRecord = asRecord(record.scripts)
  const setup = scriptsRecord ? asTrimmedString(scriptsRecord.setup) : undefined
  const archive = scriptsRecord ? asTrimmedString(scriptsRecord.archive) : undefined
  const setupAgentStartupPolicy =
    record.setupAgentStartupPolicy === 'start-immediately' ||
    record.setupAgentStartupPolicy === 'wait-for-setup'
      ? record.setupAgentStartupPolicy
      : undefined
  const issueCommand = asTrimmedString(record.issueCommand)
  const defaultTabs = normalizeDefaultTabs(record.defaultTabs)
  const environmentRecipeParse = normalizeVmRecipes(record.environmentRecipes)
  const environmentRecipes = environmentRecipeParse.recipes
  const environmentRecipeDiagnostics = environmentRecipeParse.diagnostics
  const worktreeRecord = asRecord(record.worktree)
  const sharedDirectories = worktreeRecord
    ? normalizeSharedDirectories(worktreeRecord.sharedDirectories)
    : []

  if (
    !setup &&
    !archive &&
    !issueCommand &&
    !setupAgentStartupPolicy &&
    defaultTabs.length === 0 &&
    environmentRecipes.length === 0 &&
    environmentRecipeDiagnostics.length === 0 &&
    sharedDirectories.length === 0
  ) {
    return null
  }

  return {
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {})
    },
    ...(setupAgentStartupPolicy ? { setupAgentStartupPolicy } : {}),
    ...(issueCommand ? { issueCommand } : {}),
    ...(defaultTabs.length > 0 ? { defaultTabs } : {}),
    ...(environmentRecipes.length > 0 ? { environmentRecipes } : {}),
    ...(environmentRecipeDiagnostics.length > 0 ? { environmentRecipeDiagnostics } : {}),
    ...(sharedDirectories.length > 0 ? { worktree: { sharedDirectories } } : {})
  }
}
