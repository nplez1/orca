import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { RepoSelector } from './github-repo-target-params'
import { requiredString } from '../rpc-param-primitives'

export const BindableAccounts = lazyZodSchema(() =>
  RepoSelector.extend({
    refreshCapability: z.boolean().optional()
  })
)

export const ValidateAccountBinding = lazyZodSchema(() =>
  RepoSelector.extend({
    host: requiredString('Missing host'),
    user: requiredString('Missing user'),
    kind: z.enum(['user', 'app']).optional()
  })
)
