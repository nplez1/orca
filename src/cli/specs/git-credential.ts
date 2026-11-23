import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

const REPO_FLAG_NOTE =
  'The project folder the push is in. Orca reads the account bound to it; nothing is inferred from the working directory.'

/** git's credential-helper protocol: `get` answers on stdout, and store/erase have nothing to keep. */
export const GIT_CREDENTIAL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['git-credential', 'get'],
    summary: 'Answer git’s credential request with the GitHub App bound to a project',
    usage: 'orca git-credential get --repo <folder>',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      REPO_FLAG_NOTE,
      'git runs this itself through credential.helper; a person never needs to. git appends its own get/erase/store operation, and a project with no App bound is refused rather than answered as your own login.'
    ],
    hidden: true
  },
  {
    path: ['git-credential', 'store'],
    summary: 'Accept git’s credential store operation, which keeps nothing',
    usage: 'orca git-credential store --repo <folder>',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [REPO_FLAG_NOTE, 'A token is minted per request, so there is nothing to store.'],
    hidden: true
  },
  {
    path: ['git-credential', 'erase'],
    summary: 'Accept git’s credential erase operation, which drops nothing',
    usage: 'orca git-credential erase --repo <folder>',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [REPO_FLAG_NOTE, 'A token is minted per request, so there is nothing to erase.'],
    hidden: true
  }
]
