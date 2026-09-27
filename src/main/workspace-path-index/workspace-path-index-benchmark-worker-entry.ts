import { MessagePort, workerData } from 'node:worker_threads'
import './workspace-path-index-worker-entry'

type MemorySamplerRequest = { type: 'start' | 'stop' }
type WorkerMemoryUsageSample = {
  rssBytes: number
  heapUsedBytes: number
  externalBytes: number
  arrayBuffersBytes: number
}

const memoryPort = getMemoryPort(workerData)
if (memoryPort) {
  let sampler: ReturnType<typeof setInterval> | null = null
  memoryPort.on('message', (message: MemorySamplerRequest) => {
    if (message.type === 'start' && !sampler) {
      sampler = setInterval(() => {
        const memory = process.memoryUsage()
        const sample: WorkerMemoryUsageSample = {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers
        }
        memoryPort.postMessage(sample)
      }, 10)
      sampler.unref()
    } else if (message.type === 'stop' && sampler) {
      clearInterval(sampler)
      sampler = null
    }
  })
}

function getMemoryPort(value: unknown): MessagePort | null {
  if (typeof value !== 'object' || value === null || !('memoryPort' in value)) {
    return null
  }
  return value.memoryPort instanceof MessagePort ? value.memoryPort : null
}
