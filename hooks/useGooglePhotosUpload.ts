'use client'

import { useState, useCallback, useRef } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { writeTimestamp } from '@/lib/exif-write'
import type { UploadToken, Album, BatchCreateResult, NewMediaItemResult } from '@/lib/google-photos-types'

export type UploadState = 'idle' | 'uploading' | 'done' | 'error'
export type PhotoUploadStatus = 'pending' | 'uploading' | 'done' | 'failed'

export interface PhotoUploadState {
  status: PhotoUploadStatus
  error?: string
  // Set as soon as batch-create reports item-creation success for this
  // photo — independent of whether album-membership reconciliation then
  // succeeds. Lets retryFailed tell "media item already exists, only
  // reconciliation needs redoing" apart from "never got created, redo the
  // full pipeline" (see retryFailed below).
  mediaItemId?: string
}

// An upload token carrying the id of the photo it came from, so batch-create
// results (returned per-token, in submission order) can be matched back to
// the correct photo even when some photos were skipped earlier (their raw
// upload failed, so no token exists for them at all).
interface PendingUploadToken extends UploadToken {
  photoId: string
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

// Raw-byte uploads to Google are independent per photo (batch-create matches
// results back by token, not position), so they don't need to run strictly
// sequentially. Bound the concurrency instead of firing all of them at once,
// mirroring downloadBatch's DOWNLOAD_CONCURRENCY on the symmetric picker path.
const UPLOAD_CONCURRENCY = 5

async function uploadWithConcurrency<T>(
  photos: PhotoEntry[],
  accessToken: string,
  uploadFn: (photo: PhotoEntry, accessToken: string) => Promise<T | null>,
): Promise<T[]> {
  const tokens: T[] = []
  for (let i = 0; i < photos.length; i += UPLOAD_CONCURRENCY) {
    const batch = photos.slice(i, i + UPLOAD_CONCURRENCY)
    const results = await Promise.all(batch.map((photo) => uploadFn(photo, accessToken)))
    for (const result of results) {
      if (result) tokens.push(result)
    }
  }
  return tokens
}

// Google's proto-derived status convention (google.rpc.Status): `code` is
// only populated for non-OK outcomes. Its absence, or an explicit 0, means
// the individual media item was created successfully.
function isBatchCreateSuccess(status: NewMediaItemResult['status']): boolean {
  return status.code === undefined || status.code === 0
}

// Maps the `error.status` value from the API routes' upstreamErrorBody
// convention (lib/google-photos-server.ts) to a message that names the
// specific failure mode. Any other status value, or a status that couldn't
// be determined at all (unparseable body, older error shape), falls back
// to the caller-supplied generic message — no regression for other
// failure shapes.
function describeUpstreamFailure(status: string | undefined, fallback: string): string {
  switch (status) {
    case 'RATE_LIMITED':
      return 'Rate limited by Google — try again in a moment'
    case 'REQUEST_TIMEOUT':
      return 'Request to Google Photos timed out'
    default:
      return fallback
  }
}

export function useGooglePhotosUpload() {
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [photoStates, setPhotoStates] = useState<Map<string, PhotoUploadState>>(new Map())

  // Store albumId across startUpload/retryFailed calls
  const albumIdRef = useRef<string | undefined>(undefined)

  const uploadSinglePhoto = useCallback(
    async (photo: PhotoEntry, accessToken: string): Promise<PendingUploadToken | null> => {
      setPhotoStates((prev) => {
        const next = new Map(prev)
        next.set(photo.id, { status: 'uploading' })
        return next
      })

      try {
        const modifiedBlob = await writeTimestamp(photo.file, photo.capturedAt ?? new Date())
        const arrayBuffer = await modifiedBlob.arrayBuffer()

        const response = await fetch('/api/google-photos/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Goog-Upload-Content-Type': photo.file.type || 'image/jpeg',
            'X-Goog-Upload-Filename': photo.filename,
          },
          body: arrayBuffer,
        })

        if (!response.ok) {
          let errorMessage: string | undefined
          let errorStatus: string | undefined
          try {
            const responseBody = (await response.json()) as {
              error?: { message?: string; status?: string } | string
            }
            if (typeof responseBody.error === 'string') {
              errorMessage = responseBody.error
            } else {
              errorMessage = responseBody.error?.message
              errorStatus = responseBody.error?.status
            }
          } catch {
            // Body couldn't be parsed — fall through to the generic fallback below.
          }
          throw new Error(describeUpstreamFailure(errorStatus, errorMessage || `HTTP ${response.status}`))
        }

        const uploadToken = await response.text()

        // Raw bytes are uploaded, but the media item does not exist in
        // Google Photos yet — batch-create still has to succeed for this
        // specific photo. Stay 'uploading' until that resolves.
        return { photoId: photo.id, token: uploadToken, filename: photo.filename }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        setPhotoStates((prev) => {
          const next = new Map(prev)
          next.set(photo.id, { status: 'failed', error: errorMessage })
          return next
        })
        return null
      }
    },
    []
  )

  // Marks every photo submitted in a chunk as 'failed' with a shared
  // message. Used when the batch-create call for that chunk fails outright
  // (network error or non-2xx), so no row is left stuck 'uploading'.
  const markChunkFailed = useCallback((batch: PendingUploadToken[], message: string) => {
    setPhotoStates((prev) => {
      const next = new Map(prev)
      for (const item of batch) {
        if (next.get(item.photoId)?.status === 'uploading') {
          next.set(item.photoId, { status: 'failed', error: message })
        }
      }
      return next
    })
  }, [])

  // Reconciles album membership for a set of already-created media items.
  // This is the SOLE mechanism that ever adds an item to an album — the
  // batch-create route no longer sends albumId to Google, since batchCreate's
  // response only reports media-item-creation status, never album-attachment
  // status (see KTD1). Returns true only on a confirmed 2xx from the
  // reconciliation route; any non-2xx or thrown network error resolves to
  // false rather than throwing, so callers can decide per-photo fallout
  // without wrapping every call site in its own try/catch.
  const reconcileAlbumMembership = useCallback(
    async (albumId: string, mediaItemIds: string[], accessToken: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/google-photos/albums/${encodeURIComponent(albumId)}/batch-add`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ mediaItemIds }),
        })
        return res.ok
      } catch {
        return false
      }
    },
    []
  )

  // Reconciles a set of photos already known to have a mediaItemId, and
  // updates their status to 'done' or 'failed' based on the result. Shared
  // between batchCreate's per-chunk reconciliation and retryFailed's
  // reconciliation-only retry path, so the "no album to confirm membership
  // against" edge case and the confirmed/failed status mapping are defined
  // in exactly one place. Returns whether reconciliation was confirmed.
  const reconcileAndSetStatus = useCallback(
    async (
      items: { photoId: string; mediaItemId: string }[],
      albumId: string | undefined,
      accessToken: string,
    ): Promise<boolean> => {
      if (!albumId) {
        // Album creation is mandatory on every upload today, so this
        // should not happen in practice — but without an album id there
        // is nothing to confirm membership against.
        setPhotoStates((prev) => {
          const next = new Map(prev)
          for (const { photoId } of items) {
            next.set(photoId, {
              ...next.get(photoId),
              status: 'failed',
              error: 'No album to confirm membership against',
            })
          }
          return next
        })
        return false
      }

      const confirmed = await reconcileAlbumMembership(
        albumId,
        items.map((i) => i.mediaItemId),
        accessToken
      )
      setPhotoStates((prev) => {
        const next = new Map(prev)
        for (const { photoId } of items) {
          if (confirmed) {
            next.set(photoId, { ...next.get(photoId), status: 'done' })
          } else {
            next.set(photoId, {
              ...next.get(photoId),
              status: 'failed',
              error: 'Media item created but could not be confirmed in the album',
            })
          }
        }
        return next
      })
      return confirmed
    },
    [reconcileAlbumMembership]
  )

  const batchCreate = useCallback(
    async (tokens: PendingUploadToken[], albumId: string | undefined, accessToken: string) => {
      const batches = chunkArray(tokens, 50)
      let anyChunkFailed = false

      for (const batch of batches) {
        // Album membership is deliberately NOT requested here (see
        // reconcileAlbumMembership above) — this call only creates media
        // items.
        const body: { uploadTokens: UploadToken[] } = {
          uploadTokens: batch.map(({ token, filename }) => ({ token, filename })),
        }

        let res: Response
        try {
          res = await fetch('/api/google-photos/batch-create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(body),
          })
        } catch {
          // Don't abandon later chunks on one chunk's failure — mark this
          // chunk failed and keep going so the rest still get a chance.
          markChunkFailed(batch, 'Batch create request failed')
          anyChunkFailed = true
          continue
        }

        if (!res.ok) {
          // Try to read the specific failure reason (e.g. rate-limited,
          // timed out) off the parsed error body; fall back to the
          // generic message if the body can't be parsed or names no
          // recognized status.
          let errorStatus: string | undefined
          try {
            const errorBody = (await res.json()) as { error?: { status?: string } }
            errorStatus = errorBody.error?.status
          } catch {
            // Body couldn't be parsed — errorStatus stays undefined, generic fallback below.
          }
          markChunkFailed(batch, describeUpstreamFailure(errorStatus, 'Batch create request failed'))
          anyChunkFailed = true
          continue
        }

        let data: BatchCreateResult
        try {
          data = (await res.json()) as BatchCreateResult
        } catch {
          markChunkFailed(batch, 'Batch create returned an invalid response')
          anyChunkFailed = true
          continue
        }

        // Match each result back to its submitted token explicitly, rather
        // than assuming response order mirrors submission order.
        const resultsByToken = new Map(
          (data.newMediaItemResults ?? []).map((result) => [result.uploadToken, result])
        )

        // KTD3: store mediaItemId as soon as batch-create reports
        // item-creation success, regardless of whether reconciliation below
        // then succeeds. KTD9: a success status with no mediaItem.id is its
        // own distinct failure — not reconciled, no mediaItemId stored.
        //
        // This classification is computed here, from `batch` and
        // `resultsByToken` directly, rather than inside the setPhotoStates
        // updater below — a functional setState updater is not guaranteed to
        // run synchronously before the code that follows it, so collecting
        // `reconcilable` as a side effect of that updater would make the
        // reconciliation call below see it as still empty.
        const reconcilable: { photoId: string; mediaItemId: string }[] = []
        for (const item of batch) {
          const result: NewMediaItemResult | undefined = resultsByToken.get(item.token)
          if (result && isBatchCreateSuccess(result.status) && result.mediaItem?.id) {
            reconcilable.push({ photoId: item.photoId, mediaItemId: result.mediaItem.id })
          }
        }

        setPhotoStates((prev) => {
          const next = new Map(prev)
          for (const item of batch) {
            const result: NewMediaItemResult | undefined = resultsByToken.get(item.token)
            if (result && isBatchCreateSuccess(result.status)) {
              if (result.mediaItem?.id) {
                next.set(item.photoId, { status: 'uploading', mediaItemId: result.mediaItem.id })
              } else {
                next.set(item.photoId, {
                  status: 'failed',
                  error: 'Google reported success but did not return a media item id',
                })
              }
            } else {
              next.set(item.photoId, {
                status: 'failed',
                error: result?.status?.message ?? 'Batch create did not return a result for this photo',
              })
            }
          }
          return next
        })

        // KTD2: reconcile once per batch-create chunk, immediately after
        // that chunk resolves, using only this chunk's own successful media
        // item ids — never one call across the whole run.
        if (reconcilable.length > 0) {
          const confirmed = await reconcileAndSetStatus(reconcilable, albumId, accessToken)
          if (!confirmed) anyChunkFailed = true
        }
      }

      if (anyChunkFailed) {
        throw new Error('One or more batch-create chunks failed')
      }
    },
    [markChunkFailed, reconcileAndSetStatus]
  )

  const startUpload = useCallback(
    async (photos: PhotoEntry[], albumName: string, accessToken: string): Promise<void> => {
      // Noop if already uploading
      if (uploadState === 'uploading') return

      // Empty photos → done immediately
      if (photos.length === 0) {
        setUploadState('done')
        return
      }

      // Initialize all photo states to pending
      const initialStates = new Map<string, PhotoUploadState>()
      for (const photo of photos) {
        initialStates.set(photo.id, { status: 'pending' })
      }
      setPhotoStates(initialStates)
      setUploadState('uploading')

      // Reset refs
      albumIdRef.current = undefined

      // Create album (mandatory for every upload)
      try {
        const albumResponse = await fetch('/api/google-photos/albums', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ title: `${albumName.trim()} (photo tidy)` }),
        })

        if (!albumResponse.ok) {
          throw new Error(`Album creation failed: HTTP ${albumResponse.status}`)
        }

        const albumData = await albumResponse.json() as Album
        albumIdRef.current = albumData.id
      } catch {
        setUploadState('error')
        return
      }

      // Capture the album id for this call locally — albumIdRef.current can
      // be cleared by a concurrent reset() (e.g. the user adding more local
      // files while this upload is still running), and re-reading the ref
      // after the upload loop would then submit batchCreate with no album,
      // silently orphaning these photos outside any album.
      const albumId = albumIdRef.current

      const tokens = await uploadWithConcurrency(photos, accessToken, uploadSinglePhoto)

      // Batch create
      if (tokens.length > 0) {
        try {
          await batchCreate(tokens, albumId, accessToken)
        } catch {
          setUploadState('error')
          return
        }
      }

      setUploadState('done')
    },
    [uploadState, uploadSinglePhoto, batchCreate]
  )

  const retryFailed = useCallback(
    async (photos: PhotoEntry[], accessToken: string): Promise<void> => {
      // Noop if already uploading — prevents a duplicate concurrent retry
      // (e.g. a rapid double-click) from creating duplicate media items.
      if (uploadState === 'uploading') return

      // Find failed photos
      const failedPhotos = photos.filter(
        (p) => photoStates.get(p.id)?.status === 'failed'
      )

      if (failedPhotos.length === 0) return

      setUploadState('uploading')

      // Capture locally for the same reason as startUpload — a concurrent
      // reset() must not be able to null out the album this retry commits to.
      const albumId = albumIdRef.current

      // KTD4: a failed photo that already has a mediaItemId had its media
      // item created successfully — only album-membership reconciliation
      // failed. Retrying it must redo ONLY that reconciliation call; running
      // the full upload-then-batch-create pipeline again would create a
      // second media item for the same photo. A photo without a mediaItemId
      // never got a media item created at all, so it still needs the full
      // pipeline, unchanged from before.
      const reconcileOnlyPhotos = failedPhotos.filter((p) => photoStates.get(p.id)?.mediaItemId)
      const fullRetryPhotos = failedPhotos.filter((p) => !photoStates.get(p.id)?.mediaItemId)

      let anyFailure = false

      if (reconcileOnlyPhotos.length > 0) {
        // Chunked the same way as batch-create (50 per call, KTD2).
        for (const chunk of chunkArray(reconcileOnlyPhotos, 50)) {
          const items = chunk.map((p) => ({
            photoId: p.id,
            mediaItemId: photoStates.get(p.id)!.mediaItemId!,
          }))
          const confirmed = await reconcileAndSetStatus(items, albumId, accessToken)
          if (!confirmed) anyFailure = true
        }
      }

      if (fullRetryPhotos.length > 0) {
        // Re-upload photos whose media item was never created, then
        // batch-create (which performs its own reconciliation per chunk) —
        // the existing full pipeline, unchanged.
        const newTokens = await uploadWithConcurrency(fullRetryPhotos, accessToken, uploadSinglePhoto)

        if (newTokens.length > 0) {
          try {
            await batchCreate(newTokens, albumId, accessToken)
          } catch {
            anyFailure = true
          }
        }
      }

      setUploadState(anyFailure ? 'error' : 'done')
    },
    [uploadState, photoStates, uploadSinglePhoto, batchCreate, reconcileAndSetStatus]
  )

  const reset = useCallback(() => {
    setUploadState('idle')
    setPhotoStates(new Map())
    albumIdRef.current = undefined
  }, [])

  return {
    uploadState,
    photoStates,
    startUpload,
    retryFailed,
    reset,
  }
}
