/** Update fields the runtime copies onto a stored automation when the caller sent them. */
export const RUNTIME_AUTOMATION_PATCH_KEYS = [
  'name',
  'prompt',
  'precheck',
  // Null is a value here and in agentId: it clears the command.
  'action',
  'agentId',
  'extraAgentArgs',
  'launchSetupPatch',
  'runContext',
  'sourceContext',
  'baseBranch',
  'setupDecision',
  'setupTrustHash',
  'reuseSession',
  'timezone',
  'rrule',
  'dtstart',
  'enabled',
  'missedRunGraceMinutes',
  // Set only in process (a plugin's ownership ending); RPC params never carry it.
  'createdBy'
] as const
