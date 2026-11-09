import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  USAGE_PROVIDER_MANIFEST,
  USAGE_PROVIDER_MANIFEST_IDS
} from '../../shared/usage-providers/usage-provider-manifest'
import { usageProviderPendingReadout } from '../../shared/usage-providers/usage-provider-readouts'
import { disabledUsageProviderSnapshot } from '../rate-limits/service/service-state'
import { HOST_SETTINGS_CREDENTIAL_PORTS } from './host-settings-credential-ports'

/**
 * Why this file exists: the manifest can say where a provider's credential lives,
 * but only a walk of the tree can say whether some *other* credential store exists
 * that nobody classified. That is the check an upstream `foo-api-key-store.ts`
 * fails, and the reason the MiniMax session cookie is not replicated in silence.
 *
 * It lives in `src/main` rather than beside the manifest because the port registry
 * and the stores it names are main-side; a shared test importing them would pull
 * Electron into the graph the CLI typecheck reads.
 */

const MAIN_ROOT = resolve(import.meta.dirname, '..')

/**
 * What a credential store is called here. Matched on the file name, not the path.
 *
 * Why a keyword rather than a fixed suffix list: the shapes a provider store can take
 * are open, and a fixed list is how `antigravity/native-account-store.ts` went
 * unclassified. The leading `(^|-)` accepts both `api-key-store.ts` and
 * `foo-api-key-store.ts`, so an upstream provider is caught whichever it picks.
 */
const CREDENTIAL_STORE_PATTERNS = [
  /(^|-)api-?keys?(-file)?-store\.ts$/,
  /(^|-)credentials?-store\.ts$/,
  /(^|-)cookies?-store\.ts$/,
  /(^|-)tokens?-store\.ts$/,
  /(^|-)secrets?-store\.ts$/,
  /(^|-)accounts?-store\.ts$/,
  /(^|-)passwords?-store\.ts$/,
  /-vault-file\.ts$/
]

/**
 * Stores the census finds that are not a usage provider's credential.
 *
 * Every row is a deliberate classification, so a store added upstream lands here or
 * in the manifest — never in neither.
 */
const NON_USAGE_CREDENTIAL_STORES: readonly { storeModule: string; reason: string }[] = [
  {
    storeModule: 'bitbucket/credential-store',
    reason: 'Bitbucket integration credentials; carries host-local site metadata, so no port yet.'
  },
  {
    storeModule: 'browser-passwords/browser-password-store',
    reason: 'Saved web passwords for the embedded browser, not a provider credential.'
  },
  {
    storeModule: 'browser-passwords/browser-password-vault-file',
    reason: 'The file format the browser password vault is written in.'
  },
  {
    storeModule: 'credentials/encrypted-api-key-file-store',
    reason: 'The shared ciphertext file both provider stores are built on, not a credential itself.'
  },
  {
    storeModule: 'host/electron-secret-store',
    reason: 'The OS keychain wrapper every other store seals through, not a credential itself.'
  },
  {
    storeModule: 'jira/site-credential-store',
    reason: 'Jira integration tokens; replicated through the `jira` port, one per site.'
  },
  {
    storeModule: 'jenkins/jenkins-server-store',
    reason: 'Jenkins integration tokens; replicated through the `jenkins` port, one per server.'
  },
  {
    storeModule: 'linear/linear-token-store',
    reason: 'Linear integration token; carries a workspace list beside the secret, so no port yet.'
  },
  {
    storeModule: 'orcad/orcad-secret-store',
    reason: 'The orcad credential vault; its entries are claimed by their own integration.'
  },
  {
    storeModule: 'persistence/moving-wsl-projects/wsl-move-browser-cookie-store',
    reason: 'Browser session cookies moved with a WSL project, not a provider credential.'
  },
  {
    storeModule: 'plugins/plugin-secrets-store',
    reason: "A plugin's own secrets, which the plugin manifest declares."
  },
  {
    storeModule: 'speech/openai-api-key-store',
    reason: 'Speech-to-text key, not a usage provider.'
  }
]

/** Port kinds claimed by a store above rather than by a provider. */
const INTEGRATION_PORT_KINDS: readonly string[] = ['jira', 'jenkins']

function listCredentialStoreModules(): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (CREDENTIAL_STORE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        found.push(relative(MAIN_ROOT, path).split(sep).join('/').replace(/\.ts$/, ''))
      }
    }
  }
  walk(MAIN_ROOT)
  return found.sort()
}

const manifestStoreModules = new Set(
  USAGE_PROVIDER_MANIFEST_IDS.flatMap((providerId) =>
    USAGE_PROVIDER_MANIFEST[providerId].credentials.flatMap((credential) =>
      credential.storeModule === undefined ? [] : [credential.storeModule]
    )
  )
)

describe('credential store census', () => {
  it('classifies every credential store in src/main', () => {
    const unclassified = listCredentialStoreModules().filter(
      (storeModule) =>
        !manifestStoreModules.has(storeModule) &&
        !NON_USAGE_CREDENTIAL_STORES.some((row) => row.storeModule === storeModule)
    )
    expect(
      unclassified,
      'classify it in src/shared/usage-providers/usage-provider-manifest.ts, or in NON_USAGE_CREDENTIAL_STORES here'
    ).toEqual([])
  })

  it('claims no store that is not there, so the list cannot go stale', () => {
    // Why existence rather than membership in the walk: a row may document a store the
    // patterns deliberately do not scan (shared ciphertext plumbing, an integration's
    // server list), and that row must still point at a file that is really there.
    const claimed = [
      ...manifestStoreModules,
      ...NON_USAGE_CREDENTIAL_STORES.map((row) => row.storeModule)
    ]
    expect(
      claimed.filter((storeModule) => !existsSync(join(MAIN_ROOT, `${storeModule}.ts`)))
    ).toEqual([])
  })

  it('gives every unclassified store a reason, so the next reader is not guessing', () => {
    expect(NON_USAGE_CREDENTIAL_STORES.filter((row) => row.reason.trim().length === 0)).toEqual([])
  })

  it('claims every host-settings port exactly once', () => {
    const claims = [
      ...USAGE_PROVIDER_MANIFEST_IDS.flatMap((providerId) =>
        USAGE_PROVIDER_MANIFEST[providerId].credentials.flatMap((credential) =>
          credential.kind === 'replicated' ? [credential.portKind] : []
        )
      ),
      ...INTEGRATION_PORT_KINDS
    ]
    const portKinds = HOST_SETTINGS_CREDENTIAL_PORTS.map((port) => port.kind)
    // Why both directions: an unclaimed port is a credential nobody replicates on purpose,
    // and a claim naming no port is a provider whose key silently stopped travelling.
    expect([...claims].sort()).toEqual([...portKinds].sort())
    expect(new Set(claims).size).toBe(claims.length)
  })
})

describe('disabled usage provider snapshots', () => {
  it('carry exactly the readout the manifest declares', () => {
    for (const providerId of USAGE_PROVIDER_MANIFEST_IDS) {
      const snapshot = disabledUsageProviderSnapshot(providerId)
      const readoutKeys = Object.keys(usageProviderPendingReadout(providerId)).sort()
      const snapshotReadout = Object.keys(snapshot)
        .filter(
          (key) => !['provider', 'session', 'weekly', 'updatedAt', 'error', 'status'].includes(key)
        )
        .sort()
      expect(snapshotReadout, providerId).toEqual(readoutKeys)
    }
  })
})
