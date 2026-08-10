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

// Google's proto-derived status convention (google.rpc.Status): `code` is
// only populated for non-OK outcomes. Its absence, or an explicit 0, means
// the individual media item was created successfully.
function isBatchCreateSuccess(status: NewMediaItemResult['status']): boolean {
  return status.code === undefined || status.code === 0
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
          const errorText = await response.text().catch(() => `HTTP ${response.status}`)
          throw new Error(errorText || `HTTP ${response.status}`)
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

  const batchCreate = useCallback(
    async (tokens: PendingUploadToken[], albumId: string | undefined, accessToken: string) => {
      const batches = chunkArray(tokens, 50)
      for (const batch of batches) {
        const body: { uploadTokens: UploadToken[]; albumId?: string } = {
          uploadTokens: batch.map(({ token, filename }) => ({ token, filename })),
        }
        if (albumId) {
          body.albumId = albumId
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
        } catch (err) {
          markChunkFailed(batch, 'Batch create request failed')
          throw err
        }

        if (!res.ok) {
          markChunkFailed(batch, 'Batch create request failed')
          throw new Error(`Batch create failed: ${res.status}`)
        }

        const data = (await res.json()) as BatchCreateResult
        const results = data.newMediaItemResults ?? []

        setPhotoStates((prev) => {
          const next = new Map(prev)
          batch.forEach((item, index) => {
            // Results are returned in submission order WITHIN this single
            // chunk's API call — never assume a running position across
            // multiple chunks.
            const result: NewMediaItemResult | undefined = results[index]
            if (result && isBatchCreateSuccess(result.status)) {
              next.set(item.photoId, { status: 'done' })
            } else {
              next.set(item.photoId, {
                status: 'failed',
                error: result?.status?.message ?? 'Batch create did not return a result for this photo',
              })
            }
          })
          return next
        })
      }
    },
    [markChunkFailed]
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

      // Upload each photo sequentially
      const tokens: PendingUploadToken[] = []
      for (const photo of photos) {
        const result = await uploadSinglePhoto(photo, accessToken)
        if (result) {
          tokens.push(result)
        }
      }

      // Batch create
      if (tokens.length > 0) {
        try {
          await batchCreate(tokens, albumIdRef.current, accessToken)
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
      // Find failed photos
      const failedPhotos = photos.filter(
        (p) => photoStates.get(p.id)?.status === 'failed'
      )

      if (failedPhotos.length === 0) return

      setUploadState('uploading')

      // Re-upload failed photos
      const newTokens: PendingUploadToken[] = []
      for (const photo of failedPhotos) {
        const result = await uploadSinglePhoto(photo, accessToken)
        if (result) {
          newTokens.push(result)
        }
      }

      // Only batch-create the newly retried tokens — previously successful tokens
      // were already committed in the initial startUpload call
      if (newTokens.length > 0) {
        try {
          await batchCreate(newTokens, albumIdRef.current, accessToken)
        } catch {
          setUploadState('error')
          return
        }
      }

      setUploadState('done')
    },
    [photoStates, uploadSinglePhoto, batchCreate]
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
