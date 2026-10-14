import type { HandlerGroup } from './handler-group-manifest'

// Why split out: the Linear surface is a long, self-contained provider command list, so it
// keeps handler-group-manifest.ts readable and under the max-lines budget.
export const LINEAR_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'linear',
    keys: [
      'linear save-issue',
      'linear list-issues',
      'linear relation add',
      'linear relation remove',
      'linear issue',
      'linear search',
      'linear team list',
      'linear team members',
      'linear team states',
      'linear team labels',
      'linear project list',
      'linear list',
      'linear status set',
      'linear assignee set',
      'linear assignee clear',
      'linear priority set',
      'linear priority clear',
      'linear estimate set',
      'linear estimate clear',
      'linear due-date set',
      'linear due-date clear',
      'linear label add',
      'linear label remove',
      'linear label set',
      'linear comment add',
      'linear attach',
      'linear create'
    ],
    load: async () => (await import('./handlers/linear.js')).LINEAR_HANDLERS
  }
]
