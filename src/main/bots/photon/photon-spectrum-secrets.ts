// An existing Spectrum project's secret, per bot: sealed through the host's secret store, in its own file,
// or held in memory for the session when the owner asked Orca not to keep one. Its own file rather than
// the account secrets file, because it is neither the account key nor a project key Orca minted — and
// because `projectCredential()` must never hand it to the Beta HTTP client, which authenticates a project
// key with a Bearer header against a different API.
//
// The project id is written beside the secret so a secret left behind by a re-connect to another project
// is recognised as stale instead of used: a secret only ever proves the project it was issued for.
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { readPhotonJson, writePhotonJson } from './photon-files'
import { sealPhotonSecret, unsealPhotonSecret } from './photon-secrets'
import { photonSpectrumSecretsPath } from './photon-store-paths'

const SpectrumProjectSecret = lazyZodSchema(() =>
  z.object({ projectId: z.string().min(1), secret: z.string().min(1) })
)
export type PhotonSpectrumProjectSecret = z.infer<typeof SpectrumProjectSecret>

const SpectrumSecretFile = lazyZodSchema(() =>
  z.object({ projects: z.record(z.string(), SpectrumProjectSecret).default({}) })
)
type SpectrumSecretFile = z.infer<typeof SpectrumSecretFile>

export class PhotonSpectrumSecrets {
  private file: SpectrumSecretFile | null = null
  private loading: Promise<void> | null = null
  /** One change at a time, so two connects cannot each write the other's bot away. */
  private queue: Promise<void> = Promise.resolve()
  /** A secret handed over for this session only. Never written unless the owner opted in, and the reason
   *  the default works on a host that cannot seal. */
  private readonly held = new Map<string, PhotonSpectrumProjectSecret>()

  constructor(private readonly userDataPath: string) {}

  get path(): string {
    return photonSpectrumSecretsPath(this.userDataPath)
  }

  /** The secret for one bot, opened only when this host can open it. A sealed secret this host cannot
   *  open is the same as no secret: the session copy is the fallback, and a paste is the repair. */
  async secret(botId: string): Promise<PhotonSpectrumProjectSecret | null> {
    await this.load()
    const stored = this.file?.projects[botId]
    if (stored) {
      const opened = unsealPhotonSecret(stored.secret)
      if (opened) {
        return { projectId: stored.projectId, secret: opened }
      }
      console.warn('[photon] a stored Spectrum secret cannot be opened on this host')
    }
    return this.held.get(botId) ?? null
  }

  /** Writes one bot's secret sealed, and nothing about it in the clear. The session keeps its own copy so
   *  a restart is what "stored" changes, not whether this run works. */
  put(botId: string, project: PhotonSpectrumProjectSecret): Promise<void> {
    this.held.set(botId, project)
    return this.change((file) => {
      file.projects[botId] = {
        projectId: project.projectId,
        secret: sealPhotonSecret(project.secret)
      }
      return true
    })
  }

  /** Keeps a secret for this session only: the channel reads it until Orca quits and nothing is written,
   *  which is what an owner who asked not to keep one gets instead of a refusal. */
  holdForSession(botId: string, project: PhotonSpectrumProjectSecret): void {
    this.held.set(botId, project)
  }

  /** Drops one bot's secret: what releasing its channel leaves behind. */
  forget(botId: string): Promise<void> {
    this.held.delete(botId)
    return this.change((file) => {
      if (!(botId in file.projects)) {
        return false
      }
      delete file.projects[botId]
      return true
    })
  }

  private async load(): Promise<void> {
    this.loading ??= this.read()
    await this.loading
  }

  private async read(): Promise<void> {
    if (this.file) {
      return
    }
    const read = await readPhotonJson(this.path, 'spectrum secrets')
    if (read.kind === 'parsed') {
      const parsed = SpectrumSecretFile.safeParse(read.value)
      if (parsed.success) {
        this.file = parsed.data
        return
      }
      // Issues only: an issue names the path and the rule, never the value it refused, so no fragment of
      // a secret reaches a log — and starting empty is what makes the next paste the repair.
      console.warn(
        '[photon] the Spectrum secrets file is unreadable; starting empty',
        parsed.error.issues.map((issue) => issue.path.join('.') || 'root')
      )
    }
    this.file = { projects: {} }
  }

  private change(mutate: (file: SpectrumSecretFile) => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      await this.load()
      const file = structuredClone(this.file ?? { projects: {} })
      if (!mutate(file)) {
        return
      }
      this.file = file
      await writePhotonJson(this.path, file)
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
