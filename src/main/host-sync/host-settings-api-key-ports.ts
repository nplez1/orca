import {
  clearDeepSeekApiKey,
  getDeepSeekApiKeyProtection,
  hasDeepSeekApiKey,
  readDeepSeekApiKey,
  saveDeepSeekApiKey
} from '../deepseek/deepseek-api-key-store'
import {
  clearMiniMaxApiKey,
  getMiniMaxApiKeyProtection,
  hasMiniMaxApiKey,
  readMiniMaxApiKey,
  saveMiniMaxApiKey
} from '../minimax/minimax-api-key-store'
import {
  clearOpenCodeGoApiKey,
  getOpenCodeGoApiKeyProtection,
  hasOpenCodeGoApiKey,
  readOpenCodeGoApiKey,
  saveOpenCodeGoApiKey
} from '../opencode/opencode-go-api-key-store'
import {
  clearZcodePlanApiKey,
  getZcodePlanApiKeyProtection,
  hasZcodePlanApiKey,
  readZcodePlanApiKey,
  saveZcodePlanApiKey
} from '../zcode/zcode-plan-api-key-store'
import { createHostSettingsApiKeyPort } from './host-settings-api-key-port'
import {
  canSealReplicatedCredential,
  type HostSettingsCredentialPort
} from './host-settings-credential-port'

// Why one answer for every port: a store that can only write plaintext must not report that it can
// seal, or the receiver would accept a downgrade the policy means to refuse.
const canSeal = canSealReplicatedCredential

/**
 * The provider keys this host can replicate.
 *
 * Why `kind` names one credential rather than one family: a port is matched to a credential by its
 * kind alone, so four ports sharing `api-key` would send every key to whichever port was registered
 * first and drop the rest as no-ops. The factory is still the shared code; only the label differs.
 *
 * Why not every credential the app holds: these are the single-key stores, whose read/save pair is
 * exactly the port's shape. The structured payloads (Fireworks, Copilot) need a JSON adaptor each,
 * and the integration credentials (Jira, Jenkins, Bitbucket, Linear) carry non-secret metadata
 * beside the secret plus a host-local site list, so each of those is an adapter of its own.
 */
export const HOST_SETTINGS_API_KEY_PORTS: HostSettingsCredentialPort[] = [
  createHostSettingsApiKeyPort({
    kind: 'api-key:deepseek',
    id: 'api-key:deepseek',
    label: 'DeepSeek API key',
    canSeal,
    store: {
      has: hasDeepSeekApiKey,
      read: readDeepSeekApiKey,
      save: saveDeepSeekApiKey,
      clear: clearDeepSeekApiKey,
      protection: getDeepSeekApiKeyProtection
    }
  }),
  createHostSettingsApiKeyPort({
    kind: 'api-key:minimax',
    id: 'api-key:minimax',
    label: 'MiniMax API key',
    canSeal,
    store: {
      has: hasMiniMaxApiKey,
      read: readMiniMaxApiKey,
      save: saveMiniMaxApiKey,
      clear: clearMiniMaxApiKey,
      protection: getMiniMaxApiKeyProtection
    }
  }),
  createHostSettingsApiKeyPort({
    kind: 'api-key:opencode-go',
    id: 'api-key:opencode-go',
    label: 'OpenCode Go API key',
    canSeal,
    store: {
      has: hasOpenCodeGoApiKey,
      read: readOpenCodeGoApiKey,
      save: saveOpenCodeGoApiKey,
      clear: clearOpenCodeGoApiKey,
      protection: getOpenCodeGoApiKeyProtection
    }
  }),
  createHostSettingsApiKeyPort({
    kind: 'zcode-plan',
    id: 'zcode-plan',
    label: 'GLM Coding Plan API key',
    canSeal,
    store: {
      has: hasZcodePlanApiKey,
      read: readZcodePlanApiKey,
      save: saveZcodePlanApiKey,
      clear: clearZcodePlanApiKey,
      protection: getZcodePlanApiKeyProtection
    }
  })
]
