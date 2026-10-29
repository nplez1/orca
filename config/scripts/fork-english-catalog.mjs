import fs from 'node:fs/promises'
import path from 'node:path'

// Why: upstream owns every file under locales/ byte-for-byte, so the fork's added, overridden and
// dropped strings live in overlays under i18n/fork/ that every reader merges on top. They sit
// outside locales/, which verifiers readdir as one locale per .json file. A `null` leaf is a
// tombstone: the fork dropped a feature, extraction then finds no source reference for upstream's
// key, and deleting it from its file was the only way to satisfy that check without an overlay.
const I18N_RELATIVE_DIR = path.join('src', 'renderer', 'src', 'i18n')
const UPSTREAM_LOCALES_RELATIVE_DIR = path.join(I18N_RELATIVE_DIR, 'locales')
export const UPSTREAM_EN_CATALOG_RELATIVE_PATH = path.join(UPSTREAM_LOCALES_RELATIVE_DIR, 'en.json')
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

/** The fork overlay for one locale; English keeps the historical `fork/en.json` path. */
export function forkLocaleCatalogRelativePath(locale) {
  return path.join(I18N_RELATIVE_DIR, 'fork', `${locale}.json`)
}

export function upstreamLocaleCatalogRelativePath(locale) {
  return path.join(UPSTREAM_LOCALES_RELATIVE_DIR, `${locale}.json`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Overlay merge. A `null` in the overlay removes the key: absent and null must not mean the same thing. */
export function mergeCatalogs(base, overlay) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete merged[key]
      continue
    }
    if (!isPlainObject(value)) {
      merged[key] = value
      continue
    }
    const existing = merged[key]
    const existingIsObject = isPlainObject(existing)
    const combined = mergeCatalogs(existingIsObject ? existing : {}, value)
    if (Object.keys(combined).length > 0) {
      merged[key] = combined
    } else if (existingIsObject) {
      delete merged[key]
    }
  }
  return merged
}

/** Dot paths of every tombstone in an overlay, so a dead one cannot outlive the key it deletes. */
export function collectCatalogTombstones(overlay, prefix = '') {
  const paths = []
  for (const [key, value] of Object.entries(overlay)) {
    const pathKey = prefix ? `${prefix}.${key}` : key
    if (value === null) {
      paths.push(pathKey)
    } else if (isPlainObject(value)) {
      paths.push(...collectCatalogTombstones(value, pathKey))
    }
  }
  return paths
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

export async function readForkLocaleCatalog(root, locale) {
  return readOptionalCatalog(path.join(root, forkLocaleCatalogRelativePath(locale)))
}

/** One locale as the app sees it: upstream's file with the fork's overlay merged over it. */
export async function readMergedLocaleCatalog(root, locale) {
  const upstream = JSON.parse(
    await fs.readFile(path.join(root, upstreamLocaleCatalogRelativePath(locale)), 'utf8')
  )
  return mergeCatalogs(upstream, await readForkLocaleCatalog(root, locale))
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
