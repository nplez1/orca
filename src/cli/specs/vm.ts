import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

export const VM_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['vm', 'recipe', 'extend'],
    summary: 'Run a per-workspace environment recipe extend hook against a stored recipe result',
    usage:
      'orca vm recipe extend <recipe-id> --recipe-result <file> --lifetime <duration> [--repo-path <path>] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'recipe-id', 'repo-path', 'recipe-result', 'lifetime'],
    positionalArgs: ['recipe-id'],
    notes: [
      'Runs the recipe extend hook from the command line, without the desktop app, so a provider author can exercise it before relying on it.',
      'The recipe result is the JSON object the create script printed, saved to a file.',
      'The lifetime must be one the recipe declares in extendDurations; the updated result is printed on stdout for the destroy hook to consume.',
      'Extending a live lease from the app also updates the persisted runtime; this command only reports what the hook produced.'
    ],
    examples: [
      'orca vm recipe extend cloud-sandbox --recipe-result ./result.json --lifetime 4h',
      'orca vm recipe extend cloud-sandbox --recipe-result ./result.json --lifetime 4h --json'
    ]
  },
  {
    path: ['vm', 'recipe', 'doctor'],
    summary: 'Validate a per-workspace environment recipe without provisioning by default',
    usage:
      'orca vm recipe doctor <recipe-id> [--repo-path <path>] [--provision|--connect] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'recipe-id', 'repo-path', 'provision', 'connect'],
    positionalArgs: ['recipe-id'],
    notes: [
      'Reads environmentRecipes from orca.yaml in the repo path, validates the selected recipe, and reports agent-friendly checks.',
      'This default mode is non-destructive and does not run the recipe command.',
      'Use --provision or --connect to run the recipe, validate its result, and run cleanup when configured.'
    ],
    examples: [
      'orca vm recipe doctor cloud-sandbox',
      'orca vm recipe doctor cloud-sandbox --repo-path /path/to/repo --json',
      'orca vm recipe doctor cloud-sandbox --provision --json'
    ]
  }
]
