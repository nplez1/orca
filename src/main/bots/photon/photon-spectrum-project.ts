// An existing Spectrum project's pair proving itself before Orca keeps anything: the project id from the
// owner's dashboard and its project secret. This is the Spectrum Cloud host, not the Beta API that
// `photon-contract.ts` pins — no version header, HTTP Basic instead of a Bearer key — so it has its own
// base and its own schema rather than sharing a contract it does not speak.
//
// The read is the cheapest call that answers "is this pair real": the same one `Spectrum()` makes at
// startup, and the only one that answers with the project's slug, which is all the record needs from it.
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'

/** Where a Spectrum project's own settings live, and the host the pair authenticates against. */
export const SPECTRUM_CLOUD_BASE = 'https://spectrum.photon.codes'

/** One deadline for the probe, so a half-open connection cannot hold a connect call for ever. */
const SPECTRUM_PROBE_TIMEOUT_MS = 20_000

const NonEmpty = lazyZodSchema(() => z.string().min(1))

/** Spectrum Cloud wraps every answer in `{ succeed, data }`; a project read carries id, name and slug. */
const SpectrumProjectResponse = lazyZodSchema(() =>
  z
    .object({
      succeed: z.boolean(),
      data: z.object({
        id: NonEmpty,
        name: z.string(),
        slug: NonEmpty.optional()
      })
    })
    .transform((envelope, ctx) => {
      if (!envelope.succeed) {
        ctx.addIssue({ code: 'custom', path: ['succeed'], message: 'The read refused' })
        return z.NEVER
      }
      return {
        projectId: envelope.data.id,
        name: envelope.data.name,
        slug: envelope.data.slug ?? null
      }
    })
)

export type PhotonSpectrumProject = z.infer<typeof SpectrumProjectResponse>

/** The project's enabled platforms, which is how a project with no iMessage is caught before it is saved. */
const SpectrumPlatformsResponse = lazyZodSchema(() =>
  z
    .object({
      succeed: z.boolean(),
      data: z.record(z.string(), z.object({ enabled: z.boolean() }))
    })
    .transform((envelope, ctx) => {
      if (!envelope.succeed) {
        ctx.addIssue({ code: 'custom', path: ['succeed'], message: 'The read refused' })
        return z.NEVER
      }
      return envelope.data
    })
)

export type PhotonSpectrumFetch = (input: string, init: RequestInit) => Promise<Response>

/** The Basic header the pair is sent as. Never logged, and never part of an error message. */
function basicAuth(projectId: string, projectSecret: string): string {
  return `Basic ${Buffer.from(`${projectId}:${projectSecret}`, 'utf8').toString('base64')}`
}

/** One GET against the Spectrum Cloud root, with the project's pair when the call needs it. */
async function spectrumGet(
  input: {
    baseUrl?: string
    fetchImpl?: PhotonSpectrumFetch
  },
  path: string,
  authorization?: string
): Promise<Response> {
  const base = (input.baseUrl ?? SPECTRUM_CLOUD_BASE).replace(/\/+$/, '')
  const send = input.fetchImpl ?? ((target, init) => fetch(target, init))
  return send(`${base}${path}`, {
    method: 'GET',
    headers: {
      ...(authorization ? { authorization } : {}),
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(SPECTRUM_PROBE_TIMEOUT_MS)
  })
}

/**
 * Whether the project can receive an iMessage at all, which is what this channel reads. `null` is "Orca
 * does not know": the platforms read is not part of proving the pair, so an answer this build cannot
 * read is passed over rather than refusing a project the pair already proved.
 */
async function projectReadsImessage(
  input: { baseUrl?: string; fetchImpl?: PhotonSpectrumFetch },
  projectId: string
): Promise<boolean | null> {
  try {
    const response = await spectrumGet(
      input,
      `/projects/${encodeURIComponent(projectId)}/platforms/`
    )
    if (!response.ok) {
      return null
    }
    const parsed = SpectrumPlatformsResponse.safeParse(await response.json())
    return parsed.success ? (parsed.data.imessage?.enabled ?? null) : null
  } catch {
    return null
  }
}

/**
 * Reads the project the pair names, or throws a refusal that says what to do about it. Three answers,
 * because they are three different mistakes: the pair is wrong, the project does not exist, or Spectrum
 * would not answer at all. A project with no iMessage platform is a fourth: the pair is real and nothing
 * would ever reach the bot.
 */
export async function probePhotonSpectrumProject(input: {
  projectId: string
  projectSecret: string
  baseUrl?: string
  fetchImpl?: PhotonSpectrumFetch
}): Promise<PhotonSpectrumProject> {
  const url = `/projects/${encodeURIComponent(input.projectId)}/`
  let response: Response
  try {
    response = await spectrumGet(input, url, basicAuth(input.projectId, input.projectSecret))
  } catch (error) {
    // The reason only: a thrown fetch error carries the URL, which carries the project id and never the
    // secret, but the pair is what was refused and that is what the owner has to be told about.
    throw new Error(
      `Orca could not reach Spectrum to check project ${input.projectId}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Spectrum refused that project id and project secret. Paste both from the project’s Settings page: the id starts with pho_prj_, and the secret is the project’s own rather than an account service key.`
    )
  }
  if (response.status === 404) {
    throw new Error(
      `Spectrum has no project ${input.projectId}. Check the id on the project’s Settings page: it is the project’s own id, not the organization’s.`
    )
  }
  if (!response.ok) {
    throw new Error(
      `Spectrum could not read project ${input.projectId}: it answered ${response.status}.`
    )
  }
  const body: unknown = await response.json().catch(() => null)
  const parsed = SpectrumProjectResponse.safeParse(body)
  if (!parsed.success) {
    // Issues only: a zod issue names the path and the rule, never the value it refused.
    throw new Error(
      `Spectrum answered project ${input.projectId} with a shape Orca does not recognise (${parsed.error.issues
        .map((issue) => issue.path.join('.') || 'root')
        .join(', ')}).`
    )
  }
  if (parsed.data.projectId !== input.projectId) {
    throw new Error(
      `Spectrum answered project ${parsed.data.projectId} for the id that was pasted (${input.projectId}), so nothing was saved.`
    )
  }
  if ((await projectReadsImessage(input, parsed.data.projectId)) === false) {
    throw new Error(
      `Spectrum project ${parsed.data.projectId} has no iMessage platform enabled, so nothing would ever reach this bot. Turn iMessage on for the project in Spectrum, then connect it again.`
    )
  }
  return parsed.data
}
