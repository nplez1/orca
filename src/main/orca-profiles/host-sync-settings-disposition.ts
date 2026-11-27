import type { GlobalSettings } from '../../shared/settings/global-settings-types'

/** What host-settings replication does with one `GlobalSettings` property. */
export type SettingsFieldHostSyncDisposition =
  /** The main's value wins and the host applies it. */
  | 'replicated'
  /** Never leaves or arrives: it describes *this* machine. */
  | 'hostLocal'
  /** Fills a host that has nothing, and never overwrites a deliberate local value. */
  | 'replicatedOnlyIfEmpty'

/**
 * The `onHostSync` audit of every persisted setting: what one machine replicates to another.
 *
 * The three questions that decide a key, in order:
 *
 * 1. **Does the value name something only this machine has?** A path, a shell binary, an installed
 *    editor, a WSL distro, a GPU, an emulator device, an SSH target, a proxy for this network, the
 *    pairing address of this machine — those are `hostLocal`, because the same value on another host
 *    is either meaningless or actively wrong. This is the fork's own `hostLocal` example list, applied
 *    key by key, and it is why `terminalDefaultShell` is host-local while `terminalFontSize` is not:
 *    one names a binary, the other a preference.
 * 2. **Does the value record that this install already did something once?** `…Defaulted…`,
 *    `…Migrated…`, `…Seed`, `…Dismissed`, "…shown" and the history maps are
 *    `replicatedOnlyIfEmpty`-or-`hostLocal` bookkeeping. Copying a `…Migrated` flag to a fresh host
 *    would suppress that host's own migration, so those are `hostLocal` rather than
 *    `replicatedOnlyIfEmpty`; a history map is `replicatedOnlyIfEmpty`, because it should fill a host
 *    that has none and never overwrite one the user built.
 * 3. **Otherwise it is a deliberate preference or connection** — appearance, editor, terminal
 *    appearance, notifications, agent defaults, task sources, feature flags, skip-confirmation
 *    choices — and it is `replicated`, so a new machine is configured the way the user already
 *    configured the old one.
 *
 * The arguable calls, named so a reviewer can disagree with a specific one rather than the scheme:
 *
 * - `terminalGpuAcceleration`, `keepComputerAwakeWhileAgentsRun`, `computerAwakeMode` and
 *   `experimentalEphemeralVms` are `hostLocal`: each is a hardware or power decision, and the same
 *   answer on a machine without the hardware is a bug the user sees as a crash or a flat battery.
 * - `httpProxyUrl`, `httpProxyBypassRules` and `electronHttp1CompatibilityMode` are `hostLocal`: a
 *   laptop's corporate proxy and its HTTP/1 workaround do not describe a machine on another network.
 * - `codexManagedAccounts` and `claudeManagedAccounts` are `replicated` while the four
 *   `active…ManagedAccountId(sByRuntime)` keys are `hostLocal`: the list of accounts is the user's, but
 *   which one is *active* resolves against what is installed here.
 * - `opencodeSessionCookie` is `replicated` and is a secret living in a settings file rather than in
 *   the credential stores. It is in scope for the same reason the API keys are, and it is the one
 *   entry here that the credentials policy does not yet cover — see the note at the end.
 * - `telemetry` is `replicated`: consent is a decision the user made, not a property of the machine.
 * - `defaultRepoSelection` is `hostLocal` because a repository registration is host-local, so a
 *   default selection naming one cannot travel; `defaultLinearTeamSelection`, `defaultJiraBoard` and
 *   `defaultTaskSource` are `replicated` because they name an integration rather than a local path.
 * - `agentCmdOverrides`, `agentStateRulesPath`, `codexSessionSourceHome` and `devPluginPaths` are
 *   `hostLocal`: each is a filesystem path or an executable that exists on the main and may not exist
 *   on the host, which is the same reason `terminalDefaultShell` is host-local.
 *
 * Not covered by this audit: whether a `replicated` value is *safe* to send. That is the credentials
 * policy in `src/main/host-sync/`, which refuses a sealed value on a host that cannot seal it; a
 * settings value has no equivalent protection today, which is why the inventory is a contract rather
 * than an implementation.
 */
import { HOST_SYNC_DISPOSITION_ROWS_A } from './host-sync-settings-disposition-rows-a'
import { HOST_SYNC_DISPOSITION_ROWS_B } from './host-sync-settings-disposition-rows-b'

export const GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION = {
  ...HOST_SYNC_DISPOSITION_ROWS_A,
  ...HOST_SYNC_DISPOSITION_ROWS_B,
  // 2026-11-24 sync: upstream added these eight keys, classified here so the resolution stays in the
  // file the typecheck named; the two halves above are unchanged.
  // Why replicated, like `pluginSystemDefaultedOn`: a one-shot marker of a choice the user made, which
  // a host that has not seen it should follow rather than re-decide.
  agentDefaultSurfaceChosen: 'replicated',
  nativeChatAutoContinueAfterUsageLimitDefaultedOn: 'replicated',
  // Why replicated: a feature flag, like `experimentalAppRail`; the shared-servers cap is a preference.
  experimentalSharedCodexServers: 'replicated',
  // Why replicated: a skip-confirmation choice, like every other `skip…Confirm` key.
  skipDeleteChatConfirm: 'replicated',
  // Why replicated: which sign-in a chat on the Google account method uses is a preference; the
  // project it signs in against (`antigravityChatAuth`) stays host-local.
  antigravityGoogleSignIn: 'replicated',
  // Why replicated: a kill switch on Orca's own copy of agy, not a fact about what this machine has.
  antigravityManagedAgyEnabled: 'replicated',
  // Why hostLocal: upstream calls it host-owned — each host updates the server it installed, so the
  // main's answer would overwrite a host's own.
  antigravityServerAutoUpdateEnabled: 'hostLocal',
  // Why hostLocal: a pairing interface is this machine's own network interface, like
  // `mobilePairingCustomAddresses` and `machineName` next to it — meaningless or wrong on another host.
  runtimePairingInterface: 'hostLocal',
  // Why hostLocal: a caption cache keyed by `host|bot|avatar`, so every entry describes a picture this
  // machine made.
  generatedAvatarDescriptions: 'hostLocal'
} as const satisfies Record<keyof GlobalSettings, SettingsFieldHostSyncDisposition>
