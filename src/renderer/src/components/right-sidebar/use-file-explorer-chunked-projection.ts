import { useEffect, useLayoutEffect, useState } from 'react'
import {
  createNameFilteredFileExplorerProjection,
  createNameFilteredFileExplorerProjectionInChunks,
  getFileExplorerNameFilterProjectionCacheKey,
  shouldBuildNameFilterProjectionInChunks,
  type FileExplorerNameFilterProjectionSource
} from './file-explorer-name-filter-projection'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import {
  markRendererPathSearchProjectionReady,
  recordRendererPathSearchDuration,
  recordRendererPathSearchProjectionChunk
} from './file-explorer-name-filter-timing'

type NameFilteredProjectionArgs = Parameters<typeof createNameFilteredFileExplorerProjection>[0]

/** Chunked (or synchronous) name-filter projection state for the File Explorer tree. */
export function useFileExplorerChunkedProjection(args: {
  nameFilter: FileExplorerNameFilterProjectionSource | null
  projectionArgs: NameFilteredProjectionArgs | null
  projectionContextKey: string
}): {
  filteredProjection: FileExplorerRowProjection | null
  projectionPending: boolean
  projectionError: 'budget' | 'failed' | null
} {
  const { nameFilter, projectionArgs, projectionContextKey } = args
  const needsChunkedProjection = shouldBuildNameFilterProjectionInChunks(
    nameFilter?.relativePaths ?? null
  )
  const projectionJobKey = projectionArgs
    ? getFileExplorerNameFilterProjectionCacheKey(projectionArgs)
    : null
  const [chunkedProjection, setChunkedProjection] = useState<{
    key: string
    contextKey: string
    projection: FileExplorerRowProjection
  } | null>(null)
  const [projectionError, setProjectionError] = useState<'budget' | 'failed' | null>(null)
  const [projectionErrorKey, setProjectionErrorKey] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (!projectionArgs || needsChunkedProjection || !projectionJobKey) {
      return
    }
    const startedAt = performance.now()
    const projection = createNameFilteredFileExplorerProjection(projectionArgs)
    if (nameFilter?.correlationId) {
      recordRendererPathSearchDuration(
        nameFilter.correlationId,
        'projection',
        Math.max(0, performance.now() - startedAt)
      )
      markRendererPathSearchProjectionReady(nameFilter.correlationId)
    }
    setChunkedProjection((current) =>
      current !== null &&
      current.key === projectionJobKey &&
      current.contextKey === projectionContextKey &&
      current.projection === projection
        ? current
        : { key: projectionJobKey, contextKey: projectionContextKey, projection }
    )
  }, [
    nameFilter?.correlationId,
    needsChunkedProjection,
    projectionArgs,
    projectionContextKey,
    projectionJobKey
  ])
  useEffect(() => {
    if (!projectionArgs) {
      setChunkedProjection(null)
      setProjectionError(null)
      setProjectionErrorKey(null)
      return
    }
    if (!needsChunkedProjection || !projectionJobKey) {
      setProjectionError(null)
      setProjectionErrorKey(null)
      return
    }
    const controller = new AbortController()
    const startedAt = performance.now()
    setProjectionError(null)
    setProjectionErrorKey(null)
    void createNameFilteredFileExplorerProjectionInChunks({
      ...projectionArgs,
      signal: controller.signal,
      onChunkDuration: (milliseconds) => {
        if (nameFilter?.correlationId) {
          recordRendererPathSearchProjectionChunk(nameFilter.correlationId, milliseconds)
        }
      }
    })
      .then((projection) => {
        if (controller.signal.aborted) {
          return
        }
        if (nameFilter?.correlationId) {
          recordRendererPathSearchDuration(
            nameFilter.correlationId,
            'projection',
            Math.max(0, performance.now() - startedAt)
          )
          markRendererPathSearchProjectionReady(nameFilter.correlationId)
        }
        setChunkedProjection((current) =>
          current !== null &&
          current.key === projectionJobKey &&
          current.contextKey === projectionContextKey &&
          current.projection === projection
            ? current
            : { key: projectionJobKey, contextKey: projectionContextKey, projection }
        )
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          setProjectionError(
            error instanceof Error && error.message.includes('projection byte budget')
              ? 'budget'
              : 'failed'
          )
          setProjectionErrorKey(projectionJobKey)
        }
      })
    return () => controller.abort()
  }, [
    nameFilter?.correlationId,
    needsChunkedProjection,
    projectionArgs,
    projectionContextKey,
    projectionJobKey
  ])
  const currentChunkedProjection =
    projectionJobKey &&
    chunkedProjection !== null &&
    chunkedProjection.key === projectionJobKey &&
    chunkedProjection.contextKey === projectionContextKey
      ? chunkedProjection.projection
      : null
  const filteredProjection = currentChunkedProjection
  const projectionPending = Boolean(
    nameFilter &&
    needsChunkedProjection &&
    currentChunkedProjection === null &&
    projectionErrorKey !== projectionJobKey
  )
  const currentProjectionError =
    projectionJobKey && projectionErrorKey === projectionJobKey ? projectionError : null
  return {
    filteredProjection,
    projectionPending,
    projectionError: currentProjectionError
  }
}
