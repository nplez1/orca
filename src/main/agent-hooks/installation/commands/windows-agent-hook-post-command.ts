import type { AgentHookSource } from '../../../../shared/agent-hook-listener/transport/agent-hook-relay'

// The agent's own process identity on Windows, as the native hook reports it.
//
// Why the env var: batch has no `$PPID`, so the JSON has to come from the process that could read it
// (the native `orca-agent-hook.exe`, or a launcher that captured it) and this is how it reaches curl.
// An unset value sends an empty field, which the listener already reads as "no identity" — exactly
// what a hook sending nothing looked like before, so the change cannot regress the outer guard.
export const WINDOWS_HOOK_AGENT_PROCESS_VAR = 'ORCA_HOOK_AGENT_PROCESS'

/** Extra form lines precede payload@- and must end with ` ^`. */
export function buildWindowsAgentHookPostCommand(
  source: AgentHookSource,
  extraFormLines: readonly string[] = []
): string {
  // Avoid PowerShell startup; qualify curl to prevent repo-local payload interception.
  return [
    `"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/${source}" ^`,
    '  --connect-timeout 0.5 --max-time 1.5 ^',
    '  -H "Content-Type: application/x-www-form-urlencoded" ^',
    '  -H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%" ^',
    '  --data-urlencode "paneKey=%ORCA_PANE_KEY%" ^',
    '  --data-urlencode "tabId=%ORCA_TAB_ID%" ^',
    '  --data-urlencode "launchToken=%ORCA_AGENT_LAUNCH_TOKEN%" ^',
    '  --data-urlencode "worktreeId=%ORCA_WORKTREE_ID%" ^',
    '  --data-urlencode "env=%ORCA_AGENT_HOOK_ENV%" ^',
    '  --data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%" ^',
    `  --data-urlencode "agentProcess=%${WINDOWS_HOOK_AGENT_PROCESS_VAR}%" ^`,
    ...extraFormLines,
    '  --data-urlencode "payload@-" >nul 2>nul'
  ].join('\r\n')
}

// curl.exe avoids PowerShell startup and code-page corruption of UTF-8 payloads.
export function buildWindowsAgentHookCurlPostCommand(source: AgentHookSource): string {
  return [
    '"%SystemRoot%\\System32\\curl.exe" -sS -X POST',
    `"http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/${source}"`,
    '--connect-timeout 0.5 --max-time 1.5',
    '-H "Content-Type: application/x-www-form-urlencoded"',
    '-H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"',
    '--data-urlencode "paneKey=%ORCA_PANE_KEY%"',
    '--data-urlencode "tabId=%ORCA_TAB_ID%"',
    '--data-urlencode "launchToken=%ORCA_AGENT_LAUNCH_TOKEN%"',
    '--data-urlencode "worktreeId=%ORCA_WORKTREE_ID%"',
    '--data-urlencode "env=%ORCA_AGENT_HOOK_ENV%"',
    '--data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%"',
    `--data-urlencode "agentProcess=%${WINDOWS_HOOK_AGENT_PROCESS_VAR}%"`,
    '--data-urlencode "payload@-"',
    '>nul 2>&1'
  ].join(' ')
}
