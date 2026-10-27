import fs from 'node:fs/promises'
import path from 'node:path'

// Why: upstream owns locales/en.json and en-runtime-required.json byte-for-byte, so the fork's
// added and overridden English strings live in an overlay that every reader merges on top.
// It sits outside locales/, which verifiers readdir as one locale per .json file.
const I18N_RELATIVE_DIR = path.join('src', 'renderer', 'src', 'i18n')
export const UPSTREAM_EN_CATALOG_RELATIVE_PATH = path.join(I18N_RELATIVE_DIR, 'locales', 'en.json')
export const UPSTREAM_RUNTIME_REQUIRED_RELATIVE_PATH = path.join(
  I18N_RELATIVE_DIR,
  'en-runtime-required.json'
)
export const FORK_EN_CATALOG_RELATIVE_PATH = path.join(I18N_RELATIVE_DIR, 'fork', 'en.json')
export const FORK_RUNTIME_REQUIRED_RELATIVE_PATH = path.join(
  I18N_RELATIVE_DIR,
  'fork',
  'en-runtime-required.json'
)

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeCatalogs(base, overlay) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] =
      isPlainObject(value) && isPlainObject(merged[key]) ? mergeCatalogs(merged[key], value) : value
  }
  return merged
}

async function readOptionalCatalog(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

export async function readForkEnglishCatalog(root) {
  return readOptionalCatalog(path.join(root, FORK_EN_CATALOG_RELATIVE_PATH))
}

export async function readEnglishCatalog(root) {
  const upstream = JSON.parse(
    await fs.readFile(path.join(root, UPSTREAM_EN_CATALOG_RELATIVE_PATH), 'utf8')
  )
  return mergeCatalogs(upstream, await readForkEnglishCatalog(root))
}

/** Upstream's shipped boot subset and the fork's, merged the way `i18n.ts` loads them. */
export async function readRuntimeRequiredCatalogs(root) {
  const upstream = JSON.parse(
    await fs.readFile(path.join(root, UPSTREAM_RUNTIME_REQUIRED_RELATIVE_PATH), 'utf8')
  )
  const fork = await readOptionalCatalog(path.join(root, FORK_RUNTIME_REQUIRED_RELATIVE_PATH))
  return { upstream, merged: mergeCatalogs(upstream, fork) }
}

function setCatalogEntry(catalog, key, value) {
  const parts = key.split('.')
  let cursor = catalog
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
}

async function writeCatalog(filePath, catalog) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
}

export async function writeForkEnglishCatalog(root, catalog) {
  await writeCatalog(path.join(root, FORK_EN_CATALOG_RELATIVE_PATH), catalog)
}

/** Routes new English keys into the fork overlay so upstream's en.json is never written. */
export async function writeMissingEnglishEntries(root, entries) {
  const overlay = await readForkEnglishCatalog(root)
  for (const [key, value] of entries) {
    setCatalogEntry(overlay, key, value)
  }
  await writeForkEnglishCatalog(root, overlay)
}

export async function writeForkRuntimeRequiredCatalog(root, catalog) {
  await writeCatalog(path.join(root, FORK_RUNTIME_REQUIRED_RELATIVE_PATH), catalog)
}
