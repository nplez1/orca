import type { TransferListItem } from 'node:worker_threads'
import type { WorkspacePathIndexWorkerRequest } from './workspace-path-index-worker-protocol'

/** Transferable buffer view of a request's backing arrays, deduplicated for postMessage. */
export function workerTransferList(request: WorkspacePathIndexWorkerRequest): TransferListItem[] {
  if (request.type === 'path-batch') {
    return [request.pathsBytes, ...[request.pathOffsets.buffer].filter(isArrayBuffer)]
  }
  if (request.type !== 'install') {
    return []
  }
  const { catalog } = request.generation
  const buffers: ArrayBuffer[] = [
    catalog.originalOffsets.buffer,
    catalog.foldedOffsets.buffer,
    catalog.naturalOrder.buffer,
    catalog.flags.buffer
  ].filter(isArrayBuffer)
  if (catalog.storageKind !== 'prefix-compressed' && catalog.storageKind !== 'disk-spilled') {
    buffers.push(...[catalog.originalUtf8.buffer].filter(isArrayBuffer))
  } else if (catalog.storageKind === 'prefix-compressed') {
    buffers.push(
      ...[
        catalog.originalBlockData.buffer,
        catalog.originalBlockOffsets.buffer,
        catalog.originalBlockChecksums.buffer,
        catalog.foldedBlockData.buffer,
        catalog.foldedBlockOffsets.buffer,
        catalog.foldedBlockChecksums.buffer,
        catalog.rankBlockOffsets.buffer,
        catalog.naturalRanks.buffer
      ].filter(isArrayBuffer)
    )
  }
  if (
    catalog.storageKind === 'packed-folded' &&
    catalog.foldedCodeUnits.buffer instanceof ArrayBuffer
  ) {
    buffers.push(catalog.foldedCodeUnits.buffer)
  }
  if (catalog.trigramPostings) {
    buffers.push(
      ...[
        catalog.trigramPostings.gramCodeUnits.buffer,
        catalog.trigramPostings.postingOffsets.buffer,
        catalog.trigramPostings.postingCounts.buffer,
        catalog.trigramPostings.encodedPostingRanks.buffer
      ].filter(isArrayBuffer)
    )
  }
  const overlay = request.generation.overlay
  if (overlay) {
    buffers.push(
      ...[
        overlay.baseFlagAdditions.buffer,
        overlay.baseFlagReplacements.buffer,
        overlay.baseFlagReplacementKnown.buffer,
        overlay.baseTombstones.buffer
      ].filter(isArrayBuffer)
    )
  }
  return [...new Set(buffers)]
}

export function packPathBatch(paths: readonly string[]): {
  bytes: ArrayBuffer
  offsets: Uint32Array
} {
  const encodedPaths = paths.map((path) => new TextEncoder().encode(path))
  const offsets = new Uint32Array(paths.length + 1)
  let totalBytes = 0
  for (let index = 0; index < encodedPaths.length; index += 1) {
    offsets[index] = totalBytes
    totalBytes += encodedPaths[index]?.byteLength ?? 0
  }
  offsets[paths.length] = totalBytes
  const bytes = new Uint8Array(totalBytes)
  for (let index = 0; index < encodedPaths.length; index += 1) {
    const start = offsets[index] ?? 0
    const encoded = encodedPaths[index]
    if (encoded) {
      bytes.set(encoded, start)
    }
  }
  return { bytes: bytes.buffer, offsets }
}

function isArrayBuffer(buffer: ArrayBufferLike): buffer is ArrayBuffer {
  return buffer instanceof ArrayBuffer
}
