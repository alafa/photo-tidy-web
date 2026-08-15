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
  uploadFn: (photo: PhotoEntry, accessToken: string, isCurrent: () => boolean) => Promise<T | null>,
  isCurrent: () => boolean,
): Promise<T[]> {
  const tokens: T[] = []
  for (let i = 0; i < photos.length; i += UPLOAD_CONCURRENCY) {
    const batch = photos.slice(i, i + UPLOAD_CONCURRENCY)
    const results = await Promise.all(batch.map((photo) => uploadFn(photo, accessToken, isCurrent)))
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
function describeUpstreamFailure(
  status: string | undefined,
  fallback: string,
  retryAfterMs?: number
): string {
  switch (status) {
    case 'RATE_LIMITED':
      return retryAfterMs !== undefined
        ? `Rate limited by Google — try again in ${Math.ceil(retryAfterMs / 1000)}s`
        : 'Rate limited by Google — try again in a moment'
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

  // Identifies which startUpload()/retryFailed() call is still "current".
  // reset() and a fresh startUpload()/retryFailed() all bump this — a
  // superseded call whose async work (e.g. a slow-to-resolve reconciliation
  // fetch) is still in flight can then tell it no longer owns photoStates
  // instead of writing a stale confirmation into whatever session runs now.
  // Mirrors importGenerationRef in hooks/useGooglePhotosPicker.ts.
  const uploadGenerationRef = useRef(0)

  const uploadSinglePhoto = useCallback(
    async (photo: PhotoEntry, accessToken: string, isCurrent: () => boolean): Promise<PendingUploadToken | null> => {
      if (isCurrent()) {
        setPhotoStates((prev) => {
          const next = new Map(prev)
          next.set(photo.id, { status: 'uploading' })
          return next
        })
      }

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
          let errorRetryAfterMs: number | undefined
          try {
            const responseBody = (await response.json()) as {
              error?: { message?: string; status?: string; retryAfterMs?: number } | string
            }
            if (typeof responseBody.error === 'string') {
              errorMessage = responseBody.error
            } else {
              errorMessage = responseBody.error?.message
              errorStatus = responseBody.error?.status
              errorRetryAfterMs = responseBody.error?.retryAfterMs
            }
          } catch {
            // Body couldn't be parsed — fall through to the generic fallback below.
          }
          throw new Error(
            describeUpstreamFailure(errorStatus, errorMessage || `HTTP ${response.status}`, errorRetryAfterMs)
          )
        }

        const uploadToken = await response.text()

        // Raw bytes are uploaded, but the media item does not exist in
        // Google Photos yet — batch-create still has to succeed for this
        // specific photo. Stay 'uploading' until that resolves.
        return { photoId: photo.id, token: uploadToken, filename: photo.filename }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        if (isCurrent()) {
          setPhotoStates((prev) => {
            const next = new Map(prev)
            next.set(photo.id, { status: 'failed', error: errorMessage })
            return next
          })
        }
        return null
      }
    },
    []
  )

  // Marks every photo submitted in a chunk as 'failed' with a shared
  // message. Used when the batch-create call for that chunk fails outright
  // (network error or non-2xx), so no row is left stuck 'uploading'.
  const markChunkFailed = useCallback(
    (batch: PendingUploadToken[], message: string, isCurrent: () => boolean) => {
      if (!isCurrent()) return
      setPhotoStates((prev) => {
        const next = new Map(prev)
        for (const item of batch) {
          if (next.get(item.photoId)?.status === 'uploading') {
            next.set(item.photoId, { status: 'failed', error: message })
          }
        }
        return next
      })
    },
    []
  )

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
          // Client-side budget slightly above the server route's own 12s
          // upstream timeout, so the server's own timeout response has a
          // chance to arrive first. Without this, a hung fetch here leaves
          // uploadState stuck at 'uploading' forever with no error surfaced.
          signal: AbortSignal.timeout(15000),
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
  // against" edge case, the confirmed/failed status mapping, and the
  // per-item fallback below are all defined in exactly one place — both
  // callers benefit automatically. Returns whether every item in `items`
  // ended up confirmed.
  //
  // Fallback: Google's batchAddMediaItems has no partial success — if the
  // single call covering the whole chunk fails, that's uninformative about
  // WHICH item (if any) is actually the problem. Retrying the exact same
  // chunk-wide call forever would let one poisoned/stale media item id
  // permanently block every other (up to 49) healthy id in the same chunk.
  // So on a chunk-wide failure, fall back to one call per item — slower,
  // but only paid on the failure path — so a single bad id can no longer
  // hold the rest of the chunk hostage.
  const reconcileAndSetStatus = useCallback(
    async (
      items: { photoId: string; mediaItemId: string }[],
      albumId: string | undefined,
      accessToken: string,
      isCurrent: () => boolean,
    ): Promise<boolean> => {
      if (!albumId) {
        // Album creation is mandatory on every upload today, so this
        // should not happen in practice — but without an album id there
        // is nothing to confirm membership against.
        if (isCurrent()) {
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
        }
        return false
      }

      const confirmed = await reconcileAlbumMembership(
        albumId,
        items.map((i) => i.mediaItemId),
        accessToken
      )

      if (confirmed) {
        if (isCurrent()) {
          setPhotoStates((prev) => {
            const next = new Map(prev)
            for (const { photoId } of items) {
              next.set(photoId, { ...next.get(photoId), status: 'done' })
            }
            return next
          })
        }
        return true
      }

      // The chunk-wide call failed — isolate the damage by retrying each
      // item on its own. For a chunk already down to a single item this
      // just repeats the same call again; there's no smaller unit to
      // isolate, so no special-casing is needed to avoid it.
      const perItemResults = await Promise.all(
        items.map(async (item) => ({
          item,
          confirmed: await reconcileAlbumMembership(albumId, [item.mediaItemId], accessToken),
        }))
      )

      if (isCurrent()) {
        setPhotoStates((prev) => {
          const next = new Map(prev)
          for (const { item, confirmed: itemConfirmed } of perItemResults) {
            next.set(item.photoId, {
              ...next.get(item.photoId),
              ...(itemConfirmed
                ? { status: 'done' as const }
                : {
                    status: 'failed' as const,
                    error: 'Media item created but could not be confirmed in the album',
                  }),
            })
          }
          return next
        })
      }

      return perItemResults.every((r) => r.confirmed)
    },
    [reconcileAlbumMembership]
  )

  const batchCreate = useCallback(
    async (
      tokens: PendingUploadToken[],
      albumId: string | undefined,
      accessToken: string,
      isCurrent: () => boolean,
    ) => {
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
          markChunkFailed(batch, 'Batch create request failed', isCurrent)
          anyChunkFailed = true
          continue
        }

        if (!res.ok) {
          // Try to read the specific failure reason (e.g. rate-limited,
          // timed out) off the parsed error body; fall back to the
          // generic message if the body can't be parsed or names no
          // recognized status.
          let errorStatus: string | undefined
          let errorRetryAfterMs: number | undefined
          try {
            const errorBody = (await res.json()) as { error?: { status?: string; retryAfterMs?: number } }
            errorStatus = errorBody.error?.status
            errorRetryAfterMs = errorBody.error?.retryAfterMs
          } catch {
            // Body couldn't be parsed — errorStatus stays undefined, generic fallback below.
          }
          markChunkFailed(
            batch,
            describeUpstreamFailure(errorStatus, 'Batch create request failed', errorRetryAfterMs),
            isCurrent
          )
          anyChunkFailed = true
          continue
        }

        let data: BatchCreateResult
        try {
          data = (await res.json()) as BatchCreateResult
        } catch {
          markChunkFailed(batch, 'Batch create returned an invalid response', isCurrent)
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

        if (isCurrent()) {
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
        }

        // KTD2: reconcile once per batch-create chunk, immediately after
        // that chunk resolves, using only this chunk's own successful media
        // item ids — never one call across the whole run.
        if (reconcilable.length > 0) {
          const confirmed = await reconcileAndSetStatus(reconcilable, albumId, accessToken, isCurrent)
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

      // Claim this call's own generation before anything else — reset() and
      // any later startUpload()/retryFailed() call bump uploadGenerationRef,
      // which invalidates isCurrent() for every await below this point.
      const myGeneration = ++uploadGenerationRef.current
      const isCurrent = () => uploadGenerationRef.current === myGeneration

      // Initialize all photo states to pending. These, and setUploadState
      // below, run before any await — they establish this new session and
      // must always apply, so they're intentionally not isCurrent()-gated.
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
        // A concurrent reset() + fresh startUpload() may already have run
        // to completion during this await and set albumIdRef.current to its
        // OWN album id — a superseded call writing here would clobber it.
        if (!isCurrent()) return
        albumIdRef.current = albumData.id
      } catch {
        if (isCurrent()) setUploadState('error')
        return
      }

      // Capture the album id for this call locally — albumIdRef.current can
      // be cleared by a concurrent reset() (e.g. the user adding more local
      // files while this upload is still running), and re-reading the ref
      // after the upload loop would then submit batchCreate with no album,
      // silently orphaning these photos outside any album.
      const albumId = albumIdRef.current

      const tokens = await uploadWithConcurrency(photos, accessToken, uploadSinglePhoto, isCurrent)

      if (!isCurrent()) return

      // Batch create
      if (tokens.length > 0) {
        try {
          await batchCreate(tokens, albumId, accessToken, isCurrent)
        } catch {
          if (isCurrent()) setUploadState('error')
          return
        }
      }

      if (isCurrent()) setUploadState('done')
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

      // Claim this call's own generation — see startUpload for why. Kept
      // below the noop checks above, mirroring startImport() in
      // useGooglePhotosPicker.ts: a call that's about to no-op shouldn't
      // consume/invalidate a generation.
      const myGeneration = ++uploadGenerationRef.current
      const isCurrent = () => uploadGenerationRef.current === myGeneration

      // Runs before any await — establishes this new session, so it's
      // intentionally not isCurrent()-gated (same discipline as startUpload).
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
          if (!isCurrent()) return
          const items = chunk.map((p) => ({
            photoId: p.id,
            mediaItemId: photoStates.get(p.id)!.mediaItemId!,
          }))
          const confirmed = await reconcileAndSetStatus(items, albumId, accessToken, isCurrent)
          if (!confirmed) anyFailure = true
        }
      }

      if (!isCurrent()) return

      if (fullRetryPhotos.length > 0) {
        // Re-upload photos whose media item was never created, then
        // batch-create (which performs its own reconciliation per chunk) —
        // the existing full pipeline, unchanged.
        const newTokens = await uploadWithConcurrency(fullRetryPhotos, accessToken, uploadSinglePhoto, isCurrent)

        if (!isCurrent()) return

        if (newTokens.length > 0) {
          try {
            await batchCreate(newTokens, albumId, accessToken, isCurrent)
          } catch {
            anyFailure = true
          }
        }
      }

      if (isCurrent()) setUploadState(anyFailure ? 'error' : 'done')
    },
    [uploadState, photoStates, uploadSinglePhoto, batchCreate, reconcileAndSetStatus]
  )

  const reset = useCallback(() => {
    // Invalidate any in-flight generation from a startUpload()/retryFailed()
    // call that's still running — its later isCurrent() checks (guarding
    // every setPhotoStates/setUploadState after an await) will now all
    // return false, so a late-resolving confirmation from the superseded
    // session can no longer land in whatever session runs next.
    uploadGenerationRef.current += 1
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
